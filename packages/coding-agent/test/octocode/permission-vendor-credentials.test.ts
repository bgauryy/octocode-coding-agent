import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ToolCallEvent } from "../../src/core/features/index.ts";
import { Permission } from "../../src/octocode/permission/ask.ts";
import { permissionGate } from "../../src/octocode/permission/gate.ts";
import { credentialHit } from "../../src/octocode/permission/credential-store.ts";
import { shellParserReady } from "../../src/octocode/permission/shell/mutation.ts";
import { PERMISSION_ENV } from "@octocodeai/octocode-common/env";
import { fakeCtx, fakeHost } from "./fake-host.ts";
import { tmp } from "./helpers.ts";

/** Synthetic stores in a temp home only: no test reads a real credential file. */
const call = (toolName: string, input: Record<string, unknown>) =>
	({ type: "tool_call", toolCallId: "t1", toolName, input }) as ToolCallEvent;
const CLAUDE_GRANT = "Allow reads of Claude Code's credential store for this session";

const saved = { ...process.env };
let home: string;

beforeEach(() => {
	home = fs.realpathSync(tmp("octocode-vendor-cred-"));
	for (const name of ["OCTOCODE_CODING_AGENT_DIR", "OCTOCODE_HOME", "CLAUDE_CONFIG_DIR", "CODEX_HOME", "XDG_DATA_HOME"])
		delete process.env[name];
	process.env.HOME = home;
	process.env.USERPROFILE = home;
	const write = (file: string, text = '{"token":"synthetic-not-real"}') => {
		fs.mkdirSync(path.dirname(path.join(home, file)), { recursive: true });
		fs.writeFileSync(path.join(home, file), text);
	};
	write(".claude/.credentials.json");
	write(".claude/settings.json", "{}");
	write(".codex/auth.json");
	write(".local/share/opencode/auth.json");
	write(".copilot/config.json");
	write(".gemini/oauth_creds.json");
	write(".octocode/octocodecode/auth.json");
});

afterEach(() => {
	for (const name of Object.keys(process.env)) if (!(name in saved)) delete process.env[name];
	Object.assign(process.env, saved);
});

function setup(mode: "manual" | "workspace" | "full", answers: Array<string | undefined> = []) {
	const cwd = tmp();
	fs.mkdirSync(path.join(cwd, ".git"));
	const fake = fakeHost();
	const permission = new Permission({ api: fake.api, env: { [PERMISSION_ENV]: mode }, isSubagent: false });
	const ctx = fakeCtx({ cwd, hasUI: true });
	const asked: Array<{ title: string; choices: string[] }> = [];
	Object.assign(ctx.ui, {
		select: async (title: string, choices: string[]) => {
			asked.push({ title, choices });
			return answers.shift();
		},
	});
	permission.start(ctx);
	const gate = permissionGate({ permission, provenance: { check: () => undefined }, powershell: async () => false });
	return { cwd, ctx, gate, asked, permission };
}

describe("vendor credential stores are classified", () => {
	it.each([
		["cat ~/.claude/.credentials.json", "claude-code"],
		['jq . "$HOME/.claude/.credentials.json"', "claude-code"],
		["ls ~/.claude", "claude-code"],
		["cat ~/.codex/auth.json", "codex"],
		["cat $CODEX_HOME/auth.json", "codex"],
		["cat ~/.local/share/opencode/auth.json", "opencode"],
		["cat ${XDG_DATA_HOME}/opencode/auth.json", "opencode"],
		["rg token ~/.copilot", "copilot"],
		["cat ~/.copilot/config.json", "copilot"],
		["cat ~/.gemini/oauth_creds.json", "gemini"],
		["ls ~/.gemini", "gemini"],
		["opencode auth export", "opencode"],
		["cd /tmp && /usr/local/bin/opencode auth export > out.json", "opencode"],
	])("%s reads %s's store", (command, store) => {
		expect(credentialHit("bash", { command }, tmp())?.store?.id).toBe(store);
	});

	it("follows CODEX_HOME and CLAUDE_CONFIG_DIR to the store they name", () => {
		const codex = path.join(home, "elsewhere-codex");
		const claude = path.join(home, "elsewhere-claude");
		process.env.CODEX_HOME = codex;
		process.env.CLAUDE_CONFIG_DIR = claude;
		expect(credentialHit("bash", { command: `cat ${codex}/auth.json` }, tmp())?.store?.id).toBe("codex");
		expect(credentialHit("bash", { command: `cat ${claude}/.credentials.json` }, tmp())?.store?.id).toBe("claude-code");
		expect(credentialHit("bash", { command: "cat ~/.codex/auth.json" }, tmp())?.store?.id).toBe("codex");
	});

	it("an MCP reader naming a vendor store is a vendor read", () => {
		const file = path.join(home, ".claude", ".credentials.json");
		expect(credentialHit("mcp__octocode__localFetch", { queries: [{ path: file }] }, tmp())?.store?.id).toBe(
			"claude-code",
		);
	});

	it.each([
		"octocode auth print-api-key --provider openai",
		"npx octocode auth print-bearer-token --provider openai-codex",
		"cat ~/.octocode/octocodecode/auth.json",
	])("%s is a read of Octocode's own store", (command) => {
		const hit = credentialHit("bash", { command }, tmp());
		expect(hit).toBeDefined();
		expect(hit?.store).toBeUndefined();
	});

	it.each(["cat ~/.claude/settings.json", "octocode auth check", "opencode auth list", "rg export-auth src/"])(
		"%s reads no store",
		(command) => {
			expect(credentialHit("bash", { command }, tmp())).toBeUndefined();
		},
	);
});

describe("vendor credential reads in each mode", () => {
	it.each(["manual", "workspace"] as const)("%s mode asks with no session answer", async (mode) => {
		await shellParserReady();
		const { gate, ctx, asked } = setup(mode, ["Deny"]);
		const result = await gate(call("bash", { command: "cat ~/.claude/.credentials.json" }), ctx);
		expect(result?.block).toBe(true);
		expect(asked).toHaveLength(1);
		expect(asked[0].choices).not.toContain(CLAUDE_GRANT);
	});

	it("workspace mode asks for `octocode auth print-api-key`", async () => {
		await shellParserReady();
		const { gate, ctx, asked } = setup("workspace", ["Deny"]);
		await gate(call("bash", { command: "octocode auth print-api-key --provider openai" }), ctx);
		expect(asked).toHaveLength(1);
	});

	it("full mode asks once per store: the session answer covers later reads of that store only", async () => {
		await shellParserReady();
		const { gate, ctx, asked, permission } = setup("full", [CLAUDE_GRANT, "Deny"]);
		expect(await gate(call("bash", { command: "cat ~/.claude/.credentials.json" }), ctx)).toBeUndefined();
		expect(asked).toHaveLength(1);
		expect(asked[0].choices).toContain(CLAUDE_GRANT);
		expect(permission.grants()).toContain("credential.vendor: reads of Claude Code's credential store");
		expect(await gate(call("bash", { command: "jq . ~/.claude/.credentials.json" }), ctx)).toBeUndefined();
		expect(asked).toHaveLength(1);
		const codex = await gate(call("bash", { command: "cat ~/.codex/auth.json" }), ctx);
		expect(codex?.block).toBe(true);
		expect(asked).toHaveLength(2);
	});

	it("full mode asks for `opencode auth export`", async () => {
		await shellParserReady();
		const { gate, ctx, asked } = setup("full", ["Deny"]);
		expect((await gate(call("bash", { command: "opencode auth export" }), ctx))?.block).toBe(true);
		expect(asked).toHaveLength(1);
	});

	it("full mode still runs Octocode's own store reads and `octocode auth print-*` without asking", async () => {
		await shellParserReady();
		const { gate, ctx, asked } = setup("full");
		for (const command of [
			"cat ~/.octocode/octocodecode/auth.json",
			"octocode auth print-api-key --provider openai",
			"octocode auth print-bearer-token --provider openai-codex",
			"cat ~/.claude/settings.json",
		])
			expect(await gate(call("bash", { command }), ctx), command).toBeUndefined();
		expect(asked).toEqual([]);
	});
});

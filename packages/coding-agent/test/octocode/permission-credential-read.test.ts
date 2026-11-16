import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ToolCallEvent } from "../../src/core/features/index.ts";
import { Permission } from "../../src/octocode/permission/ask.ts";
import { permissionGate } from "../../src/octocode/permission/gate.ts";
import { credentialRead } from "../../src/octocode/permission/credential-store.ts";
import { stateFolderRefusal } from "../../src/octocode/permission/file-access.ts";
import { planReadOnly } from "../../src/octocode/permission/shell/plan-reads.ts";
import { shellParserReady } from "../../src/octocode/permission/shell/mutation.ts";
import { planningRefusal } from "../../src/octocode/plan/gate.ts";
import { PERMISSION_ENV } from "@octocodeai/octocode-common/env";
import { fakeCtx, fakeHost } from "./fake-host.ts";
import { tmp } from "./helpers.ts";

/** Synthetic files in a temp home only: no test reads a real credential file. */
const KEY = "sk-synthetic-not-a-real-key";
const call = (toolName: string, input: Record<string, unknown>) =>
	({ type: "tool_call", toolCallId: "t1", toolName, input }) as ToolCallEvent;

const saved = { ...process.env };
let home: string;
let store: string;
let storeDir: string;

beforeEach(() => {
	home = fs.realpathSync(tmp("octocode-cred-"));
	delete process.env.OCTOCODE_CODING_AGENT_DIR;
	delete process.env.OCTOCODE_HOME;
	process.env.HOME = home;
	process.env.USERPROFILE = home;
	storeDir = path.join(home, ".octocode", "octocodecode");
	fs.mkdirSync(storeDir, { recursive: true });
	store = path.join(storeDir, "auth.json");
	fs.writeFileSync(store, JSON.stringify({ openai: { type: "api_key", key: KEY } }));
	fs.writeFileSync(path.join(storeDir, "settings.json"), "{}");
});

afterEach(() => {
	for (const name of Object.keys(process.env)) if (!(name in saved)) delete process.env[name];
	Object.assign(process.env, saved);
});

function setup(mode: "manual" | "workspace" | "full") {
	const cwd = tmp();
	fs.mkdirSync(path.join(cwd, ".git"));
	fs.writeFileSync(path.join(cwd, "notes.txt"), "hello");
	const fake = fakeHost();
	const permission = new Permission({ api: fake.api, env: { [PERMISSION_ENV]: mode }, isSubagent: false });
	const ctx = fakeCtx({ cwd, hasUI: true, ui: { selects: ["Deny", "Deny", "Deny", "Deny"] } });
	permission.start(ctx);
	const asked: string[] = [];
	const select = ctx.ui.select;
	ctx.ui.select = async (title: string, choices: string[]) => {
		asked.push(title);
		return select(title, choices);
	};
	const gate = permissionGate({ permission, provenance: { check: () => undefined }, powershell: async () => false });
	return { cwd, ctx, gate, asked };
}

/** Each way an agent can read the store, as a tool call. */
const routes: Array<[string, string, () => Record<string, unknown>]> = (() => {
	const rows = (): Array<[string, string, Record<string, unknown>]> => [
		["bash cat of the absolute path", "bash", { command: `cat ${store}` }],
		["bash cat through ~", "bash", { command: "cat ~/.octocode/octocodecode/auth.json" }],
		["bash cat through $HOME", "bash", { command: 'cat "$HOME/.octocode/octocodecode/auth.json"' }],
		["bash rg over the file", "bash", { command: `rg key ${store}` }],
		["bash rg over the folder", "bash", { command: `rg -n apiKey ${storeDir}` }],
		["bash cd into the folder", "bash", { command: `cd ${storeDir} && cat auth.json` }],
		["bash inside bash -c", "bash", { command: `bash -c 'jq . ${store}'` }],
		["macOS keychain read", "bash", { command: "security find-generic-password -s octocode -a openai -w" }],
		["keychain read by its path", "bash", { command: "/usr/bin/security find-generic-password -a openai -w" }],
		["secret-tool lookup", "bash", { command: "secret-tool lookup service octocode account openai" }],
		["powershell Get-Content", "powershell", { command: `Get-Content ${store}` }],
		["research file fetch", "mcp__octocode__localFetch", { queries: [{ path: store }] }],
		[
			"research search of the folder",
			"mcp__octocode__localSearch",
			{ queries: [{ path: storeDir, matchString: ["key"] }] },
		],
		[
			"research fetch through ~",
			"mcp__octocode__localFetch",
			{ queries: [{ path: "~/.octocode/octocodecode/auth.json" }] },
		],
		["another server's reader", "mcp__files__read_file", { path: store }],
	];
	// The paths exist only once a test has made its home: each row builds its input then.
	return rows().map(([name, tool], at): [string, string, () => Record<string, unknown>] => [
		name,
		tool,
		() => rows()[at][2],
	]);
})();

describe("credential store reads", () => {
	it.each(routes)("workspace mode asks: %s", async (_name, tool, build) => {
		const input = build();
		await shellParserReady();
		const { gate, ctx, asked } = setup("workspace");
		const result = await gate(call(tool, input), ctx);
		expect(asked).toHaveLength(1);
		expect(asked[0]).toBeTruthy();
		expect(result?.block).toBe(true);
	});

	it.each(routes)("manual mode asks: %s", async (_name, tool, build) => {
		const input = build();
		await shellParserReady();
		const { gate, ctx, asked } = setup("manual");
		await gate(call(tool, input), ctx);
		expect(asked).toHaveLength(1);
	});

	it.each(routes)("full mode runs: %s", async (_name, tool, build) => {
		const input = build();
		await shellParserReady();
		const { gate, ctx, asked } = setup("full");
		const result = await gate(call(tool, input), ctx);
		expect(asked).toEqual([]);
		expect(result).toBeUndefined();
	});

	it("says why it asks and shows the call", async () => {
		await shellParserReady();
		const { gate, ctx, asked } = setup("workspace");
		await gate(call("bash", { command: `cat ${store}` }), ctx);
		expect(asked[0]).toContain("auth.json");
	});

	it("an ordinary read in the same folder tree is unaffected", async () => {
		await shellParserReady();
		for (const mode of ["workspace", "full"] as const) {
			const { gate, ctx, asked, cwd } = setup(mode);
			const other = path.join(storeDir, "settings.json");
			for (const [tool, input] of [
				["bash", { command: "cat notes.txt" }],
				["bash", { command: `cat ${path.join(cwd, "notes.txt")} | wc -l` }],
				["bash", { command: `cat ${other}` }],
				["bash", { command: "security list-keychains" }],
				["bash", { command: "rg find-generic-password packages/security/" }],
				["bash", { command: `cat ${path.join(cwd, "auth.json")}` }],
				["mcp__octocode__localFetch", { queries: [{ path: other }] }],
			] as Array<[string, Record<string, unknown>]>) {
				await gate(call(tool, input), ctx);
				expect(asked, `${mode}: ${JSON.stringify(input)}`).toEqual([]);
			}
		}
	});

	it("a symlink in the workspace to the store counts as the store", async () => {
		await shellParserReady();
		const { gate, ctx, asked, cwd } = setup("workspace");
		fs.symlinkSync(store, path.join(cwd, "link.json"));
		await gate(call("mcp__octocode__localFetch", { queries: [{ path: "link.json" }] }), ctx);
		expect(asked).toHaveLength(1);
	});

	it("reads Pi's auth.json when Pi's folders are the fallback", () => {
		const pi = path.join(home, ".pi", "agent");
		fs.mkdirSync(pi, { recursive: true });
		fs.writeFileSync(path.join(pi, "auth.json"), "{}");
		const cwd = tmp();
		expect(credentialRead("bash", { command: `cat ${path.join(pi, "auth.json")}` }, cwd)).toBeDefined();
		expect(credentialRead("bash", { command: "cat ~/.pi/agent/auth.json" }, cwd)).toBeDefined();
		expect(credentialRead("mcp__octocode__localSearch", { queries: [{ path: "~/.pi" }] }, cwd)).toBeDefined();
		process.env.OCTOCODE_HOME = path.join(home, "elsewhere");
		expect(credentialRead("bash", { command: `cat ${path.join(pi, "auth.json")}` }, cwd)).toBeUndefined();
	});

	it("follows an explicit agent directory", () => {
		const agent = path.join(home, "agent-dir");
		fs.mkdirSync(agent);
		process.env.OCTOCODE_CODING_AGENT_DIR = agent;
		expect(credentialRead("bash", { command: `cat ${agent}/auth.json` }, tmp())).toBeDefined();
		expect(credentialRead("bash", { command: "cat auth.json" }, agent)).toBeDefined();
		// MCP OAuth tokens sit beside the provider keys.
		expect(credentialRead("bash", { command: `cat ${agent}/mcp-auth.json` }, tmp())).toBeDefined();
		expect(credentialRead("bash", { command: "cat mcp-auth.json" }, agent)).toBeDefined();
		expect(credentialRead("bash", { command: "cat ~/$X/mcp-auth.json" }, tmp())).toBe("mcp-auth.json");
	});

	it("asks in plan mode too: planning lets a read-only command run, the permission step still asks", async () => {
		await shellParserReady();
		const command = `cat ${store}`;
		const native = { name: "bash", sourceInfo: { path: "<inline:octocode>", owner: "native" } } as never;
		expect(planningRefusal({ toolName: "bash", input: { command } }, native, [], planReadOnly)).toBeUndefined();
		const { gate, ctx, asked } = setup("workspace");
		await gate(call("bash", { command }), ctx);
		expect(asked).toHaveLength(1);
	});
});

describe("credential store writes", () => {
	it("stay refused in every mode, as before", async () => {
		await shellParserReady();
		expect(stateFolderRefusal(store, store, "file")).toContain("state folder");
		for (const mode of ["manual", "workspace", "full"] as const) {
			const { gate, ctx, asked } = setup(mode);
			const result = await gate(call("bash", { command: `echo {} > ${store}` }), ctx);
			expect(result?.block, mode).toBe(true);
			expect(result?.reason).toContain("state folder");
			expect(asked, mode).toEqual([]);
		}
		expect(fs.readFileSync(store, "utf8")).toContain(KEY);
	});
});

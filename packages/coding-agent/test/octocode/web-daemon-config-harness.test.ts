import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { HarnessListSchema, type HarnessList } from "@octocodeai/octocode-contracts/config";
import { Value } from "typebox/value";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ConfigAuditEntry } from "../../../db/src/api.ts";
import { ConfigWriteError } from "../../src/octocode/web-daemon/config-write.ts";
import { listHarness, switchHarness } from "../../src/octocode/web-daemon/harness-config.ts";
import { startDaemonServer, type DaemonServer } from "../../src/octocode/web-daemon/server.ts";
import { isolatedEnv } from "./web-daemon-fixture.ts";
import { approveFixtureMcp } from "./guard-helpers.ts";

let root: string;
let home: string;
let agentDir: string;
const cleanup: Array<() => Promise<void> | void> = [];
const audits: ConfigAuditEntry[] = [];

const write = (file: string, text: string) => {
	fs.mkdirSync(path.dirname(file), { recursive: true });
	fs.writeFileSync(file, text);
};
const options = () => ({ agentDir, home, actor: "web:test", audit: (entry: ConfigAuditEntry) => audits.push(entry) });
const row = (list: HarnessList, id: string) => list.rows.find((entry) => entry.id === id);

beforeEach(() => {
	root = fs.mkdtempSync(path.join(os.tmpdir(), "octocode-config-harness-"));
	home = path.join(root, "user");
	agentDir = path.join(home, ".octocode", "octocodecode");
	fs.mkdirSync(agentDir, { recursive: true });
	vi.stubEnv("HOME", home);
	vi.stubEnv("OCTOCODE_HOME", agentDir);
	write(
		path.join(home, ".claude", "skills", "claude-demo", "SKILL.md"),
		"---\nname: claude-demo\ndescription: A Claude Code skill.\n---\nBody\n",
	);
	write(path.join(home, ".claude.json"), JSON.stringify({ mcpServers: { "claude-mcp": { command: "node" } } }));
	audits.length = 0;
});
afterEach(async () => {
	vi.unstubAllEnvs();
	for (const fn of cleanup.splice(0).reverse()) await fn();
	fs.rmSync(root, { recursive: true, force: true });
});

describe("Harness panel rows", () => {
	it("lists the /harness switches and adds Claude Code's skills and servers once its harness is switched on", async () => {
		const before = await listHarness({ agentDir, home });
		expect(Value.Check(HarnessListSchema, before)).toBe(true);
		expect(row(before, "harness:claude")).toMatchObject({ kind: "harness", on: false, setBy: "default" });
		expect(before.rows.some((entry) => entry.label === "claude-demo")).toBe(false);
		expect(row(before, "mcp:claude-mcp")).toBeUndefined();
		const claudeFile = fs.readFileSync(path.join(home, ".claude.json"), "utf8");

		approveFixtureMcp(root, agentDir);
		const after = await switchHarness({ id: "harness:claude", on: true, scope: "global" }, options());
		expect(Value.Check(HarnessListSchema, after)).toBe(true);
		expect(row(after, "harness:claude")).toMatchObject({ on: true, setBy: "global" });
		expect(after.message).toBeTruthy();
		expect(after.rows.find((entry) => entry.label === "claude-demo")).toMatchObject({ kind: "skill", on: true });
		expect(row(after, "mcp:claude-mcp")).toMatchObject({ kind: "mcp", on: true });
		const settings = JSON.parse(fs.readFileSync(path.join(agentDir, "settings.json"), "utf8"));
		expect(settings.toggles).toEqual({ "harness:claude": true });

		const off = await switchHarness({ id: "mcp:claude-mcp", on: false, scope: "global" }, options());
		expect(row(off, "mcp:claude-mcp")?.on).toBe(false);
		// Another tool's file is never written; the switch lives in Octocode's own files.
		expect(fs.readFileSync(path.join(home, ".claude.json"), "utf8")).toBe(claudeFile);
		expect(audits.map((entry) => [entry.action, entry.target, entry.afterKind, entry.outcome])).toEqual([
			["harness.toggle", "harness:claude", "on", "ok"],
			["harness.toggle", "mcp:claude-mcp", "off", "ok"],
		]);
	});

	it("keeps file paths out of audit rows", async () => {
		await switchHarness({ id: "harness:claude", on: true, scope: "global" }, options());
		await switchHarness({ id: "skill:claude-demo", on: false, scope: "global" }, options());
		// A duplicated skill's id is its path: the audit keeps only the kind, also for a refusal.
		await expect(
			switchHarness({ id: "skill:~/.claude/skills/gone/SKILL.md", on: false, scope: "global" }, options()),
		).rejects.toMatchObject({ status: 404 });
		expect(audits.map((entry) => [entry.target, entry.outcome])).toEqual([
			["harness:claude", "ok"],
			["skill:claude-demo", "ok"],
			["skill", "refused"],
		]);
	});

	it("refuses a workspace switch without a trusted workspace, an unknown id and a kind it does not list", async () => {
		const refusal = (promise: Promise<unknown>) =>
			promise.then(
				() => undefined,
				(error: unknown) => error,
			);
		const noWorkspace = await refusal(switchHarness({ id: "harness:claude", on: true, scope: "workspace" }, options()));
		expect(noWorkspace).toMatchObject({ status: 400 });
		const untrusted = await refusal(
			switchHarness({ id: "harness:claude", on: true, scope: "workspace" }, { ...options(), cwd: root }),
		);
		expect(untrusted).toBeInstanceOf(ConfigWriteError);
		expect(untrusted).toMatchObject({ status: 403 });
		expect(await refusal(switchHarness({ id: "mcp:nope", on: false, scope: "global" }, options()))).toMatchObject({
			status: 404,
		});
		expect(await refusal(switchHarness({ id: "tool:bash", on: false, scope: "global" }, options()))).toMatchObject({
			status: 404,
		});
		expect(fs.existsSync(path.join(agentDir, "settings.json"))).toBe(false);
		expect(audits.every((entry) => entry.outcome === "refused")).toBe(true);
	});
});

describe("/api/admin/config/harness", () => {
	async function daemon() {
		const { env } = isolatedEnv();
		const server: DaemonServer = await startDaemonServer({
			env,
			onActivity: () => {},
			config: async () => ({}),
			harness: () => listHarness({ agentDir, home }),
			writeHarness: (command) => switchHarness(command, options()),
			onDrain: () => {},
		});
		cleanup.push(() => server.close());
		const call = (token: string, body?: unknown) =>
			fetch(`http://127.0.0.1:${server.port}/api/admin/config/harness`, {
				method: body === undefined ? "GET" : "POST",
				headers: { Authorization: `Bearer ${token}`, "content-type": "application/json" },
				...(body === undefined ? {} : { body: JSON.stringify(body) }),
			});
		return { server, call };
	}

	it("lists and switches for the launch token only", async () => {
		const { server, call } = await daemon();
		const listed = await call(server.token);
		expect(listed.status).toBe(200);
		expect(Value.Check(HarnessListSchema, await listed.json())).toBe(true);
		const switched = await call(server.token, { id: "harness:claude", on: true, scope: "global" });
		expect(switched.status).toBe(200);
		expect(row((await switched.json()) as HarnessList, "harness:claude")?.on).toBe(true);
		for (const token of [server.remoteToken, server.viewToken]) {
			expect((await call(token)).status).toBe(403);
			expect((await call(token, { id: "harness:claude", on: false, scope: "global" })).status).toBe(403);
		}
		for (const bad of [
			{ id: "harness:claude", on: "no", scope: "global" },
			{ id: "harness:claude", on: true, scope: "project" },
			{ id: "harness:claude", on: true, scope: "global", extra: 1 },
			{ id: "bad\nid", on: true, scope: "global" },
		])
			expect((await call(server.token, bad)).status).toBe(400);
	});
});

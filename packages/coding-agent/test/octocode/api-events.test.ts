import { execFile } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { closeSharedAgentDb } from "../../../db/src/api.ts";
import { openAgentDb } from "../../src/storage/database.ts";
import { workspaceIdentity } from "../../src/storage/workspace.ts";
import { eventsReport } from "../../src/octocode/api/cli/events.ts";
import { TeamStore } from "../../src/octocode/team/store.ts";
import type { Member } from "@octocodeai/octocode-contracts/team";

/** `octocode-api events` over an isolated agent database seeded by real team joins and leaves. */
const CLI = fileURLToPath(new URL("../../src/octocode/api/cli.ts", import.meta.url));
const RESOLVER = fileURLToPath(new URL("../../scripts/source-resolver.ts", import.meta.url));

let root: string;
let project: string;
let store: TeamStore;
const member = (id: string, extra: Partial<Member> = {}): Member => ({
	id,
	role: "researcher",
	pid: process.pid,
	status: "working",
	joinedAt: 1000,
	updatedAt: 1000,
	toolCalls: 0,
	input: 0,
	cacheRead: 0,
	output: 0,
	cost: 0,
	unpriced: false,
	...extra,
});
const report = (since: number, limit = 200, json = false, cwd = project) => eventsReport({ since, limit, json, cwd });

beforeEach(() => {
	root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "api-events-")));
	project = path.join(root, "project");
	fs.mkdirSync(project);
	vi.stubEnv("OCTOCODE_HOME", path.join(root, "home"));
	vi.stubEnv("OCTOCODE_AGENT_DB", path.join(root, "agent.db"));
	workspaceIdentity(project);
	store = TeamStore.open(project, openAgentDb().file);
	store.lifecycle = { activationId: "act", sessionId: "session-1" };
});
afterEach(() => {
	store.close();
	closeSharedAgentDb();
	vi.unstubAllEnvs();
	fs.rmSync(root, { recursive: true, force: true });
});

function seed() {
	const parent = member("amber-otter", { role: "general" });
	const child = member("brisk-lynx", { parentId: "amber-otter", toolCalls: 4, cost: 0.25 });
	store.join(parent);
	store.join(child);
	store.remove("brisk-lynx", 2000, child, "completed");
	store.remove("amber-otter", 3000, parent);
}

describe("octocode-api events", () => {
	it("lists on and off with parent, reason and final stats, and the last sequence", () => {
		seed();
		const { output } = report(0, 200, true);
		const body = JSON.parse(output) as { since: number; last: number; events: Array<Record<string, any>> };
		expect(body.events.map((event) => [event.event, event.agent])).toEqual([
			["on", "amber-otter"],
			["on", "brisk-lynx"],
			["off", "brisk-lynx"],
			["off", "amber-otter"],
		]);
		expect(body.events[1]).toMatchObject({ parent: "amber-otter", role: "researcher", session: "session-1" });
		expect(body.events[2]).toMatchObject({ reason: "completed", stats: { toolCalls: 4, cost: 0.25 } });
		expect(body.events[3].reason).toBe("left");
		expect(body.last).toBe(body.events[3].seq);
		expect(body.since).toBe(0);

		const text = report(0).output.split("\n");
		expect(text).toHaveLength(5);
		expect(text[2]).toMatch(/\toff\s*\tbrisk-lynx\tresearcher\tparent=amber-otter\treason=completed\ttoolCalls=4/);
		expect(text[4]).toBe(`last seq: ${body.last}`);
	});

	it("pages with --since and --limit, and a caught-up cursor shows nothing new and keeps its sequence", () => {
		seed();
		const first = JSON.parse(report(0, 2, true).output) as { last: number; events: Array<{ seq: number }> };
		expect(first.events).toHaveLength(2);
		const rest = JSON.parse(report(first.last, 2, true).output) as { last: number; events: Array<{ agent: string }> };
		expect(rest.events.map((event) => event.agent)).toEqual(["brisk-lynx", "amber-otter"]);
		const none = JSON.parse(report(rest.last, 2, true).output) as { last: number; events: unknown[] };
		expect(none).toMatchObject({ since: rest.last, last: rest.last, events: [] });
		expect(report(rest.last).output).toBe(`last seq: ${rest.last}`);
		// A later write is the only thing the same cursor then shows.
		store.join(member("late-fox"));
		const later = JSON.parse(report(rest.last, 2, true).output) as { events: Array<{ agent: string }> };
		expect(later.events.map((event) => event.agent)).toEqual(["late-fox"]);
	});

	it("shows only this directory's workspace", () => {
		seed();
		const other = path.join(root, "other");
		fs.mkdirSync(other);
		workspaceIdentity(other);
		expect(JSON.parse(report(0, 200, true, other).output)).toMatchObject({ last: 0, events: [] });
	});

	it("reports nothing, without creating anything, when there is no database or no workspace", () => {
		const missing = path.join(root, "never.db");
		vi.stubEnv("OCTOCODE_AGENT_DB", missing);
		const absent = report(7);
		expect(absent.output).toBe("last seq: 7");
		expect(absent.notice).toContain(missing);
		expect(fs.existsSync(missing)).toBe(false);

		vi.stubEnv("OCTOCODE_AGENT_DB", path.join(root, "agent.db"));
		const bare = path.join(root, "bare");
		fs.mkdirSync(bare);
		expect(report(0, 200, false, bare)).toMatchObject({ output: "last seq: 0", notice: expect.stringContaining(bare) });
		expect(fs.existsSync(path.join(bare, ".octocode"))).toBe(false);
	});

	it("runs as the command: flags are validated and a bad value fails", async () => {
		seed();
		const run = (args: string[]) =>
			new Promise<{ code: number; stdout: string; stderr: string }>((resolve) =>
				execFile(
					process.execPath,
					["--no-warnings", "--import", RESOLVER, CLI, ...args],
					{ cwd: project, env: process.env, encoding: "utf8" },
					(error, stdout, stderr) => resolve({ code: Number(error?.code ?? 0), stdout, stderr }),
				),
			);
		const ok = await run(["events", "--since", "0", "--json", "--limit", "3"]);
		expect(ok.code, ok.stderr).toBe(0);
		expect(JSON.parse(ok.stdout).events).toHaveLength(3);
		const bad = await run(["events", "--limit", "0"]);
		expect(bad.code).toBe(1);
		expect(bad.stderr).toContain("--limit must be a whole number from 1 to 1000");
		const wrong = await run(["list", "--json"]);
		expect(wrong.code).toBe(1);
		expect(wrong.stderr).toContain("--json is not valid for list");
	});
});

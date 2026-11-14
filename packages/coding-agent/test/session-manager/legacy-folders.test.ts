import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	rmSync,
	utimesSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { closeSharedAgentDb } from "../../../db/src/api.ts";
import { getSessionsDir } from "../../src/config.ts";
import { sharedAgentDb } from "../../src/storage/database.ts";
import { SessionManager } from "../../src/core/session-manager.ts";
import { sessionMirrorSettled } from "../../src/core/session-manager/mirror.ts";
import { getDefaultSessionDirPath } from "../../src/core/session-manager/storage.ts";
import { legacySessionDirectoryPath } from "../../src/core/session-manager/directories.ts";
import { quickList } from "../../src/octocode/sessions/catalog.ts";
import { SessionIndex } from "../../src/octocode/sessions/store.ts";

let scratch: string;
let cwd: string;
const managers = new Set<SessionManager>();
function track(manager: SessionManager): SessionManager {
	managers.add(manager);
	return manager;
}

beforeEach(() => {
	scratch = mkdtempSync(join(tmpdir(), "octocode-legacy-sessions-"));
	cwd = join(scratch, "work");
	mkdirSync(cwd);
	vi.stubEnv("OCTOCODE_HOME", join(scratch, "home"));
	vi.stubEnv("OCTOCODE_AGENT_DB", join(scratch, "agent.db"));
});
afterEach(async () => {
	for (const manager of managers) manager.retire();
	managers.clear();
	if (!(await sessionMirrorSettled())) throw new Error("Session mirror did not settle before cleanup");
	closeSharedAgentDb();
	vi.unstubAllEnvs();
	rmSync(scratch, { recursive: true, force: true });
});

/** A pre-workspace transcript; `ageSeconds` backdates its modification time. */
function legacySession(
	id: string,
	sessionCwd: string,
	ageSeconds = 0,
	folder = legacySessionDirectoryPath(cwd),
): string {
	mkdirSync(folder, { recursive: true });
	const file = join(folder, `2026-01-01T00-00-00-000Z_${id}.jsonl`);
	const header = { type: "session", version: 3, id, timestamp: "2026-01-01T00:00:00.000Z", cwd: sessionCwd };
	writeFileSync(file, `${JSON.stringify(header)}\n`);
	const when = new Date(Date.now() - ageSeconds * 1000);
	utimesSync(file, when, when);
	return file;
}

describe("legacy per-cwd session folders", () => {
	it("encodes the folder as the pre-workspace storage did, under the sessions directory", () => {
		const encoded = cwd.replace(/^[/\\]/, "").replace(/[/\\:]/g, "-");
		expect(legacySessionDirectoryPath(cwd)).toBe(join(getSessionsDir(), `--${encoded}--`));
	});

	it("lists a legacy session of this cwd and excludes one whose header cwd differs", async () => {
		const mine = legacySession("mine", cwd);
		legacySession("other", join(scratch, "elsewhere"));
		const listed = await SessionManager.list(cwd);
		expect(listed.map((s) => s.path)).toEqual([mine]);
	});

	it("does not create the legacy folder", async () => {
		await SessionManager.list(cwd);
		track(SessionManager.continueRecent(cwd));
		expect(SessionManager.findById(cwd, "none")).toBeUndefined();
		expect(existsSync(legacySessionDirectoryPath(cwd))).toBe(false);
	});

	it("finds a legacy session by exact id only when its header cwd matches", () => {
		const mine = legacySession("mine-id", cwd);
		legacySession("other-id", join(scratch, "elsewhere"));
		expect(SessionManager.findById(cwd, "mine-id")).toBe(mine);
		expect(SessionManager.findById(cwd, "other-id")).toBeUndefined();
	});

	it("continues the newest session across the workspace and legacy folders", () => {
		const legacyOld = legacySession("legacy-old", cwd, 600);
		expect(track(SessionManager.continueRecent(cwd)).getSessionFile()).toBe(legacyOld);

		const workspace = track(SessionManager.create(cwd));
		workspace.appendMessage({ role: "user", content: "hi", timestamp: Date.now() });
		expect(track(SessionManager.continueRecent(cwd)).getSessionFile()).toBe(workspace.getSessionFile());

		const legacyNew = legacySession("legacy-new", cwd, -600);
		expect(track(SessionManager.continueRecent(cwd)).getSessionFile()).toBe(legacyNew);
	});

	it("opens a legacy file in place with the workspace folder as its session directory", async () => {
		const file = legacySession("opened", cwd);
		const manager = track(SessionManager.open(file));
		expect(manager.getSessionFile()).toBe(file);
		expect(manager.getSessionDir()).toBe(getDefaultSessionDirPath(cwd));
		expect(manager.usesDefaultSessionDir()).toBe(true);
		expect(existsSync(getDefaultSessionDirPath(cwd))).toBe(false);

		manager.appendMessage({ role: "user", content: "still here", timestamp: Date.now() });
		expect(readFileSync(file, "utf8")).toContain("still here");
		expect(readdirSync(legacySessionDirectoryPath(cwd))).toHaveLength(1);

		// What /new does: a new session in the manager's own directory lands in the workspace folder.
		const next = track(
			SessionManager.create(cwd, manager.usesDefaultSessionDir() ? undefined : manager.getSessionDir()),
		);
		next.appendMessage({ role: "user", content: "fresh", timestamp: Date.now() });
		expect(dirname(next.getSessionFile()!)).toBe(getDefaultSessionDirPath(cwd));
		expect(readdirSync(legacySessionDirectoryPath(cwd))).toHaveLength(1);
		const listed = await SessionManager.list(cwd, manager.getSessionDir());
		expect(listed.map((s) => s.path).sort()).toEqual([file, next.getSessionFile()!].sort());
	});

	it("branches a legacy session into the workspace folder, creating it when missing", () => {
		const file = legacySession("branchy", cwd);
		const manager = track(SessionManager.open(file));
		const first = manager.appendMessage({ role: "user", content: "one", timestamp: Date.now() });
		manager.appendMessage({
			role: "assistant",
			content: [{ type: "text", text: "two" }],
			timestamp: Date.now(),
		} as never);
		const branched = manager.createBranchedSession(first);
		expect(dirname(branched!)).toBe(getDefaultSessionDirPath(cwd));
		expect(existsSync(branched!)).toBe(true);
	});

	it("opens a legacy session whose cwd no longer exists without creating that folder", () => {
		const gone = join(scratch, "gone", "deep");
		const file = legacySession("gone", gone, 0, legacySessionDirectoryPath(gone));
		const manager = track(SessionManager.open(file));
		expect(manager.getSessionFile()).toBe(file);
		expect(existsSync(join(scratch, "gone"))).toBe(false);
	});

	it("lists the legacy session in the quick current scope and filters foreign headers", async () => {
		const mine = legacySession("quick-mine", cwd);
		legacySession("quick-other", join(scratch, "elsewhere"));
		const listed = await quickList(new SessionIndex(sharedAgentDb()), { cwd });
		expect(listed.map((s) => s.path)).toEqual([mine]);
	});

	it("lists every file once in listAll", async () => {
		const mine = legacySession("all-mine", cwd);
		const other = legacySession("all-other", join(scratch, "elsewhere"));
		const workspace = track(SessionManager.create(cwd));
		workspace.appendMessage({ role: "user", content: "hi", timestamp: Date.now() });
		const paths = (await SessionManager.listAll()).map((s) => s.path);
		expect(new Set(paths).size).toBe(paths.length);
		expect(paths).toEqual(expect.arrayContaining([mine, other, workspace.getSessionFile()!]));
	});
});

import fs from "node:fs";
import path from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { parseArgs } from "../../src/cli/args.ts";
import type * as NativeConfig from "../../src/config.ts";
import { SessionManager } from "../../src/core/session-manager.ts";
import { transcriptNote } from "../../src/octocode/compaction/summary.ts";
import { archiveFolder, archiveSearch, LIBRARY_FILE } from "../../src/octocode/history/archive.ts";
import { MAX_SUBAGENTS_ENV } from "../../src/octocode/subagents/claim.ts";
import { runSubagent } from "../../src/octocode/subagents/process.ts";
import { rendered, theme } from "./fake-host.ts";
import { tmp } from "./helpers.ts";
import { setup } from "./subagent-record-fixture.ts";
import { buildAgentArgs, childSession, childSessionFile } from "../../src/octocode/subagents/process/session.ts";

const FIXTURE = path.join(path.dirname(new URL(import.meta.url).pathname), "subagent-fake-host.cjs");
const savedArgv = process.argv[1];
const savedEnv = { ...process.env };

beforeAll(() => {
	const root = tmp("octocode-agent-record-");
	process.env.OCTOCODE_HOME = path.join(root, "home");
	process.env.OCTOCODE_AGENT_DB = path.join(root, "team", "team.sqlite");
	for (const key of [
		MAX_SUBAGENTS_ENV,
		"OCTOCODE_SUBAGENT",
		"OCTOCODE_AGENT_ID",
		"OCTOCODE_PARENT_ID",
		"OCTOCODE_AGENT_GOAL",
		"OCTOCODE_AGENT_SCRATCH",
		"OCTOCODE_TEAM_WORKSPACE",
		"OCTOCODE_SUBAGENT_LINGER_SECONDS",
	])
		delete process.env[key];
	const bin = path.join(root, "bin");
	fs.mkdirSync(bin);
	fs.copyFileSync(FIXTURE, path.join(bin, "octocode"));
	process.argv[1] = path.join(bin, "octocode");
});

afterAll(() => {
	process.argv[1] = savedArgv!;
	process.env = savedEnv;
});

describe("a child's saved session", () => {
	it("lives in its scratch folder under its own name, so it goes away with that folder", () => {
		const scratch = tmp();
		expect(childSession({ id: "inky-kraken", scratch })).toEqual({
			dir: path.join(scratch, "session"),
			id: "inky-kraken",
		});
	});

	it("falls back to the run's private output folder when there is no scratch folder", () => {
		const session = childSession({ id: "inky-kraken" });
		expect(session.dir).toMatch(/agent-inky-kraken[\\/]session$/);
		expect(fs.existsSync(path.dirname(session.dir))).toBe(true);
	});

	it("is asked of Octocode for every child: a session id and folder, never --no-session", () => {
		const session = childSession({ id: "inky-kraken", scratch: tmp() });
		const args = buildAgentArgs(undefined, undefined, session);
		expect(args).not.toContain("--no-session");
		expect(parseArgs(args)).toMatchObject({ sessionDir: session.dir, sessionId: session.id });
		expect(parseArgs(args).noSession).toBeFalsy();
	});

	it("gives the child's compaction a transcript to name, where --no-session gave it none", async () => {
		const session = childSession({ id: "inky-kraken", scratch: tmp() });
		const parsed = parseArgs(buildAgentArgs(undefined, undefined, session));
		const cwd = tmp();
		// What Octocode's CLI builds for these flags (`createSessionManager`): a persisted manager, with the file `getSessionFile()` returns.
		const manager = SessionManager.create(cwd, parsed.sessionDir, { id: parsed.sessionId! });
		const file = manager.getSessionFile();
		expect(file).toBeDefined();
		expect(path.dirname(file!)).toBe(session.dir);
		expect(path.basename(file!)).toMatch(/_inky-kraken\.jsonl$/);
		// The compaction summary's recovery note names it: "the transcript has it whole" is then true.
		expect(transcriptNote(file, false)).toContain(`The full transcript before this summary is ${file}`);
		// The ephemeral child had none (what `--no-session` builds), and so its summary named nothing.
		expect(SessionManager.inMemory(cwd, { id: parsed.sessionId! }).getSessionFile()).toBeUndefined();
		expect(transcriptNote(undefined, false)).toBe("");
		// Octocode writes the file with the first reply; the run's details then name it.
		expect(childSessionFile(session)).toBeUndefined();
		manager.appendMessage({ role: "user", content: "hi", timestamp: Date.now() });
		manager.appendMessage({
			role: "assistant",
			content: [{ type: "text", text: "hello" }],
			api: "faux",
			provider: "faux",
			model: "m",
			usage: {
				input: 1,
				output: 1,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 2,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			stopReason: "stop",
			timestamp: Date.now(),
		} as never);
		expect(childSessionFile(session)).toBe(file);
	});
});

describe("what the parent keeps of a child's run", () => {
	let s: ReturnType<typeof setup>;
	beforeEach(() => {
		s = setup();
	});

	it("records the child's session id and transcript file in a foreground run's details", async () => {
		const result = await s.run({ task: "compacts" });
		const id = result.details.id as string;
		const sessionId = result.details.session.id as string;
		expect(sessionId).not.toBe(id);
		expect(result.details.session).toEqual({
			id: sessionId,
			dir: expect.stringMatching(new RegExp(`agents[\\\\/]${id}[\\\\/]session$`)),
			file: expect.stringMatching(new RegExp(`agents[\\\\/]${id}[\\\\/]session[\\\\/].*_${sessionId}\\.jsonl$`)),
		});
		expect(path.dirname(result.details.session.file)).toBe(result.details.session.dir);
		expect(fs.existsSync(result.details.session.file)).toBe(true);
		// A prompt handled without starting a conversation has only its id and prospective transcript folder.
		const bare = await s.run({ task: "handled" });
		expect(bare.details.session).toEqual({
			id: expect.stringMatching(/^[0-9a-f-]{36}$/),
			dir: expect.stringMatching(new RegExp(`agents[\\\\/]${bare.details.id}[\\\\/]session$`)),
		});
	});

	it("records the folder of the child's archive of compacted history next to its session, only once it exists, and tells the parent where it is", async () => {
		const result = await s.run({ task: "archives" });
		const id = result.details.session.id as string;
		const folder = archiveFolder(id);
		expect(result.details.session).toEqual({
			id,
			dir: expect.stringMatching(/session$/),
			file: expect.stringMatching(/\.jsonl$/),
			archive: folder,
		});
		// Its own folder, under its own session id: never the parent's.
		expect(folder).not.toBe(archiveFolder());
		expect(path.basename(path.dirname(folder))).toBe(id);
		expect(fs.existsSync(path.join(folder, LIBRARY_FILE))).toBe(true);
		expect(result.content[0].text).toContain(
			`Its compacted history is archived in ${folder} (LIBRARY.md indexes it). ${archiveSearch()}`,
		);
		// A child that never compacted has no archive path, and its report says nothing of one.
		const bare = await s.run({ task: "compacts" });
		expect(bare.details.session.archive).toBeUndefined();
		expect(bare.content[0].text).not.toContain("archived in");
	});

	it("puts the child's archive in a background run's details and footer", async () => {
		await s.run({ task: "archives", background: true });
		await vi.waitFor(() => expect(s.sent.length).toBe(1), { timeout: 10_000 });
		const details = s.sent[0].message.details;
		expect(details.session.archive).toBe(archiveFolder(details.session.id));
		expect(String(s.sent[0].message.content)).toContain(
			`Its compacted history is archived in ${details.session.archive} `,
		);
	});

	it("never gives a new child the name of a saved conversation: Octocode would reopen it", async () => {
		// Every draw takes the first free name, so a second session in the same repository would pick the first child's name again.
		const random = vi.spyOn(Math, "random").mockReturnValue(0);
		try {
			const cwd = tmp("octocode-agent-cwd-");
			const earlier = setup(cwd);
			const first = await earlier.run({ task: "compacts" });
			earlier.team.stop();
			const later = setup(cwd);
			const second = await later.run({ task: "compacts" });
			later.team.stop();
			const [firstId, secondId] = [first.details.id as string, second.details.id as string];
			expect(secondId).not.toBe(firstId);
			// Its own folder and its own conversation; the first one is untouched.
			const [firstFile, secondFile] = [first.details.session.file as string, second.details.session.file as string];
			expect(path.dirname(secondFile)).not.toBe(path.dirname(firstFile));
			expect(secondFile).toMatch(new RegExp(`_${second.details.session.id}\\.jsonl$`));
			expect(fs.readdirSync(path.dirname(secondFile))).toEqual([path.basename(secondFile)]);
			expect(fs.existsSync(firstFile)).toBe(true);
		} finally {
			random.mockRestore();
		}
	});

	it("keeps archived conversations distinct when different workspaces reuse an agent name", async () => {
		const random = vi.spyOn(Math, "random").mockReturnValue(0);
		try {
			// A child in workspace A compacted and has a saved summary.
			const inA = setup(tmp("octocode-agent-cwd-"));
			const archived = await inA.run({ task: "archives" });
			inA.team.stop();
			const name = archived.details.id as string;
			const sessionId = archived.details.session.id as string;
			expect(fs.existsSync(path.join(archiveFolder(sessionId), LIBRARY_FILE))).toBe(true);
			// A child in repository B draws the same first free name; it never compacts.
			const inB = setup(tmp("octocode-agent-cwd-"));
			const fresh = await inB.run({ task: "report" });
			inB.team.stop();
			expect(fresh.details.id).toBe(name);
			expect(fresh.details.session.id).not.toBe(sessionId);
			expect(fresh.details.session.archive).toBeUndefined();
			expect(fresh.content[0].text).not.toContain("archived in");
		} finally {
			random.mockRestore();
		}
	});

	it("groups sibling cache keys, retains distinct sessions and monitors conversation replies separately from compaction", async () => {
		const first = await s.run({ task: "cache turns" });
		const second = await s.run({ task: "cache turns" });
		const key = (result: typeof first) => String(result.content[0].text).match(/CACHE (\S+) SESSION/)?.[1];
		expect(key(first)).toMatch(/^octocode-child-[a-f0-9]{48}$/);
		expect(key(second)).toBe(key(first));
		expect(first.details.session.id).not.toBe(second.details.session.id);
		expect(first.details.cache).toEqual({
			requests: 3,
			promptTokens: 11150,
			cacheRead: 6000,
			cacheWrite: 4500,
			latest: { promptTokens: 2500, cacheRead: 2000, cacheWrite: 0 },
		});
		// Compaction adds 100 prompt tokens to spend, independently of the conversation cache rate.
		expect(first.details.input).toBe(11250);
		await s.run({ task: "cache turns", background: true });
		await vi.waitFor(() => expect(s.sent.length).toBe(1));
		expect(s.sent[0].message.details).toMatchObject({ cache: first.details.cache });
	});

	it("counts a child's compactions into its row, its cost and its report, and records a failed and a cancelled one", async () => {
		const updates: Array<{ content: Array<{ text?: string }>; details: { compacting?: boolean } }> = [];
		const result = await s.run({ task: "compacts" }, (update) => updates.push(update as never));
		expect(result.details.compactions).toEqual({
			done: 1,
			aborted: 1,
			failed: 1,
			error: "Context overflow recovery failed: provider down",
			tokensBefore: 150000,
			tokensAfter: 32000,
		});
		// The row showed it while it ran, and does not once it ended.
		expect(
			updates.some((update) => update.details.compacting && update.content[0]?.text === "compacting its context"),
		).toBe(true);
		expect(result.details.compacting).toBeUndefined();
		expect(s.ctx.ui.notes.map((note) => note.message)).toEqual([
			expect.stringContaining("compaction started"),
			expect.stringContaining("compaction finished"),
			expect.stringContaining("compaction started"),
			expect.stringContaining("compaction failed"),
			expect.stringContaining("compaction started"),
			expect.stringContaining("compaction cancelled"),
		]);
		// The summary's own model usage is in the run's: the reply (100 in, 20 out, 0.01) plus the compaction (50, 10, 0.005), once.
		expect(result.details).toMatchObject({ input: 150, output: 30 });
		expect(result.details.cost).toBeCloseTo(0.015);
		expect(result.usage.cost.total).toBeCloseTo(0.015);
		const text = result.content[0].text as string;
		expect(text).toContain("Compactions: 1 done, 1 aborted, 1 failed; latest 150k → 32k tokens.");
		expect(text).toContain("latest compaction failure: Context overflow recovery failed: provider down");
		expect(
			rendered(
				s.agent.renderResult(result, { isPartial: false, expanded: true }, theme, {
					isError: false,
					expanded: true,
					durationMs: 250,
				}),
			),
		).toContain("3 compactions (1 failed, 1 aborted)");
		const live = rendered(
			s.agent.renderResult(
				{
					content: [{ type: "text", text: "compacting its context" }],
					details: { ...result.details, compacting: true },
				},
				{ isPartial: true, expanded: false },
				theme,
				{ isError: false },
			),
		);
		expect(live).toMatch(/compacting its context \(/);
	});

	it("puts a background run's compaction counts in the parent's footer and its failure text inside the fence", async () => {
		await s.run({ task: "compacts", background: true });
		await vi.waitFor(() => expect(s.sent.length).toBe(1), { timeout: 10_000 });
		expect(s.ctx.ui.notes).toHaveLength(6);
		expect(s.ctx.ui.notes[1].message).toContain("150k → 32k");
		const content = String(s.sent[0].message.content);
		const [fenced, footer] = content.split(/untrusted-[0-9a-f]{16}>>>/);
		expect(footer).toContain("Compactions: 1 done, 1 aborted, 1 failed; latest 150k → 32k tokens.");
		expect(fenced).toContain("latest compaction failure: Context overflow recovery failed: provider down");
		expect(footer).not.toContain("provider down");
		expect(content).toMatch(/\(\d+s · 0 tool calls · 3 compactions \(1 failed, 1 aborted\) · ≈\$0\.0[12]\)/);
		expect(s.sent[0].message.details).toMatchObject({
			status: "done",
			compactions: { done: 1, aborted: 1, failed: 1 },
			session: { id: expect.stringMatching(/^[0-9a-f-]{36}$/), file: expect.stringMatching(/\.jsonl$/) },
			usage: { input: 150 },
		});
	});

	it('says why a child that stopped its own run stopped, instead of "cancelled before its run settled"', async () => {
		const result = await s.run({ task: "thrash" });
		expect(result.isError).toBe(true);
		const text = result.content[0].text as string;
		expect(text).toMatch(
			/failed · cite as report:\S+:\n<<<untrusted-[0-9a-f]{16} [^\n]*\nSubagent stopped: Automatic compaction stopped: the context refilled to the limit within 2 turns/,
		);
		expect(text).not.toContain("cancelled before its run settled");
		// Every warning and error it showed is kept (the info note is not), the cancelled compaction is counted, and the transcript is named.
		expect(text).toContain(
			"Notices from the subagent (it has no screen):\n- warning: Compaction summary fell back to the standalone request: cache read failed.\n- error: Automatic compaction stopped:",
		);
		expect(text).not.toContain("compacting on the standalone request");
		expect(text).toContain("Compactions: 1 aborted.");
		expect(text).toContain(`Session ${result.details.session.id}: `);
		expect(result.details.notices.kept.map((notice: { level: string }) => notice.level)).toEqual(["warning", "error"]);
	});

	it("reports the same reason for a background child, with its notices inside the fence and a compaction lifecycle notification in the parent", async () => {
		await s.run({ task: "thrash", background: true });
		await vi.waitFor(() => expect(s.sent.length).toBe(1), { timeout: 10_000 });
		const content = String(s.sent[0].message.content);
		expect(content).toMatch(
			/failed · cite as report:\S+:\n<<<untrusted-[0-9a-f]{16} [\s\S]*\nError: Subagent stopped: Automatic compaction stopped:[\s\S]*- warning: Compaction summary fell back[\s\S]*>>>\n/,
		);
		expect(s.sent[0].message.details).toMatchObject({
			status: "failed",
			outcome: "failed",
			notices: { kept: [{ level: "warning" }, { level: "error" }], more: 0 },
			session: { file: expect.stringMatching(/\.jsonl$/) },
		});
		expect(s.ctx.ui.notes.map((note) => note.message)).toEqual([
			expect.stringContaining("compaction started"),
			expect.stringContaining("compaction cancelled"),
		]);
	});

	it("keeps the first few notices inline and names the file that holds every one of them", async () => {
		const result = await s.run({ task: "chatty" });
		const lines = (result.content[0].text as string).split("\n").filter((line) => line.startsWith("- "));
		expect(lines.slice(0, 5)).toEqual([
			"- warning: warning 1",
			"- warning: warning 2",
			"- warning: warning 3",
			"- warning: warning 4",
			"- warning: warning 5",
		]);
		expect(lines[5]).toMatch(
			/^- \+2 more notices; every notice, whole, is in .*notices\.txt \(read it, or search it\)$/,
		);
		expect(result.details.notices).toEqual({
			kept: expect.any(Array),
			more: 2,
			file: expect.stringMatching(/notices\.txt$/),
		});
		expect(fs.readFileSync(result.details.notices.file, "utf8")).toBe(
			Array.from({ length: 7 }, (_, n) => `warning: warning ${n + 1}\n`).join(""),
		);
	});
});

describe("a child that stops itself over the run API", () => {
	it('gives the last error notice as its failure, and "cancelled" only when no one said why', async () => {
		const dir = tmp();
		const args = ["--session-dir", dir, "--session-id", "a-thrash"];
		const seen: Array<{ compacting?: boolean }> = [];
		const outcome = await runSubagent("thrash", args, tmp(), undefined, { id: "a-thrash" }, undefined, (update) =>
			seen.push(update),
		);
		expect(outcome.error).toMatch(/^Subagent stopped: Automatic compaction stopped: /);
		expect(seen.filter((update) => update.compacting !== undefined).map((update) => update.compacting)).toEqual([
			true,
			false,
		]);
	});

	it("does not blame an error from before the child's last turn for its stop", async () => {
		const args = ["--session-dir", tmp(), "--session-id", "a-stale"];
		const outcome = await runSubagent(
			"stale error",
			args,
			tmp(),
			undefined,
			{ id: "a-stale" },
			undefined,
			() => undefined,
		);
		expect(outcome.error).toBe("Subagent cancelled before its run settled");
	});
});

vi.mock("../../src/config.ts", async (original) => ({
	...(await original<typeof NativeConfig>()),
	getCliInvocation: () => ({ command: process.execPath, prefix: [process.argv[1]] }),
}));

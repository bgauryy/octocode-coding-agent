import { spawn } from "node:child_process";
import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import {
	fauxAssistantMessage,
	getCurrentSystemMessage,
	getCurrentTools,
	type TranscriptContext,
} from "@octocodeai/octocode-ai";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { agentDbPath } from "../../src/storage/state-paths.ts";
import type { AgentSessionEvent } from "../../src/core/agent-session/types.ts";
import { SUMMARIZATION_SYSTEM_PROMPT } from "../../src/core/compaction/utils.ts";
import { SessionManager } from "../../src/core/session-manager.ts";
import type { CompactionEntry, SessionEntry } from "../../src/core/session-manager/types.ts";
import { sessionMirrorSettled } from "../../src/core/session-manager/mirror.ts";
import { IDENTITY_ENTRY } from "../../src/octocode/subagents/identity-reminder.ts";
import { type Identity, subagentProcessEnv } from "../../src/octocode/subagents/process/env.ts";
import { buildAgentArgs } from "../../src/octocode/subagents/process/session.ts";
import { loadProfiles } from "../../src/octocode/subagents/profiles.ts";
import { parseArgs } from "../../src/cli/args.ts";
import { transcripts } from "../../../db/src/api.ts";
import { openAgentDb } from "../../src/storage/database.ts";
import { baseEnv, type Fixture, fixture, scriptedSession, withEnv } from "./agent-context/capture.ts";
import { assign, longTask, messageText, SUMMARY_REQUEST } from "./agent-context/child-run.ts";
import { nativeCall } from "./e2e-calls.ts";

/**
 * A long session under trouble, at the scale real sessions reach (median 255 turns, files of several MB): one real child
 * session on a scripted model runs hundreds of turns through automatic compactions, a provider outage, session and
 * database locks held by a real other process, and a resume in a new session object. The run happens once and records what
 * every request carried; each `it` then judges one property, so one failure does not hide the others. Requests are
 * compared as they arrive and dropped, because keeping them would hold hundreds of megabytes of transcript.
 */

const TURNS = 320;
/**
 * About 3,000 tokens a turn: the 200,000-token window fills every 50 or so turns, as a busy real session does. It rides in
 * the prompts because a long scripted reply is streamed in thousands of deltas, which would be most of the suite's time.
 */
const TURN_CHARS = 12_000;
/** More consecutive failures than the default three retries, so a transient outage has to get the capacity class's budget. */
const OUTAGE_REQUESTS = 5;
const OUTAGE_ERROR = "503 service unavailable: upstream is overloaded";
/** A peer's lock shorter than the session lock's wait (`LOCK_WAIT_MS`, 3 s) and the database's `busy_timeout`, and one longer than the first. */
const SHORT_HOLD_MS = 1_500;
const PAST_THE_WAIT_MS = 4_000;
/** Each `file` write names a new path, so what a checkpoint must remember keeps growing with the session. */
const FILE_EVERY_TURNS = 5;
const BASH_EVERY_TURNS = 7;
/** Each on a turn that is a plain prompt and a plain reply, so the trouble meets exactly the writes named here. */
const TURN = { outage: 41, shortLock: 71, longLock: 89, databaseLock: 109, resume: 170 };
const CHECKPOINT = "## Goal\nScripted checkpoint.\n\n## TL;DR\nThe soak continues.";
const LOCKED_REPLY = { short: "SHORT-LOCK-REPLY", long: "LONG-LOCK-REPLY", database: "DATABASE-LOCK-REPLY" };

type Message = TranscriptContext["messages"][number];
type Reply = ReturnType<typeof fauxAssistantMessage>;

/** What a provider receives: the role and content in order, without the timestamps that stay in memory. */
const providerView = (messages: readonly Message[]) =>
	messages.map((message) => {
		const { timestamp: _timestamp, ...rest } = message;
		return JSON.stringify(rest);
	});

/** The system message without its `environment` section, the one part allowed to move (the date, appended as a delta). */
function systemFingerprint(context: TranscriptContext): string {
	const system = getCurrentSystemMessage(context.messages);
	const { environment: _environment, ...sections } = system?.sections ?? {};
	return JSON.stringify({ content: system?.content, sections });
}

const toolCallTurn = (name: string, args: Record<string, unknown>) => () =>
	fauxAssistantMessage([nativeCall(name, args)], { stopReason: "toolUse" });

interface Observed {
	file: string;
	task: string;
	/** Requests the scripted model answered, and how many of them were summaries. */
	requests: number;
	summaryRequests: number;
	/** Distinct system prompts and tool arrays across every request of the session itself. */
	systems: Set<string>;
	toolArrays: Set<string>;
	/** Distinct tool arrays across the summary requests that are meant to share the session's cached prefix. */
	summaryToolArrays: Set<string>;
	/** Where a request did not open with the previous one, with no compaction between them. */
	prefixBreaks: string[];
	/** Whether the first request after the resume opened with the last one before it. */
	resumePrefix?: boolean;
	/** The request and turn of each request after a compaction that did not carry the assignment exactly once. */
	identityGaps: string[];
	requestsAfterCompaction: number;
	taskAfterCompaction: number;
	peakContextChars: number;
	/** The size of the first request after each compaction. */
	contextAfterCompaction: number[];
	compactionsBeforeResume: number;
	compactionsSeen: number;
	turnsDone: number;
	/** Why a prompt rejected; a prompt must never reject because of trouble the session can wait out. */
	promptErrors: string[];
	failedRuns: string[];
	outageRetries: number;
	outageOutcome?: string;
	/** Requests that repeated a failed attempt to the model. */
	outageLeaks: number;
	/** Requests beyond the script: a turn the session started by itself. */
	unscriptedRequests: string[];
	toolErrors: string[];
	stderr: string[];
	/** The lock was still held when the prompt started: the contention in the test is real. */
	heldAtPrompt: { session: boolean; database: boolean };
	finalIdle: boolean;
	compactionSizes: number[];
	entries: SessionEntry[];
	fileBytes: number;
	producedChars: number;
	mirror?: { records: number; byteSize: number };
	memoryAfterResume: number;
	seconds: number;
}

/** Another Octocode process holding the session's lock, or the database's write lock, for `ms`; resolves once it holds. */
function peerHolding(lock: { session: string } | { database: string }, ms: number): Promise<() => Promise<void>> {
	const script =
		"session" in lock
			? `const lockfile = require(${JSON.stringify(createRequire(import.meta.url).resolve("proper-lockfile"))});
			   const release = lockfile.lockSync(${JSON.stringify(lock.session)}, { realpath: false, lockfilePath: ${JSON.stringify(`${lock.session}.lock`)} });
			   console.log("held");
			   setTimeout(() => { release(); process.exit(0); }, ${ms});`
			: `const { DatabaseSync } = require("node:sqlite");
			   const db = new DatabaseSync(${JSON.stringify(lock.database)});
			   db.exec("BEGIN IMMEDIATE");
			   console.log("held");
			   setTimeout(() => { db.exec("COMMIT"); db.close(); process.exit(0); }, ${ms});`;
	return new Promise((resolve, reject) => {
		const peer = spawn(process.execPath, ["--no-warnings", "-e", script], { stdio: ["ignore", "pipe", "inherit"] });
		const exited = new Promise<void>((done) => peer.once("exit", () => done()));
		peer.once("error", reject);
		peer.stdout.once("data", () => resolve(() => exited));
	});
}

const childRun = (fx: Fixture) =>
	assign(
		{
			id: "child-example",
			role: "implementer",
			parentId: "parent-example",
			parentSession: "parent-session-example",
			scratch: fx.scratch,
			permission: { mode: "workspace", grants: [] },
			goal: "migrate the parser",
			item: "B7",
			background: true,
		} as Identity,
		longTask("Migrate the parser."),
	);

async function soak(fx: Fixture): Promise<Observed> {
	const started = Date.now();
	const sessionDir = path.join(fx.scratch, "session");
	const run = childRun(fx);
	const assignment = run.identity.assignment!;
	const profile = loadProfiles(fx.cwd, fx.home, false, {}).get("implementer")!;
	const parsed = parseArgs(buildAgentArgs(profile, undefined, { dir: sessionDir, id: run.identity.id }, []));
	const shape = {
		noMcp: parsed.noMcp,
		noSkills: parsed.noSkills,
		tools: parsed.tools,
		excludeTools: parsed.excludeTools,
	};

	const seen: Observed = {
		file: "",
		task: run.task,
		requests: 0,
		summaryRequests: 0,
		systems: new Set(),
		toolArrays: new Set(),
		summaryToolArrays: new Set(),
		prefixBreaks: [],
		identityGaps: [],
		requestsAfterCompaction: 0,
		taskAfterCompaction: 0,
		peakContextChars: 0,
		contextAfterCompaction: [],
		compactionsBeforeResume: 0,
		compactionsSeen: 0,
		turnsDone: 0,
		promptErrors: [],
		failedRuns: [],
		outageRetries: 0,
		outageLeaks: 0,
		unscriptedRequests: [],
		toolErrors: [],
		stderr: [],
		heldAtPrompt: { session: false, database: false },
		finalIdle: false,
		compactionSizes: [],
		entries: [],
		fileBytes: 0,
		producedChars: 0,
		memoryAfterResume: 0,
		seconds: 0,
	};

	let previous: string[] | undefined;
	/** A compaction ran since the last judged request: the transcript restarts there, by design. */
	let compacted = false;
	let resumed = false;
	let outageLeft = 0;
	let plan: Array<() => Reply | Promise<Reply>> = [];

	const respond = (context: TranscriptContext) => {
		seen.requests += 1;
		const texts = context.messages.filter((message) => message.role !== "system").map(messageText);
		const system = getCurrentSystemMessage(context.messages);
		const standalone = system?.content === SUMMARIZATION_SYSTEM_PROMPT;
		const tools = JSON.stringify(getCurrentTools(context.messages));
		if (standalone || texts.some((text) => text.includes(SUMMARY_REQUEST))) {
			seen.summaryRequests += 1;
			if (!standalone) {
				seen.systems.add(systemFingerprint(context));
				seen.summaryToolArrays.add(tools);
			}
			return fauxAssistantMessage(CHECKPOINT);
		}
		seen.systems.add(systemFingerprint(context));
		seen.toolArrays.add(tools);
		const where = `request ${seen.requests} (turn ${seen.turnsDone + 1})`;
		const view = providerView(context.messages);
		seen.peakContextChars = Math.max(
			seen.peakContextChars,
			view.reduce((sum, part) => sum + part.length, 0),
		);
		if (compacted) seen.contextAfterCompaction.push(view.reduce((sum, part) => sum + part.length, 0));
		if (previous && !compacted) {
			const opensWithPrevious = previous.every((part, index) => view[index] === part);
			if (resumed) seen.resumePrefix = opensWithPrevious;
			else if (!opensWithPrevious) seen.prefixBreaks.push(where);
		}
		resumed = false;
		if (seen.compactionsSeen > 0) {
			seen.requestsAfterCompaction += 1;
			if (texts.filter((text) => text === assignment).length !== 1) seen.identityGaps.push(where);
			if (texts.includes(run.task)) seen.taskAfterCompaction += 1;
		}
		if (view.some((part) => part.includes(OUTAGE_ERROR))) seen.outageLeaks += 1;
		compacted = false;
		previous = view;
		if (outageLeft > 0) {
			outageLeft -= 1;
			return fauxAssistantMessage("", { stopReason: "error", errorMessage: OUTAGE_ERROR });
		}
		const next = plan.shift();
		if (next) return next();
		// What a real model would do when the session starts a turn by itself.
		seen.unscriptedRequests.push(where);
		return fauxAssistantMessage("Noted.");
	};

	const open = async (manager: SessionManager) => {
		const { session, faux } = await scriptedSession(fx, shape, manager);
		// Real retries, with a backoff too short to slow the suite. `maxRetries` stays the default.
		session.settingsManager.applyOverrides({ retry: { enabled: true, baseDelayMs: 1 } });
		faux.setResponses(Array.from({ length: TURNS * 4 }, () => respond));
		const unsubscribe = session.subscribe((event: AgentSessionEvent) => {
			if (event.type === "auto_retry_start") seen.outageRetries += 1;
			if (event.type === "compaction_end" && event.result) {
				seen.compactionsSeen += 1;
				compacted = true;
			}
			if (event.type === "tool_execution_end" && event.isError) seen.toolErrors.push(event.toolName);
		});
		return { session, unsubscribe };
	};

	// A contended database reports on stderr while the session waits; the run keeps the lines to judge them.
	const stderr = vi.spyOn(process.stderr, "write").mockImplementation((chunk) => {
		seen.stderr.push(String(chunk));
		return true;
	});

	let manager = SessionManager.create(fx.cwd, sessionDir);
	seen.file = manager.getSessionFile()!;
	let { session, unsubscribe } = await open(manager);
	try {
		const bulk = "check the parser module ".repeat(Math.ceil(TURN_CHARS / 24));
		for (let turn = 1; turn <= TURNS; turn++) {
			if (turn === TURN.resume) {
				unsubscribe();
				session.dispose?.();
				seen.compactionsBeforeResume = seen.compactionsSeen;
				// A new process reopens the same file; nothing of the old session object survives but the file and database.
				manager = SessionManager.open(seen.file, sessionDir);
				({ session, unsubscribe } = await open(manager));
				seen.memoryAfterResume = session.messages.length;
				resumed = true;
			}
			const lockFile = fs.realpathSync(fs.existsSync(seen.file) ? seen.file : sessionDir);
			const finish: Array<() => Promise<void>> = [];
			let label = "";
			if (turn === TURN.shortLock) {
				label = LOCKED_REPLY.short;
				finish.push(await peerHolding({ session: lockFile }, SHORT_HOLD_MS));
				seen.heldAtPrompt.session = fs.existsSync(`${lockFile}.lock`);
			}
			if (turn === TURN.databaseLock) {
				label = LOCKED_REPLY.database;
				finish.push(await peerHolding({ database: agentDbPath(process.env) }, SHORT_HOLD_MS));
				seen.heldAtPrompt.database = true;
			}
			if (turn === TURN.outage) outageLeft = OUTAGE_REQUESTS;
			plan = [];
			if (turn % BASH_EVERY_TURNS === 0) plan.push(toolCallTurn("bash", { command: "echo soak" }));
			if (turn % FILE_EVERY_TURNS === 0) {
				const target = path.join(fx.cwd, "src", `module-${turn}.ts`);
				const queries = [{ reason: "write", type: "write", path: target, content: `export const turn = ${turn};\n` }];
				plan.push(toolCallTurn("file", { reason: "write", queries }));
			}
			const text = `${turn === TURN.longLock ? LOCKED_REPLY.long : label} Turn ${turn}: done.`;
			plan.push(async () => {
				// The prompt is already on disk: the reply, which the session cannot regenerate, meets the lock.
				if (turn === TURN.longLock) finish.push(await peerHolding({ session: lockFile }, PAST_THE_WAIT_MS));
				return fauxAssistantMessage(text);
			});
			seen.producedChars += bulk.length + text.length;
			try {
				await session.prompt(turn === 1 ? run.task : `Turn ${turn}: keep going. ${bulk}`);
			} catch (error) {
				seen.promptErrors.push(`turn ${turn}: ${String(error)}`);
			}
			for (const done of finish) await done();
			const outcome = session.lastRunOutcome;
			if (turn === TURN.outage) seen.outageOutcome = outcome?.status;
			if (outcome && outcome.status !== "completed")
				seen.failedRuns.push(`turn ${turn}: ${outcome.status}: ${outcome.errorMessage}`);
			seen.turnsDone = turn;
		}
		seen.finalIdle = session.isIdle;
	} finally {
		unsubscribe();
		session.dispose?.();
		stderr.mockRestore();
	}

	// What the file holds now, read as a new process would.
	const reopened = SessionManager.open(seen.file, sessionDir);
	seen.entries = reopened.getEntries();
	seen.fileBytes = fs.statSync(seen.file).size;
	seen.compactionSizes = seen.entries
		.filter((entry): entry is CompactionEntry => entry.type === "compaction")
		.map((entry) => entry.summary.length);
	// The database writer saves the mirror after the file; its acknowledgements come before the read.
	await sessionMirrorSettled(30_000);
	const agent = openAgentDb(agentDbPath(process.env), process.env);
	try {
		seen.mirror = {
			records: transcripts.records(agent.db, reopened.getSessionId()).length,
			byteSize: transcripts.stamp(agent.db, reopened.getSessionId())?.byte_size ?? -1,
		};
	} finally {
		agent.close();
	}
	seen.seconds = (Date.now() - started) / 1000;
	return seen;
}

describe("a long session under trouble (scripted model)", () => {
	let fx: Fixture;
	let seen: Observed;

	beforeAll(async () => {
		fx = fixture();
		const profile = loadProfiles(fx.cwd, fx.home, false, {}).get("implementer")!;
		seen = await withEnv(subagentProcessEnv(profile, baseEnv(fx), childRun(fx).identity), () => soak(fx));
		// The record of this run, so a report can compare runs: summary size per compaction above all.
		console.log(
			`soak: ${seen.turnsDone} turns, ${seen.requests} requests (${seen.summaryRequests} summaries), ` +
				`${seen.compactionSizes.length} compactions (${seen.compactionsBeforeResume} before the resume), ` +
				`summary chars per compaction [${seen.compactionSizes.join(", ")}], ` +
				`context chars after each [${seen.contextAfterCompaction.join(", ")}], peak ${seen.peakContextChars}, ` +
				`file ${seen.fileBytes} bytes, summary tool arrays ${seen.summaryToolArrays.size}, ` +
				`unscripted requests [${seen.unscriptedRequests.join(", ")}], ${seen.seconds.toFixed(1)} s`,
		);
	}, 180_000);

	afterAll(() => {
		if (fx) fs.rmSync(fx.root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
	});

	it("reaches every turn, with compactions on both sides of the resume", () => {
		expect(seen.turnsDone).toBe(TURNS);
		expect(seen.promptErrors).toEqual([]);
		expect(seen.finalIdle).toBe(true);
		expect(seen.compactionSizes.length).toBeGreaterThanOrEqual(2);
		expect(seen.compactionSizes.length).toBe(seen.compactionsSeen);
		expect(seen.compactionsBeforeResume).toBeGreaterThanOrEqual(1);
		expect(seen.compactionsSeen).toBeGreaterThan(seen.compactionsBeforeResume);
		expect(seen.toolErrors).toEqual([]);
		// Not vacuous: the whole script ran through the model.
		expect(seen.requests).toBeGreaterThanOrEqual(TURNS);
	});

	it("keeps the system prompt and tool array byte-identical through every compaction and the resume", () => {
		expect(seen.systems.size).toBe(1);
		expect(seen.toolArrays.size).toBe(1);
	});

	it("declares the same tools in the summary requests that share the session's cached prefix", () => {
		expect([...seen.summaryToolArrays]).toEqual([...seen.toolArrays]);
	});

	it("extends the previous request between compactions, and across the resume", () => {
		expect(seen.prefixBreaks).toEqual([]);
		expect(seen.memoryAfterResume).toBeGreaterThan(0);
		expect(seen.resumePrefix).toBe(true);
	});

	it("carries the assignment exactly once in every request after a compaction, and not the old task", () => {
		expect(seen.requestsAfterCompaction).toBeGreaterThan(100);
		expect(seen.identityGaps).toEqual([]);
		expect(seen.taskAfterCompaction).toBe(0);
		// The record of the assignment is not repeated by compaction or by the resume.
		const records = seen.entries.filter((entry) => entry.type === "custom" && entry.customType === IDENTITY_ENTRY);
		expect(records).toHaveLength(1);
	});

	it("rides out a provider outage longer than the default retry count", () => {
		expect(seen.outageRetries).toBe(OUTAGE_REQUESTS);
		expect(seen.outageOutcome).toBe("completed");
		expect(seen.outageLeaks).toBe(0);
	});

	it("loses nothing when a peer holds the session lock, or the database write lock, for a while", () => {
		expect(seen.heldAtPrompt).toEqual({ session: true, database: true });
		const onDisk = fs.readFileSync(seen.file, "utf8");
		expect(onDisk).toContain(LOCKED_REPLY.short);
		expect(onDisk).toContain(LOCKED_REPLY.database);
		expect(onDisk).toContain(`Turn ${TURN.shortLock}: keep going.`);
		expect(onDisk).toContain(`Turn ${TURN.databaseLock}: keep going.`);
	});

	it("keeps a reply when a peer holds the session lock past the wait, and the run stays truthful", () => {
		expect(fs.readFileSync(seen.file, "utf8")).toContain(LOCKED_REPLY.long);
		expect(seen.failedRuns).toEqual([]);
	});

	it("keeps the database mirror level with the file after every lock has passed", () => {
		const lines = fs.readFileSync(seen.file, "utf8").split("\n").filter(Boolean).length;
		expect(seen.mirror?.byteSize).toBe(seen.fileBytes);
		expect(seen.mirror?.records).toBe(lines);
		expect(seen.stderr.filter((line) => /persistence failed/i.test(line))).toEqual([]);
	});

	it("bounds growth: context, summary and file stay in proportion however long the session runs", () => {
		// About four characters a token and a little framing: the context never passes the 200,000-token window.
		expect(seen.peakContextChars).toBeLessThan(200_000 * 4 * 1.1);
		// A compaction gives most of the window back, the last as much as the first.
		expect(Math.max(...seen.contextAfterCompaction)).toBeLessThan(seen.peakContextChars * 0.6);
		// JSONL is linear in what the session produced: no copy per compaction, turn or resume.
		expect(seen.fileBytes).toBeLessThan(seen.producedChars * 1.5 + seen.entries.length * 4_000);
	});

	it("keeps each checkpoint's size independent of how long the session ran", () => {
		// What a checkpoint must remember moves to a file instead of growing the summary with the session.
		const [first] = seen.compactionSizes;
		expect(Math.max(...seen.compactionSizes)).toBeLessThan(first * 1.5 + 4_000);
	});
});

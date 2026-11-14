import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { vi } from "vitest";
import { transcripts } from "../../../../db/src/api.ts";
import type { AgentSessionEvent } from "../../../src/core/agent-session/types.ts";
import { SessionManager } from "../../../src/core/session-manager.ts";
import { sessionMirrorSettled } from "../../../src/core/session-manager/mirror.ts";
import type { CompactionEntry } from "../../../src/core/session-manager/types.ts";
import { CLEARED_RESULTS_TYPE } from "../../../src/octocode/files/reads.ts";
import { STALL_ENTRY } from "../../../src/octocode/profiler/stalls.ts";
import { openAgentDb } from "../../../src/storage/database.ts";
import { agentDbPath } from "../../../src/storage/state-paths.ts";
import { baseEnv, fixture, withEnv } from "../agent-context/capture.ts";
import { replayModel, type ReplayObservations } from "./model.ts";
import { type GcTotals, type LoopDelay, spread, startProbes, startProfile } from "./probes.ts";
import { readRecording, copyRecording, type Recording } from "./recording.ts";
import { recoverability, type Recovery } from "./recover.ts";
import { replaySession } from "./session.ts";
import { replayTools } from "./tools.ts";

/**
 * Replays a recorded session through a real main session, offline: the replay model answers each request with the
 * recorded reply, stand-in tools answer each call with the recorded result. Everything runs in a temporary project,
 * home and agent database. The run happens once; the result holds counts, fingerprints and measurements, never the
 * requests themselves.
 */

export interface ReplayOptions {
	/** The recorded session file; only a copy of it is opened. */
	source: string;
	/** The replay model's context window, in tokens. */
	contextWindow: number;
	/** Writes a CPU profile (and a heap profile when `heapProfile`) here, named after `name`. */
	profileDir?: string;
	heapProfile?: boolean;
	name: string;
	/** Copies the replayed session file here before the temporary folders go (a local run's evidence, never committed). */
	keepDir?: string;
}

export interface ReplayResult {
	name: string;
	contextWindow: number;
	recording: Pick<Recording, "bytes" | "entries" | "toolNames" | "recordedUsage" | "skipped"> & {
		turns: number;
		replies: number;
		summaries: number;
	};
	model: Omit<ReplayObservations, "systemsBySegment" | "toolArraysBySegment"> & {
		/** Distinct system prompts and tool arrays in each compaction segment. */
		systemsPerSegment: number[];
		toolArraysPerSegment: number[];
	};
	tools: {
		replayed: number;
		notRecorded: string[];
		refused: string[];
		executed: number;
		ended: number;
		errors: number;
	};
	turnsDone: number;
	promptErrors: string[];
	failedRuns: string[];
	/** Turns whose recorded replies were not all requested (`turn n: k left`). */
	leftovers: string[];
	finalIdle: boolean;
	compactions: { count: number; summaryChars: number[]; tokensBefore: number[] };
	recovery: Recovery[];
	projectionStable: boolean;
	file: { bytes: number; lines: number; entries: number };
	mirror: { records: number; byteSize: number };
	profiler: {
		toolResults: number;
		withPhases: number;
		replies: number;
		withFirstToken: number;
		stalls: number;
		maxStallMs: number;
		/** The largest prompt the replay model was charged for (input, cache reads and writes), in tokens. */
		peakPromptTokens: number;
	};
	timing: {
		seconds: number;
		turnMs: { p50: number; p95: number; max: number };
		slowTurns: SlowTurn[];
		loop: LoopDelay;
		gc: GcTotals;
		heapPeakBytes: number;
		rssPeakBytes: number;
	};
	profiles: string[];
	persistenceFailures: string[];
}

/** How many of the slowest turns the result names. */
const SLOW_TURNS = 8;

export interface SlowTurn {
	turn: number;
	ms: number;
	/** The longest event-loop delay inside the turn. */
	loopMaxMs: number;
	requests: number;
	compactions: number;
}

const resultText = (result: unknown): string => {
	const content = (result as { content?: Array<{ type?: string; text?: string }> } | undefined)?.content ?? [];
	return content
		.map((part) => (part.type === "text" ? (part.text ?? "") : ""))
		.join(" ")
		.replace(/\s+/g, " ")
		.slice(0, 160);
};

const digest = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");

/** Runs one replay; the temporary project, home and database are removed before it returns. */
export async function replay(options: ReplayOptions): Promise<ReplayResult> {
	const fx = fixture();
	// `full` is the mode a session starts in when the user exported none: no routine asks, as in most recordings.
	// The suite's own markers (`OCTOCODE_TEST_*`) stay: they guard the real agent database in this process too.
	const markers = Object.entries(process.env).filter(([key]) => key.startsWith("OCTOCODE_TEST_"));
	const env = { ...baseEnv(fx), ...Object.fromEntries(markers), OCTOCODE_PERMISSION: "full" };
	try {
		return await withEnv(env, () => run(fx, options));
	} finally {
		fs.rmSync(fx.root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
	}
}

async function run(fx: ReturnType<typeof fixture>, options: ReplayOptions): Promise<ReplayResult> {
	const started = performance.now();
	const recording = readRecording(copyRecording(options.source, path.join(fx.root, "recording")));
	const replies = recording.turns.reduce((sum, turn) => sum + turn.replies.length, 0);
	const model = replayModel(recording);
	const stand = replayTools(recording);
	const sessionDir = path.join(fx.root, "sessions");
	const manager = SessionManager.create(fx.cwd, sessionDir);
	const { session } = await replaySession(fx, {
		sessionManager: manager,
		contextWindow: options.contextWindow,
		tools: stand.tools,
		respond: model.respond,
	});
	const file = manager.getSessionFile()!;
	const tools = { executed: 0, ended: 0, errors: 0 };
	/** Calls that ended without their stand-in running: a gate refused them (`tool: the refusal's first words`). */
	const refused: string[] = [];
	const unsubscribe = session.subscribe((event: AgentSessionEvent) => {
		if (event.type === "compaction_end" && event.result) model.compactionDone();
		if (
			event.type === "entry_appended" &&
			event.entry.type === "custom" &&
			event.entry.customType === CLEARED_RESULTS_TYPE
		)
			model.clearingDone();
		if (event.type === "tool_execution_start" && !event.parentToolCallId) tools.executed += 1;
		if (event.type === "tool_execution_end" && !event.parentToolCallId) {
			tools.ended += 1;
			if (event.isError) tools.errors += 1;
			if (!stand.seen.ran.has(event.toolCallId)) refused.push(`${event.toolName}: ${resultText(event.result)}`);
		}
	});
	// A persistence failure is reported on stderr while the session carries on; the replay keeps those lines.
	const persistenceFailures: string[] = [];
	const stderr = vi.spyOn(process.stderr, "write").mockImplementation((chunk) => {
		const line = String(chunk);
		if (/persistence failed/i.test(line)) persistenceFailures.push(line.trim());
		return true;
	});

	const promptErrors: string[] = [];
	const failedRuns: string[] = [];
	const leftovers: string[] = [];
	const turnMs: number[] = [];
	const slowTurns: SlowTurn[] = [];
	let turnsDone = 0;
	let finalIdle = false;
	let liveProjection = "";
	const probes = startProbes();
	const stopProfile = options.profileDir
		? await startProfile(options.profileDir, options.name, options.heapProfile === true)
		: undefined;
	let profiles: string[] = [];
	let measured: ReturnType<ReturnType<typeof startProbes>["stop"]>;
	try {
		for (const turn of recording.turns) {
			model.beginTurn(turn);
			const before = { requests: model.seen.requests, compactions: model.seen.compactionsSeen };
			probes.turnStarted();
			const turnStarted = performance.now();
			try {
				if (turn.trigger.kind === "user") {
					await session.prompt(turn.trigger.text, {
						expandPromptTemplates: false,
						...(turn.trigger.images.length > 0 ? { images: turn.trigger.images } : {}),
					});
				} else {
					const messages = turn.trigger.messages;
					for (const [position, message] of messages.entries())
						await session.sendCustomMessage(message, { triggerTurn: position === messages.length - 1 });
				}
			} catch (error) {
				promptErrors.push(`turn ${turn.index + 1}: ${String(error)}`);
			}
			const took = performance.now() - turnStarted;
			turnMs.push(took);
			slowTurns.push({
				turn: turn.index + 1,
				ms: Math.round(took),
				loopMaxMs: probes.turnEnded(),
				requests: model.seen.requests - before.requests,
				compactions: model.seen.compactionsSeen - before.compactions,
			});
			slowTurns.sort((a, b) => b.ms - a.ms).splice(SLOW_TURNS);
			const left = model.leftover();
			if (left > 0) leftovers.push(`turn ${turn.index + 1}: ${left} left`);
			const outcome = session.lastRunOutcome;
			if (outcome && outcome.status !== "completed")
				failedRuns.push(`turn ${turn.index + 1}: ${outcome.status}: ${outcome.errorMessage}`);
			turnsDone += 1;
			probes.sampleHeap();
		}
		finalIdle = session.isIdle;
		liveProjection = digest(manager.buildSessionProjection());
	} finally {
		if (stopProfile) profiles = await stopProfile();
		measured = probes.stop();
		unsubscribe();
		session.dispose?.();
		stderr.mockRestore();
	}

	// What the file holds now, read as a new process would.
	const reopened = SessionManager.open(file, sessionDir);
	const entries = reopened.getEntries();
	const text = fs.readFileSync(file, "utf8");
	if (options.keepDir) {
		fs.mkdirSync(options.keepDir, { recursive: true });
		fs.copyFileSync(file, path.join(options.keepDir, `replayed-${options.name}.jsonl`));
	}
	const compactions = entries.filter((entry): entry is CompactionEntry => entry.type === "compaction");
	const messages = entries.flatMap((entry) => (entry.type === "message" ? [entry.message] : []));
	const results = messages.filter((message) => message.role === "toolResult");
	const assistants = messages.filter((message) => message.role === "assistant");
	const stalls = entries.flatMap((entry) =>
		entry.type === "custom" && entry.customType === STALL_ENTRY ? [entry.data as { maxMs: number }] : [],
	);
	await sessionMirrorSettled(30_000);
	const agent = openAgentDb(agentDbPath(process.env), process.env);
	let mirror: ReplayResult["mirror"];
	try {
		mirror = {
			records: transcripts.records(agent.mirror.db, reopened.getSessionId()).length,
			byteSize: transcripts.stamp(agent.mirror.db, reopened.getSessionId())?.byte_size ?? -1,
		};
	} finally {
		agent.close();
	}
	const { systemsBySegment, toolArraysBySegment, ...counts } = model.seen;
	return {
		name: options.name,
		contextWindow: options.contextWindow,
		recording: {
			bytes: recording.bytes,
			entries: recording.entries,
			toolNames: recording.toolNames,
			recordedUsage: recording.recordedUsage,
			skipped: recording.skipped,
			turns: recording.turns.length,
			replies,
			summaries: recording.summaries.length,
		},
		model: {
			...counts,
			systemsPerSegment: systemsBySegment.map((set) => set?.size ?? 0),
			toolArraysPerSegment: toolArraysBySegment.map((set) => set?.size ?? 0),
		},
		tools: { replayed: stand.seen.replayed, notRecorded: stand.seen.notRecorded, refused, ...tools },
		turnsDone,
		promptErrors,
		failedRuns,
		leftovers,
		finalIdle,
		compactions: {
			count: compactions.length,
			summaryChars: compactions.map((entry) => entry.summary.length),
			tokensBefore: compactions.map((entry) => entry.tokensBefore),
		},
		recovery: recoverability(reopened.getBranch(), text),
		projectionStable: digest(reopened.buildSessionProjection()) === liveProjection,
		file: { bytes: fs.statSync(file).size, lines: text.split("\n").filter(Boolean).length, entries: entries.length },
		mirror,
		profiler: {
			toolResults: results.length,
			withPhases: results.filter((message) => message.phases !== undefined).length,
			replies: assistants.length,
			withFirstToken: assistants.filter((message) => message.firstTokenMs !== undefined).length,
			stalls: stalls.length,
			maxStallMs: Math.max(0, ...stalls.map((stall) => stall.maxMs)),
			peakPromptTokens: Math.max(
				0,
				...assistants.map(({ usage }) => (usage ? usage.input + usage.cacheRead + usage.cacheWrite : 0)),
			),
		},
		timing: {
			seconds: Math.round((performance.now() - started) / 100) / 10,
			turnMs: spread(turnMs),
			slowTurns,
			...measured,
		},
		profiles,
		persistenceFailures,
	};
}

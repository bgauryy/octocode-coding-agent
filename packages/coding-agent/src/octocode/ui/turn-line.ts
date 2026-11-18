import { GLYPH, Text } from "@octocodeai/octocode-tui";
import type { FeatureSetup } from "../../core/features/index.ts";
import { setToolInterruptShown } from "../../core/application/interrupted-tools.ts";
import { isRecord } from "@octocodeai/octocode-contracts/guards";
import { formatCost, formatDuration } from "../shared/format.ts";
import { modelLookup } from "../shared/util.ts";
import { beginRun, resetRun, settleRun } from "../../utils/run-clock.ts";
import { sessionPhaseOf } from "../shared/session-phase.ts";
import { TurnRun } from "./turn-run.ts";
import { registerPhaseFeed } from "./phase-feed.ts";
import { wakeGateOf } from "../wake/gate.ts";

/** The session entry (`api.session.appendEntry`, never sent to the model) that carries one turn's summary line (`dropped`: wake nudges skipped after it). */
export const TURN_LINE_TYPE = "octocode-turn";

/** A turn shorter than this, with no tool and no dropped nudge, is not worth a line. */
const MIN_TURN_MS = 3_000;

/** Waiting shorter than this is not worth a part of the line. */
const MIN_WAITED_MS = 1_000;

const count = (value: unknown): number => (typeof value === "number" && value > 0 ? value : 0);

/** The items an entry says its job left open (`open`: their refs); anything else counts none. */
function entryOpenItems(data: unknown): string[] {
	const open = isRecord(data) && Array.isArray(data.open) ? data.open : [];
	return open.filter((ref): ref is string => typeof ref === "string");
}

/**
 * `✻ Worked 4m02s · waited 10m49s · 7 tools · 3 agents · ≈$4.12 · cache 61%`, or undefined when the entry holds no usable
 * duration. A part that is zero or unknown is left out, so an old entry holding only `{ms, tools}` still reads.
 * `waited` is the job's time with no run of its own; `2 items still open` closes a job that stopped with items ongoing.
 */
export function turnLineText(data: unknown): string | undefined {
	if (!isRecord(data) || typeof data.ms !== "number" || !Number.isFinite(data.ms)) return undefined;
	const tools = count(data.tools);
	const agents = count(data.agents);
	const cost = formatCost({ cost: count(data.cost), unpriced: data.unpriced === true });
	const cache = Math.round(count(data.cache));
	const dropped = count(data.dropped);
	const waited = count(data.waitedMs);
	const open = entryOpenItems(data).length;
	const parts = [
		`Worked ${formatDuration(data.ms)}`,
		waited >= MIN_WAITED_MS ? `waited ${formatDuration(waited)}` : "",
		tools ? `${tools} tool${tools === 1 ? "" : "s"}` : "",
		agents ? `${agents} agent${agents === 1 ? "" : "s"}` : "",
		cost === "cost n/a" ? "" : cost,
		cache ? `cache ${cache}%` : "",
		dropped ? `${dropped} nudge${dropped === 1 ? "" : "s"} dropped` : "",
		open ? `${open} item${open === 1 ? "" : "s"} still open` : "",
	];
	return `${GLYPH.turn} ${parts.filter(Boolean).join(" · ")}`;
}

/**
 * One dim line when a job ends: after the last assistant block of a job that took at least three seconds or used a tool.
 * A job is the session's own runs and the time it waits for its agents, jobs and timers between them (`shared/session-phase.ts`),
 * so the line is not printed while work the session waits for is running. It is a session entry, so it is not part of the
 * model's context and is drawn again when the session resumes. Subagents never register it (`registerUi` returns first):
 * their sessions have no transcript on screen.
 *
 * Also records whether a tool of the run ended under an interrupt, which the message that follows the aborted row
 * reads so the interrupt is said once.
 */
export function registerTurnLine(api: FeatureSetup): void {
	registerPhaseFeed(api);
	let counting = false;
	/** A job is open from its first run until `onJobEnd`; the totals accumulate over all of its runs. */
	let job = false;
	let hasUI = false;
	const run = new TurnRun();
	api.renderers.entry(TURN_LINE_TYPE, (entry, _options, theme) => {
		const text = turnLineText(entry.data);
		return text ? new Text(theme.fg(entryOpenItems(entry.data).length > 0 ? "warning" : "dim", text), 1, 0) : undefined;
	});
	// A run is every segment from the first start to `agent_settled`: retries, auto-continues, compaction resumes and
	// queued follow-ups start more segments inside it.
	api.bus.on("session_start", async () => {
		job = false;
		counting = false;
	});
	api.bus.on("agent_start", async (_event, ctx) => {
		hasUI = ctx.hasUI;
		if (!counting) {
			counting = true;
			// A run this module did not see settle (a replaced session) leaves no start behind.
			resetRun();
			beginRun(Date.now());
		}
		if (!job) {
			job = true;
			run.begin(ctx.sessionManager);
		}
		setToolInterruptShown(false);
	});
	api.bus.on("tool_execution_start", async (event) => {
		if (!event.parentToolCallId) run.tool();
	});
	api.bus.on("tool_execution_end", async (event, ctx) => {
		if (!event.parentToolCallId && event.isError && ctx.signal?.aborted) setToolInterruptShown(true);
	});
	api.bus.on("message_end", async (event, ctx) => {
		if (job) run.message(event.message, modelLookup(ctx));
	});
	api.bus.on("session_compact", async (event, ctx) => {
		if (!job) return;
		run.entry(event.compactionEntry, modelLookup(ctx));
		run.recorded(ctx.sessionManager, modelLookup(ctx));
	});
	api.bus.on("session_tree", async (event, ctx) => {
		if (job) run.entry(event.summaryEntry, modelLookup(ctx));
	});
	api.bus.on("agent_end", async (_event, ctx) => {
		if (job) run.recorded(ctx.sessionManager, modelLookup(ctx));
	});
	api.bus.on("agent_settled", async (event, ctx) => {
		// A queued steer or follow-up starts the next segment of this run; an abort drops the queue's turn to the user.
		if (counting && settleRun(Date.now(), ctx.hasPendingMessages() && !event.aborted) !== undefined) counting = false;
	});
	// The line is appended when the job ends, not when a run does: agents the session waits for, a report about to wake it
	// and timers keep the job open, and a job whose work drains with no run left ends with no run to hang the line on.
	sessionPhaseOf(api).onJobEnd((end) => {
		if (!job) return;
		job = false;
		const { tools, agents, cost, unpriced, cache } = run.totals();
		if (!hasUI) return;
		// Nudges the wake gate dropped after this run (`subagents/idle-items.ts`): the record is how they are measured.
		const gate = wakeGateOf(api);
		const dropped = gate.droppedCount();
		if (end.workedMs + end.waitedMs < MIN_TURN_MS && tools === 0 && dropped === 0) return;
		const open =
			end.phase.state === "stopped" ? end.phase.open : end.phase.state === "failed" ? (end.phase.open ?? []) : [];
		api.session.appendEntry(TURN_LINE_TYPE, {
			ms: end.workedMs,
			...(end.waitedMs >= MIN_WAITED_MS ? { waitedMs: end.waitedMs } : {}),
			...(open.length ? { open } : {}),
			...(dropped ? { dropped } : {}),
			tools,
			...(agents ? { agents } : {}),
			...(cost > 0 ? { cost } : {}),
			...(unpriced ? { unpriced } : {}),
			...(cache ? { cache } : {}),
		});
		gate.ackDropped(dropped);
	});
}

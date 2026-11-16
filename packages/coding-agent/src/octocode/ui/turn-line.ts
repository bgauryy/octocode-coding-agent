import { GLYPH, Text } from "@octocodeai/octocode-tui";
import type { ExtensionAPI } from "../../core/features/index.ts";
import { setToolInterruptShown } from "../../core/application/interrupted-tools.ts";
import { isRecord } from "@octocodeai/octocode-contracts/guards";
import { formatCost, formatDuration } from "../shared/format.ts";
import { modelLookup } from "../shared/util.ts";
import { beginRun, resetRun, settleRun } from "../../utils/run-clock.ts";
import { TurnRun } from "./turn-run.ts";
import { wakeGateOf } from "../wake/gate.ts";

/** The session entry (`api.appendEntry`, never sent to the model) that carries one turn's summary line (`dropped`: wake nudges skipped after it). */
export const TURN_LINE_TYPE = "octocode-turn";

/** A turn shorter than this, with no tool and no dropped nudge, is not worth a line. */
const MIN_TURN_MS = 3_000;

const count = (value: unknown): number => (typeof value === "number" && value > 0 ? value : 0);

/**
 * `✻ Worked 1m02s · 5 tools · 3 agents · ≈$4.12 · cache 61%`, or undefined when the entry holds no usable duration.
 * A part that is zero or unknown is left out, so an old entry holding only `{ms, tools}` still reads.
 */
export function turnLineText(data: unknown): string | undefined {
	if (!isRecord(data) || typeof data.ms !== "number" || !Number.isFinite(data.ms)) return undefined;
	const tools = count(data.tools);
	const agents = count(data.agents);
	const cost = formatCost({ cost: count(data.cost), unpriced: data.unpriced === true });
	const cache = Math.round(count(data.cache));
	const dropped = count(data.dropped);
	const parts = [
		`Worked ${formatDuration(data.ms)}`,
		tools ? `${tools} tool${tools === 1 ? "" : "s"}` : "",
		agents ? `${agents} agent${agents === 1 ? "" : "s"}` : "",
		cost === "cost n/a" ? "" : cost,
		cache ? `cache ${cache}%` : "",
		dropped ? `${dropped} nudge${dropped === 1 ? "" : "s"} dropped` : "",
	];
	return `${GLYPH.turn} ${parts.filter(Boolean).join(" · ")}`;
}

/**
 * One dim line after the last assistant block of a run that took at least three seconds or used a tool. It is a
 * session entry, so it is not part of the model's context and is drawn again when the session resumes. Subagents
 * never register it (`registerUi` returns first): their sessions have no transcript on screen.
 *
 * Also records whether a tool of the run ended under an interrupt, which the message that follows the aborted row
 * reads so the interrupt is said once.
 */
export function registerTurnLine(api: ExtensionAPI): void {
	let counting = false;
	const run = new TurnRun();
	api.registerEntryRenderer(TURN_LINE_TYPE, (entry, _options, theme) => {
		const text = turnLineText(entry.data);
		return text ? new Text(theme.fg("dim", text), 1, 0) : undefined;
	});
	// A run is every segment from the first start to `agent_settled`: retries, auto-continues, compaction resumes and
	// queued follow-ups start more segments inside it.
	api.on("agent_start", async (_event, ctx) => {
		if (!counting) {
			counting = true;
			// A run this module did not see settle (a replaced session) leaves no start behind.
			resetRun();
			beginRun(Date.now());
			run.begin(ctx.sessionManager);
		}
		setToolInterruptShown(false);
	});
	api.on("tool_execution_start", async (event) => {
		if (!event.parentToolCallId) run.tool();
	});
	api.on("tool_execution_end", async (event, ctx) => {
		if (!event.parentToolCallId && event.isError && ctx.signal?.aborted) setToolInterruptShown(true);
	});
	api.on("message_end", async (event, ctx) => {
		if (counting) run.message(event.message, modelLookup(ctx));
	});
	api.on("session_compact", async (event, ctx) => {
		if (!counting) return;
		run.entry(event.compactionEntry, modelLookup(ctx));
		run.recorded(ctx.sessionManager, modelLookup(ctx));
	});
	api.on("session_tree", async (event, ctx) => {
		if (counting) run.entry(event.summaryEntry, modelLookup(ctx));
	});
	api.on("agent_end", async (_event, ctx) => {
		if (counting) run.recorded(ctx.sessionManager, modelLookup(ctx));
	});
	api.on("agent_settled", async (event, ctx) => {
		// A queued steer or follow-up starts the next segment of this run; an abort drops the queue's turn to the user.
		if (!counting) return;
		const ms = settleRun(Date.now(), ctx.hasPendingMessages() && !event.aborted);
		if (ms === undefined) return;
		counting = false;
		const { tools, agents, cost, unpriced, cache } = run.totals();
		if (!ctx.hasUI) return;
		// Nudges the wake gate dropped after this run (`subagents/idle-items.ts`): the record is how they are measured.
		const gate = wakeGateOf(api);
		const dropped = gate.droppedCount();
		if (ms < MIN_TURN_MS && tools === 0 && dropped === 0) return;
		api.appendEntry(TURN_LINE_TYPE, {
			ms,
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

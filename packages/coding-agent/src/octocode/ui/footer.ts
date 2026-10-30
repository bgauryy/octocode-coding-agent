import os from "node:os";
import path from "node:path";
import { truncateToWidth, visibleWidth } from "@octocodeai/octocode-tui";
import type { ExtensionAPI, ExtensionContext } from "../../core/extensions/index.ts";
import type { StatusEntry } from "../../core/footer-data-provider.ts";
import { paintStatus } from "../../theme/status.ts";
import type { Theme } from "../../theme/theme.ts";
import { PERMISSION_ID, shortChip } from "../permission/mode.ts";
import { formatCost, formatDuration, formatTokens, formatTokenUsage, newPromptTokens } from "../shared/format.ts";
import { sanitizeTerminalText } from "../shared/sanitize.ts";
import { STATUS } from "../shared/status.ts";
import { autoCompactAt, compactionThinking } from "../shared/tokens.ts";
import {
	addReply,
	emptyTotals,
	modelLookup,
	type Spend,
	spendOf,
	type UsageTotals,
	unpricedModel,
} from "../shared/util.ts";
import { entrySpend, shortThinking } from "./footer/spend.ts";
import { registerReasoningNotice, registerUnpricedNotice } from "./footer/notices.ts";

/**
 * Octocode's two-line footer, in the order other coding agents converged on: line 1 is what the agent is and is doing
 * (model, permission mode, thinking, context, running agents, bash jobs, queued messages and a running hook; run time,
 * speed and cost on the right). Line 2 shows cwd, branch, session name, total tokens, compactions and other statuses.
 * Rendering is pure in (state, statuses, width); the activity indicator owns the live run clock.
 */

export interface FooterState {
	model?: string | undefined;
	/** The model's provider id: the same model id can come from several hosts (Anthropic, Bedrock, OpenRouter). */
	provider?: string | undefined;
	/** The model's provider is paid by subscription: the cost shown is an estimate, not a bill. */
	subscription?: boolean;
	/** Thinking level, only for models that reason. */
	thinking?: string | undefined;
	/**
	 * `limit` is where Octocode compacts automatically (the window less the built-in reserve); `percent`
	 * is of `limit`, and null right after compaction, until the next response.
	 */
	context?: { percent: number | null; limit: number } | undefined;
	/** The session's replies and every subagent's spend (foreground results, background reports): `input` is the whole prompt, shown as new tokens plus cache reads (`formatTokenUsage`); `cost` is Octocode's estimate. */
	usage: UsageTotals;
	/** Wall time of the current or last run, including tool calls and automatic compaction. */
	runMs?: number;
	running?: boolean;
	/** Completed compaction entries across the session, including resumed history. */
	compactions?: number;
	cwd: string;
	home?: string | undefined;
	sessionName?: string | undefined;
}

type Color = Parameters<Theme["fg"]>[0];
type Paint = Pick<Theme, "fg" | "bold">;

/** Status keys this footer places itself; any other extension's status is appended to line 2. */
const OWN = { permission: PERMISSION_ID, ...STATUS } as const;
const BAR_CELLS = 8;

/** An 8-cell gauge and its colour: green under half, yellow to 80%, red above. Any use fills at least one cell. */
export function contextBar(percent: number): { bar: string; color: Color } {
	const cells = Math.round((percent / 100) * BAR_CELLS);
	const filled = Math.min(BAR_CELLS, Math.max(percent > 0 ? 1 : 0, cells));
	return {
		bar: "▰".repeat(filled) + "▱".repeat(BAR_CELLS - filled),
		color: percent > 80 ? "error" : percent >= 50 ? "warning" : "success",
	};
}

/**
 * A part of a line. Parts drop (or switch to `short`) lowest `priority` first until the line fits; `keep` parts are
 * shortened last; on very narrow rows the highest priority part survives.
 */
interface Part {
	text: string;
	priority: number;
	keep?: boolean;
	short?: string;
}

function tilde(cwd: string, home: string | undefined): string {
	if (!home) return cwd;
	const relative = path.relative(home, cwd);
	return relative === ""
		? "~"
		: relative.startsWith("..") || path.isAbsolute(relative)
			? cwd
			: `~${path.sep}${relative}`;
}

const singleLine = (text: string) =>
	text
		.replace(/[\r\n\t\u2028\u2029]/g, " ")
		.replace(/ +/g, " ")
		.trim();
const plainRow = (text: string) => singleLine(sanitizeTerminalText(text));

/** Joins the left parts with dim dots and pushes the right parts to the edge, shortening and dropping until it fits. */
function fitLine(left: Part[], right: Part[], theme: Paint, width: number): string {
	const dot = theme.fg("dim", " · ");
	let parts = [...left, ...right].filter((part) => part.text !== "");
	const full = new Map(parts.map((part) => [part, part.text]));
	const render = () => {
		const l = left
			.filter((part) => parts.includes(part))
			.map((part) => part.text)
			.join(dot);
		const r = right
			.filter((part) => parts.includes(part))
			.map((part) => part.text)
			.join(dot);
		if (!r) return l;
		return `${l}${" ".repeat(Math.max(2, width - visibleWidth(l) - visibleWidth(r)))}${r}`;
	};
	while (visibleWidth(render()) > width) {
		const next = parts
			.filter((part) => !part.keep || part.short !== undefined)
			.sort((a, b) => a.priority - b.priority)[0];
		if (!next) break;
		if (next.short !== undefined) {
			next.text = next.short;
			delete next.short;
		} else parts = parts.filter((part) => part !== next);
	}
	// A kept model or work status can itself exceed the row. Shorten lower-priority parts before the permission chip,
	// rather than clipping the complete row from the right and hiding its most important status.
	while (visibleWidth(render()) > width && parts.length > 1) {
		const next = [...parts].sort((a, b) => a.priority - b.priority)[0];
		const room = visibleWidth(next.text) - (visibleWidth(render()) - width);
		if (room > 1) next.text = truncateToWidth(next.text, room, theme.fg("dim", "…"));
		else parts = parts.filter((part) => part !== next);
	}
	// Shortening a later part can make room for an earlier label's full text again.
	for (const part of [...parts].sort((a, b) => b.priority - a.priority)) {
		const short = part.text;
		part.text = full.get(part)!;
		if (visibleWidth(render()) > width) part.text = short;
	}
	return truncateToWidth(render(), Math.max(0, width), theme.fg("dim", "…"));
}

export function footerLines(
	state: FooterState,
	branch: string | null,
	statuses: ReadonlyMap<string, StatusEntry>,
	theme: Paint,
	width: number,
): string[] {
	// Statuses are data: each is painted in its tone with this frame's theme, so a theme switch reaches every one.
	const text = (key: string) => singleLine(statuses.get(key)?.text ?? "");
	const status = (key: string, shown = text(key)) => paintStatus({ text: shown, tone: statuses.get(key)?.tone }, theme);
	// `provider/id` when it fits; the short form drops the provider before cutting the id.
	const model = plainRow(
		state.model ? (state.provider ? `${state.provider}/${state.model}` : state.model) : "no model",
	);
	const shortModel = plainRow(truncateToWidth(state.model ?? "no model", Math.max(1, Math.floor(width / 3)), "…"));
	const context = state.context;
	// Context is a safety signal: it outranks the ephemeral status counters and shortens to `ctx 42%` before anything is dropped.
	let ctx: Part = { text: "", priority: 93, keep: true };
	if (context) {
		const window = formatTokens(context.limit);
		if (context.percent === null)
			ctx = { ...ctx, text: `${theme.fg("muted", "ctx")} ${theme.fg("dim", `? of ${window}`)}` };
		else {
			const { bar, color } = contextBar(context.percent);
			const percent = theme.fg(color, `${Math.round(context.percent)}%`);
			ctx = {
				...ctx,
				text: `${theme.fg("muted", "ctx")} ${theme.fg(color, bar)} ${percent} ${theme.fg("dim", `of ${window}`)}`,
				short: `${theme.fg("muted", "ctx")} ${percent}`,
			};
		}
	}
	const cost = formatCost(state.usage) + (formatCost(state.usage) && state.subscription ? " (sub)" : "");
	const top = fitLine(
		[
			{
				text: theme.fg("accent", model),
				priority: 94,
				keep: true,
				...(shortModel !== model ? { short: theme.fg("accent", shortModel) } : {}),
			},
			// The one home of the permission mode, with its shortcut: kept on a narrow terminal, shortened after the model.
			{
				text: status(OWN.permission),
				priority: 95,
				keep: true,
				short: status(OWN.permission, shortChip(text(OWN.permission))),
			},
			// Kept ahead of the status counters (90): a short form first, then the counters give way.
			{
				text: state.thinking ? theme.fg("muted", `thinking ${plainRow(state.thinking)}`) : "",
				priority: 91,
				keep: true,
				...(state.thinking ? { short: theme.fg("muted", shortThinking(plainRow(state.thinking))) } : {}),
			},
			ctx,
			{ text: status(OWN.team), priority: 90, keep: true },
			{ text: status(OWN.subagents), priority: 90, keep: true },
			{ text: status(OWN.bash), priority: 90, keep: true },
			// Messages waiting for the run to end: the user should see theirs did not get lost.
			{ text: status(OWN.queued), priority: 85, keep: true },
			// Last of the left parts: its clock grows, so nothing else on the row moves with it.
			{ text: status(OWN.hooks), priority: 80, keep: true },
		],
		[
			{
				text:
					state.runMs !== undefined && !state.running
						? theme.fg("muted", `last run ${formatDuration(state.runMs)}`)
						: "",
				priority: 85,
			},
			// The speed of the last run, beside its time: hidden while the next one works.
			{ text: text(OWN.speed) && !state.running ? theme.fg("dim", text(OWN.speed)) : "", priority: 10 },
			{ text: cost ? theme.fg("muted", cost) : "", priority: 40 },
		],
		theme,
		width,
	);

	const place = plainRow(tilde(state.cwd, state.home));
	// A third of the row, like the shortened model: long branch names fit wide terminals whole.
	const shownBranch = branch
		? plainRow(truncateToWidth(plainRow(branch), Math.max(1, Math.floor(width / 3)), "…"))
		: branch;
	const where = (dir: string) =>
		`${theme.fg("text", dir)}${shownBranch ? ` ${theme.fg("muted", `⎇ ${shownBranch}`)}` : ""}`;
	const usage = formatTokenUsage(state.usage);
	// Cache reads are re-reads of the conversation on every request: listed in the breakdown, not in the total.
	const spent = newPromptTokens(state.usage) + state.usage.output;
	// Nothing spent yet (a fresh session): no `0 tokens` placeholder.
	const tokens = spent > 0 || usage ? theme.fg("muted", `${formatTokens(spent)} tokens`) : "";
	const others = [...statuses]
		.filter(([key]) => !(Object.values(OWN) as string[]).includes(key))
		.sort(([a], [b]) => a.localeCompare(b));
	const bottom = fitLine(
		[
			{ text: where(place), priority: 100, keep: true, short: where(plainRow(path.basename(state.cwd))) },
			// Session names come from anywhere (RPC, other extensions); Octocode strips only newlines.
			{ text: state.sessionName ? theme.fg("muted", plainRow(state.sessionName)) : "", priority: 50 },
			{
				text: usage && tokens ? `${tokens} ${theme.fg("dim", `(${usage})`)}` : tokens,
				...(tokens ? { short: tokens } : {}),
				priority: 80,
			},
			{
				// Shown once there is one: zero compactions is the normal state, not news.
				text: state.compactions
					? theme.fg("muted", `${state.compactions} compaction${state.compactions === 1 ? "" : "s"}`)
					: "",
				priority: 75,
			},
			// Keep the workspace entry point when counts no longer fit; location and active-work statuses still win.
			{ text: status(OWN.backlog), priority: 20, keep: true, short: theme.fg("dim", "/octocode") },
			// As Octocode's own footer does (sanitizeStatusText): a line break inside a footer row breaks octocode-tui's row tracking.
			...others.map(([key]) => ({ text: status(key), priority: 20 })),
		],
		[],
		theme,
		width,
	);
	return [top, bottom];
}

/**
 * Replaces Octocode's footer with `footerLines`. The state is sampled on events (session start, each finished message,
 * model and thinking changes, compaction, tree moves), never inside render: context usage walks the whole session.
 * Octocode repaints the footer on every streamed token, so a frame whose inputs are unchanged reuses the built lines. It also
 * warns once when a reply's model has no pricing, and when the model declares no reasoning that a built-in twin declares.
 */
export function registerFooter(api: ExtensionAPI): void {
	registerUnpricedNotice(api);
	registerReasoningNotice(api);
	const state: FooterState = { usage: emptyTotals(), cwd: process.cwd(), home: os.homedir() };
	/** Moves whenever `state` changes, so the render cache knows its lines are stale. */
	let version = 0;
	let repaint: (() => void) | undefined;
	let startedAt: number | undefined;
	const sampleRun = () => {
		if (startedAt === undefined) return;
		state.runMs = Math.max(0, Date.now() - startedAt);
		version += 1;
		repaint?.();
	};
	const stop = () => {
		sampleRun();
		startedAt = undefined;
		state.running = false;
		version += 1;
		repaint?.();
	};
	const addSummary = (entry: unknown, ctx: ExtensionContext) => add(entrySpend(entry), ctx);
	const countCompactions = (ctx: ExtensionContext) => {
		state.compactions = ctx.sessionManager.getEntries().filter((entry) => entry.type === "compaction").length;
	};
	const add = (spend: Spend | undefined, ctx: ExtensionContext) => {
		if (!spend) return;
		version += 1;
		addReply(state.usage, spend.usage, unpricedModel(spend, modelLookup(ctx)) !== undefined);
	};
	const sample = (ctx: ExtensionContext) => {
		version += 1;
		const model = ctx.model;
		state.model = model?.id;
		state.provider = model?.provider;
		state.subscription = model ? ctx.modelRegistry.billedBySubscription(model.provider) : false;
		state.thinking = model?.reasoning ? api.getThinkingLevel() : undefined;
		const usage = ctx.getContextUsage();
		const limit = model ? autoCompactAt(model, compactionThinking(api)) : usage?.contextWindow;
		state.context = limit
			? { percent: typeof usage?.tokens === "number" ? (usage.tokens / limit) * 100 : null, limit }
			: undefined;
		state.cwd = ctx.cwd;
		state.sessionName = ctx.sessionManager.getSessionName?.();
		repaint?.();
	};
	// The footer is a terminal component (setFooter does nothing over RPC), so its bookkeeping runs only in the TUI.
	const refresh = async (_event: unknown, ctx: ExtensionContext) => {
		if (ctx.hasUI && ctx.mode === "tui") sample(ctx);
	};

	api.on("session_start", async (_event, ctx) => {
		if (!ctx.hasUI || ctx.mode !== "tui") return;
		stop();
		state.runMs = undefined;
		countCompactions(ctx);
		state.usage = emptyTotals();
		for (const entry of ctx.sessionManager.getEntries()) add(entrySpend(entry), ctx);
		sample(ctx);
		ctx.ui.setFooter((tui, theme, data) => {
			repaint = () => tui.requestRender();
			// Branch and status changes need no subscription here: the host asks for a frame on each footer-data change.
			let cached: { key: string; lines: string[] } | undefined;
			return {
				render: (width: number) => {
					const branch = data.getGitBranch();
					const statuses =
						data.getState?.().statuses ??
						new Map<string, StatusEntry>([...data.getExtensionStatuses()].map(([name, text]) => [name, { text }]));
					const entries = [...statuses].flatMap(([name, entry]) => [name, entry.text, entry.tone ?? ""]);
					const key = [version, width, branch ?? "", ...entries].join("\0");
					if (cached?.key !== key) cached = { key, lines: footerLines(state, branch, statuses, theme, width) };
					return cached.lines;
				},
				invalidate: () => {
					cached = undefined;
				},
				dispose: () => {
					repaint = undefined;
					stop();
				},
			};
		});
	});
	api.on("message_end", async (event, ctx) => {
		if (!ctx.hasUI || ctx.mode !== "tui") return;
		const spend = spendOf(event.message);
		add(spend, ctx);
		// Context usage walks the session: only a reply changes it. A subagent's result or report only adds usage.
		if (event.message.role === "assistant") sample(ctx);
		else if (spend) repaint?.();
	});
	api.on("session_tree", async (event, ctx) => {
		if (!ctx.hasUI || ctx.mode !== "tui") return;
		addSummary(event.summaryEntry, ctx);
		await refresh(event, ctx);
	});
	api.on("model_select", refresh);
	api.on("thinking_level_select", refresh);
	api.on("session_compact", async (event, ctx) => {
		if (!ctx.hasUI || ctx.mode !== "tui") return;
		countCompactions(ctx);
		addSummary(event.compactionEntry, ctx);
		await refresh(event, ctx);
	});
	api.on("agent_start", async (_event, ctx) => {
		if (!ctx.hasUI || ctx.mode !== "tui" || startedAt !== undefined) return;
		startedAt = Date.now();
		state.running = true;
		sampleRun();
	});
	api.on("agent_settled", async () => stop());
	api.on("session_shutdown", async () => stop());
	api.on("agent_end", refresh);
	api.on("session_info_changed", refresh);
}

import { contentText, normalizeContext } from "@octocodeai/octocode-ai";
import type { Api, AssistantMessage, Model, SimpleStreamOptions } from "@octocodeai/octocode-ai/compat";
import { completeSimple } from "@octocodeai/octocode-ai/compat";
import type { ExtensionAPI, ExtensionContext } from "../../core/extensions/index.ts";
import { GOAL_HEADING, summarySection } from "../../core/compaction/summary-format.ts";
import { splitSummary } from "../../core/compaction/summary-view.ts";
import { cleanTitle, SESSION_TITLE_MAX } from "../../core/session-manager/title.ts";
import { renderInstruction } from "../../core/prompt-template.ts";
import { currentCatalog } from "../subagents/catalog.ts";
import { resolveTier } from "../subagents/model.ts";

/** How long the title call may take before it is given up. */
// The call runs in the background and its write is guarded, so a slow model costs nothing; 5 s dropped 13 of 30 titles
// on a frontier model (.octocode/title-eval/NOTES.md, 2026-10-31).
const TITLE_TIMEOUT_MS = 20_000;
/** Most characters of the request the model sees. */
const INPUT_MAX = 2000;
/**
 * User messages tried before giving up when each names no task (`ping`, `hi`): the session keeps its fallback title,
 * the cleaned first prompt.
 */
const MAX_TRIES = 3;
/** What the model replies when the quoted request names no task. */
const NO_TASK = "NONE";

/** The title request (`instructions/workflows/title.md`). */
const TITLE_PROMPT = renderInstruction("workflows/title.md", { noTask: NO_TASK });

/** The part of `session_compact` the titler reads. */
type CompactedEvent = { compactionEntry: { summary: string } };

export type CompleteTitle = (
	model: Model<Api>,
	context: ReturnType<typeof normalizeContext>,
	options: SimpleStreamOptions,
) => Promise<AssistantMessage>;

/** The texts of the session's user messages with text, oldest first. */
function userMessages(ctx: ExtensionContext): string[] {
	const texts: string[] = [];
	for (const entry of ctx.sessionManager.getEntries?.() ?? []) {
		if (entry.type !== "message" || entry.message.role !== "user") continue;
		const { content } = entry.message;
		const text =
			typeof content === "string"
				? content
				: content.flatMap((block) => (block.type === "text" ? [block.text] : [])).join(" ");
		if (text.trim()) texts.push(text);
	}
	return texts;
}

/** One line of title from the model's reply: its first line without wrapping quotes, markdown or closing punctuation. */
export function titleFromReply(reply: string): string | undefined {
	const line = reply.split("\n").find((each) => each.trim()) ?? "";
	const bare = line.replace(/^[\s"'`*#_>-]+|[\s"'`*_.,;:!。]+$/g, "");
	const title = cleanTitle(bare, SESSION_TITLE_MAX);
	return title || undefined;
}

/**
 * One small-tier call for a title of a user request: no tools, no reasoning, `TITLE_TIMEOUT_MS`. `none` when the model
 * says the request names no task. Undefined when no model qualifies (the parent's price is unknown, or nothing cheaper
 * is connected), the model cannot be authenticated, the call fails or its reply is empty. Never rejects.
 */
async function requestTitle(
	ctx: ExtensionContext,
	request: string,
	signal: AbortSignal,
	complete: CompleteTitle = completeSimple,
): Promise<{ title: string } | "none" | undefined> {
	try {
		if (!ctx.model) return undefined;
		const available = ctx.modelRegistry.getAvailable();
		const chosen = resolveTier("small", available, ctx.model, currentCatalog());
		const model = chosen && available.find((each) => each.provider === chosen.provider && each.id === chosen.id);
		if (!model) return undefined;
		const auth = await ctx.modelRegistry.getApiKeyAndHeaders(model);
		if (!auth.ok) return undefined;
		const quoted = cleanTitle(request, INPUT_MAX).replaceAll("</request>", "");
		const reply = await complete(
			model,
			normalizeContext({
				messages: [
					{
						role: "user",
						content: [{ type: "text", text: `${TITLE_PROMPT}\n\n<request>\n${quoted}\n</request>` }],
						timestamp: Date.now(),
					},
				],
			}),
			{
				signal,
				maxTokens: 256,
				cacheRetention: "none",
				...(auth.apiKey ? { apiKey: auth.apiKey } : {}),
				...(auth.headers ? { headers: auth.headers } : {}),
				...(auth.env ? { env: auth.env } : {}),
			},
		);
		if (reply.stopReason === "error" || reply.stopReason === "aborted") return undefined;
		const title = titleFromReply(contentText(reply.content));
		if (title?.toUpperCase() === NO_TASK) return "none";
		return title ? { title } : undefined;
	} catch {
		return undefined;
	}
}

/**
 * Names an unnamed session after its first turn. `onAgentEnd` starts the call and returns at once, so a turn is never
 * delayed. The title is written through the host (`setSessionName(title, "auto")`, which appends to the live session
 * and announces the change) only while the session is still the one that asked and has no name: a switch, a shutdown
 * (`cancel`) or a name given meanwhile drops it. When the model says a request names no task (`ping`), a later turn
 * tries the next user message, up to `MAX_TRIES` messages; any other outcome ends the attempts for the process.
 * A session still unnamed when it is compacted (every request named no task, or the call failed) gets one more try,
 * from the summary's Goal section, once per session in the process; an auto title is never replaced.
 */
export function createAutoTitler(
	api: ExtensionAPI,
	options: { enabled: () => boolean; complete?: CompleteTitle; timeoutMs?: number },
): {
	onAgentEnd(ctx: ExtensionContext): Promise<void>;
	onCompact(ctx: ExtensionContext, event: CompactedEvent): Promise<void>;
	cancel(): void;
} {
	/** Per session: the index of the next user message to title; `MAX_TRIES` or more means done. */
	const next = new Map<string, number>();
	/** Sessions whose compaction summary was already asked for a title. */
	const fromSummary = new Set<string>();
	let epoch = 0;
	let running: AbortController | undefined;
	const cancel = () => {
		epoch++;
		running?.abort();
		running = undefined;
	};
	/** An unnamed, saved, interactive or RPC session with titles on. */
	const wantsTitle = (ctx: ExtensionContext): boolean =>
		options.enabled() &&
		(ctx.mode === "tui" || ctx.mode === "rpc") &&
		!ctx.sessionManager.getSessionName() &&
		Boolean(ctx.sessionManager.getSessionFile());
	/** One call for `request`; names the session unless the call says no task, fails, or the session changed meanwhile. */
	const attempt = async (ctx: ExtensionContext, id: string, request: string): Promise<"none" | undefined> => {
		const mine = epoch;
		const controller = new AbortController();
		running = controller;
		const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(options.timeoutMs ?? TITLE_TIMEOUT_MS)]);
		const result = await requestTitle(ctx, request, signal, options.complete);
		if (running === controller) running = undefined;
		if (result === "none") return "none";
		// A newer start or shutdown, another session or a name given meanwhile (by the user, always first) wins.
		if (
			typeof result !== "object" ||
			mine !== epoch ||
			ctx.sessionManager.getSessionId() !== id ||
			ctx.sessionManager.getSessionName()
		)
			return undefined;
		api.setSessionName(result.title, "auto");
		return undefined;
	};
	const onAgentEnd = async (ctx: ExtensionContext): Promise<void> => {
		try {
			if (!wantsTitle(ctx)) return;
			const id = ctx.sessionManager.getSessionId();
			const at = next.get(id) ?? 0;
			const request = at < MAX_TRIES ? userMessages(ctx)[at] : undefined;
			if (!request) return;
			next.set(id, MAX_TRIES);
			// A compaction meanwhile ended the turn-based attempts: a late "no task" must not reopen them.
			if ((await attempt(ctx, id, request)) === "none" && !fromSummary.has(id)) next.set(id, at + 1);
		} catch {
			// The title is a nicety: a stale context or a failed call leaves the session as it is.
		}
	};
	const onCompact = async (ctx: ExtensionContext, event: CompactedEvent): Promise<void> => {
		try {
			if (!wantsTitle(ctx)) return;
			const id = ctx.sessionManager.getSessionId();
			// The model's part only: the user messages code keeps after it may hold a line that looks like the heading.
			const goal = summarySection(splitSummary(event.compactionEntry.summary).body, GOAL_HEADING).join("\n");
			if (!goal || fromSummary.has(id)) return;
			fromSummary.add(id);
			// The turn-based attempts are over: the summary's goal is a better request than any later message.
			next.set(id, MAX_TRIES);
			await attempt(ctx, id, goal);
		} catch {
			// As above: a failed call leaves the session as it is.
		}
	};
	return { onAgentEnd, onCompact, cancel };
}

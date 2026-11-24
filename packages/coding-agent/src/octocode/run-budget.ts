import type { FeatureContext, FeatureSetup } from "../core/features/index.ts";
import { appendNoticeLine, noticeLines } from "../core/notice-line.ts";
import { renderPrompt } from "../core/prompt-template.ts";
import { billingFacts, meteredCost } from "../core/usage-totals.ts";
import type { Gate } from "./permission/judge.ts";
import { say } from "./shared/commands.ts";
import { limitsFor } from "./compaction/limits.ts";
import { publishUserNotice } from "./shared/user-notice.ts";
import { hardLimit } from "./subagents/budget.ts";

/**
 * The main session's bounds on one run (a prompt until the agent stops) and on what the session spends.
 *
 * Requests: one per assistant reply. At `limits.run.maxRequests` the next tool result carries a note; at 1.5 times it
 * the next tool call is refused and the run ends, unless a user is present and says to go on, which grants the limit
 * again. A subagent is not counted here: its parent holds its budget (`subagents/budget.ts`).
 *
 * Spend: `limits.cost.max` in metered dollars (a plan's share never counts, as in `spawn-limits.ts`). Past it the next
 * tool call is refused and the run ends; `limits.cost.warnAt` tells the user once. Children still running are not in
 * the sum until they report, so the bound can be passed by what they spend meanwhile.
 *
 * Cost: a counter per reply. The spend is summed over the session's new entries only, once per reply, and only when a
 * spend limit is set.
 */

/** The soft limit of a run nobody watches, when `limits.run.maxRequests` names none. With a user present: no limit. */
export const UNATTENDED_MAX_REQUESTS = 300;

/** The soft limit in force for this run; 0 is no limit. */
export function runRequestLimit(configured: number | undefined, hasUI: boolean): number {
	return configured ?? (hasUI ? 0 : UNATTENDED_MAX_REQUESTS);
}

const dollars = (amount: number): string => amount.toFixed(2);

/** Registers the counters; returns the step that refuses a tool call past a limit (`run-guards.ts`). */
export function registerRunBudget(api: FeatureSetup, isSubagent: boolean): Gate {
	let requests = 0;
	let granted = 0;
	let noted = false;
	let spent = 0;
	let counted = 0;
	const limits = (ctx: Pick<FeatureContext, "model">) => limitsFor(api, ctx.model);
	const soft = (ctx: FeatureContext): number =>
		isSubagent ? 0 : runRequestLimit(limits(ctx).run.maxRequests, ctx.hasUI);
	const resetRun = () => {
		requests = 0;
		granted = 0;
		noted = false;
	};
	api.bus.on("session_start", () => {
		resetRun();
		spent = 0;
		counted = 0;
	});
	api.bus.on("before_agent_start", resetRun);
	const tellOnce = (ctx: FeatureContext, key: string, text: string) => {
		const entries = ctx.sessionManager.getEntries();
		if (noticeLines(entries).some((line) => line.kind === "spend_limit" && line.key === key)) return;
		appendNoticeLine(api, { kind: "spend_limit", key, text });
		publishUserNotice(api.channels, { type: "spend_limit", title: "Octocode: spend limit", message: text });
	};
	const addSpend = (ctx: FeatureContext) => {
		const entries = ctx.sessionManager.getEntries();
		// A branch switch or a fork can leave fewer entries than were counted: sum again from the start.
		if (entries.length < counted) {
			spent = 0;
			counted = 0;
		}
		const facts = billingFacts(ctx);
		for (; counted < entries.length; counted++) spent += meteredCost(entries[counted], facts);
	};
	api.bus.on("message_end", async (event, ctx) => {
		const message = event.message;
		if (message.role === "assistant") {
			requests++;
			const { max, warnAt } = limits(ctx).cost;
			if (max === undefined && warnAt === undefined) return undefined;
			addSpend(ctx);
			if (warnAt !== undefined && spent >= warnAt)
				tellOnce(
					ctx,
					`warnAt=${warnAt}`,
					`This session has spent $${dollars(spent)}, past limits.cost.warnAt ($${dollars(warnAt)}).`,
				);
			return undefined;
		}
		const limit = soft(ctx);
		if (message.role !== "toolResult" || noted || limit <= 0 || requests < limit + granted) return undefined;
		noted = true;
		const note = renderPrompt("notices/run-budget/note.md", {
			requests,
			soft: limit + granted,
			hard: hardLimit(limit) + granted,
		});
		return { message: { ...message, content: [...message.content, { type: "text" as const, text: note }] } };
	});
	return async (event, ctx) => {
		if (event.parentToolCallId) return undefined;
		const max = limits(ctx).cost.max;
		if (max !== undefined && spent >= max) {
			const line = `Run stopped: this session has spent $${dollars(spent)}, past limits.cost.max ($${dollars(max)}). Raise it to go on.`;
			tellOnce(ctx, `max=${max}`, line);
			say(ctx, line, "error");
			ctx.failRun("Stopped by the spend limit.");
			return {
				block: true,
				terminate: true,
				reason: renderPrompt("notices/run-budget/spent.md", { spent: dollars(spent), max: dollars(max) }),
			};
		}
		const limit = soft(ctx);
		const hard = hardLimit(limit) + granted;
		if (limit <= 0 || requests < hard) return undefined;
		const goOn =
			ctx.hasUI &&
			(await ctx.ui.confirm(
				"Request budget reached",
				`This run has made ${requests} model requests (limits.run.maxRequests is ${limit}). Let it go on for ${limit} more?`,
			));
		if (goOn) {
			granted += limit;
			noted = false;
			return undefined;
		}
		say(ctx, `Request budget ended this run: ${requests} model requests, the limit is ${hard}.`, "error");
		ctx.failRun("Stopped by the request budget.");
		return {
			block: true,
			terminate: true,
			reason: renderPrompt("notices/run-budget/stopped.md", { requests, hard }),
		};
	};
}

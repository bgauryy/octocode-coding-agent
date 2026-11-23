import { type BillingFacts, billingFacts, meteredCost, runBilling } from "../../core/usage-totals.ts";
import type { SessionEntry } from "../../core/session-manager.ts";
import type { FeatureContext, FeatureSetup } from "../../core/features/index.ts";
import type { Settings } from "../../core/settings-schema.ts";
import { sessionChildren } from "../child-sessions/session-children.ts";
import { appendNoticeLine, noticeLines } from "../../core/notice-line.ts";
import { publishUserNotice } from "../shared/user-notice.ts";
import type { RunDetails } from "./run-types.ts";

/** What the limits read of the running subagents (`AgentRuns`). */
interface RunningChildren {
	running: ReadonlyMap<string, unknown>;
	live: ReadonlyMap<string, Pick<RunDetails, "cost">>;
}

/** A refusal: what the model reads, and the line the user is told once for this limit and value. */
interface SpawnRefusal {
	/** `maxCost=0.5`: the user hears of each limit once per session, and again only after it changed. */
	key: string;
	text: string;
	userLine: string;
}

const stillRunning = (runs: RunningChildren): string =>
	runs.running.size > 0
		? ` Running now, and left running: ${[...runs.running.keys()].join(", ")}.`
		: " None is running.";

/**
 * Why a new subagent may not start under the opt-in `subagents` limits, or undefined. Off unless configured, and a refusal
 * only: what runs keeps running and its report still arrives. `maxChildren` counts the children this session started,
 * a resume of one of them being no new child; `maxCost` is the money the session spent, its own and its finished
 * children's, plus what the running ones spent so far: what a plan paid for is an estimate, not money, and never counts.
 */
function spawnRefusal(
	limits: Settings["subagents"],
	entries: readonly SessionEntry[],
	runs: RunningChildren,
	facts: BillingFacts,
	resuming?: string,
): SpawnRefusal | undefined {
	const { maxChildren, maxCost } = limits ?? {};
	if (maxChildren !== undefined && resuming === undefined) {
		const started = new Set([...sessionChildren(entries).map((child) => child.id), ...runs.running.keys()]);
		if (started.size >= maxChildren)
			return {
				key: `maxChildren=${maxChildren}`,
				text: `Not started: this session has started ${started.size} subagents, and subagents.maxChildren is ${maxChildren}.${stillRunning(runs)} Do the work yourself, resume a finished child, or ask the user to raise the limit.`,
				userLine: `Subagent refused: this session started ${started.size} subagents, the subagents.maxChildren limit (${maxChildren}). Raise it to start more.`,
			};
	}
	if (maxCost !== undefined) {
		let spent = 0;
		for (const entry of entries) spent += meteredCost(entry, facts);
		for (const details of runs.live.values()) if (runBilling(details, facts) === "metered") spent += details.cost;
		if (spent >= maxCost)
			return {
				key: `maxCost=${maxCost}`,
				text: `Not started: this session has spent $${spent.toFixed(2)}, and subagents.maxCost is $${maxCost.toFixed(2)}.${stillRunning(runs)} Do the work yourself, or ask the user to raise the limit.`,
				userLine: `Subagent refused: this session has spent $${spent.toFixed(2)}, past the subagents.maxCost limit ($${maxCost.toFixed(2)}). Raise it to start more.`,
			};
	}
	return undefined;
}

/** The limits each session already told the user about in this process, by feature instance; the file holds the rest. */
const told = new WeakMap<object, Set<string>>();

/**
 * Throws the refusal when a `subagents` limit stops a new subagent. The model reads it in the tool result; the user is
 * told once per session for each limit and value, as a notice line (`core/notice-line.ts`) and a `spend_limit` notice
 * (the Notification hooks).
 */
export function refuseOverLimit(
	api: Pick<FeatureSetup, "session" | "settings" | "channels">,
	ctx: Pick<FeatureContext, "sessionManager" | "modelRegistry" | "model">,
	runs: RunningChildren,
	resuming?: string,
): void {
	const entries = ctx.sessionManager.getEntries();
	const refusal = spawnRefusal(api.settings.get().subagents, entries, runs, billingFacts(ctx), resuming);
	if (!refusal) return;
	const seen = told.get(api) ?? new Set<string>();
	told.set(api, seen);
	const key = `${ctx.sessionManager.getSessionId()}\n${refusal.key}`;
	const written = noticeLines(entries).some((line) => line.kind === "spend_limit" && line.key === refusal.key);
	if (!seen.has(key) && !written) {
		seen.add(key);
		appendNoticeLine(api, { kind: "spend_limit", key: refusal.key, text: refusal.userLine });
		publishUserNotice(api.channels, {
			type: "spend_limit",
			title: "Octocode: subagent limit reached",
			message: refusal.userLine,
		});
	}
	throw new Error(refusal.text);
}

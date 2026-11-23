import type { UsageDailyRow } from "../../../../db/src/api.ts";
import { recordProblem } from "../../core/diagnostics-log.ts";
import type { FeatureContext, FeatureSetup } from "../../core/features/index.ts";
import type { SessionEntry } from "../../core/session-manager.ts";
import { installSpendCapture, type SpendCapture } from "../../core/spend-capture.ts";
import { type BillingFacts, entryUsage, judgeBilling } from "../../core/usage-totals.ts";
import { sharedAgentDbWriter } from "../../storage/database.ts";
import { readWorkspaceIdentity } from "../../storage/workspace.ts";
import { unpricedModel } from "../shared/util.ts";
import { spent, UsageBatch, type UsageRequest } from "./batch.ts";

/** The local calendar day of `at`, `YYYY-MM-DD`: the day `/usage` files a request under. */
export function localDay(at: Date): string {
	const two = (value: number) => String(value).padStart(2, "0");
	return `${at.getFullYear()}-${two(at.getMonth() + 1)}-${two(at.getDate())}`;
}

type Post = (rows: UsageDailyRow[]) => Promise<void>;

/**
 * The rows waiting for the database writer. A failed write (a busy or closed writer) keeps them for the next flush and is
 * logged once, until a write succeeds again: a turn never fails for it and no request is lost to it.
 */
class DailyUsage {
	readonly batch = new UsageBatch();
	private warned = false;
	private readonly post: Post;
	private readonly failed: (error: unknown) => void;

	constructor(post: Post, failed: (error: unknown) => void) {
		this.post = post;
		this.failed = failed;
	}

	async flush(): Promise<void> {
		const rows = this.batch.take();
		if (rows.length === 0) return;
		try {
			await this.post(rows);
			this.warned = false;
		} catch (error) {
			this.batch.restore(rows);
			if (this.warned) return;
			this.warned = true;
			this.failed(error);
		}
	}
}

/** The process's rows: a later session's flush writes what an earlier one's late requests added. */
let processDaily: DailyUsage | undefined;

/**
 * The `usage_daily` request an appended entry is: a reply, a `usage` entry (a request made outside a reply: a summary
 * attempt, a cache refresh, a side question, a helper call), or the summarizing call a `compaction` or `branch_summary`
 * entry carries, which names no model: it is filed under the model of the session's latest reply (its model at start
 * before one). A subagent's result or report adds nothing: an Octocode child
 * records its own requests in its process, and a runner's turn is recorded where it ran (`captureSpend`).
 */
function requestOf(
	entry: SessionEntry,
	session: { provider: string; id: string } | undefined,
): Omit<UsageRequest, "billing" | "unpriced"> | undefined {
	if (entry.type === "message" && entry.message.role === "assistant") {
		const { provider, model, responseModel, usage } = entry.message;
		return { provider, model: responseModel ?? model, kind: "reply", usage };
	}
	if (entry.type === "usage")
		return { provider: entry.provider, model: entry.model, kind: entry.kind, usage: entry.usage };
	if ((entry.type === "compaction" || entry.type === "branch_summary") && entry.usage)
		return {
			provider: session?.provider ?? "unknown",
			model: session?.id ?? "unknown",
			kind: entry.type,
			usage: entry.usage,
		};
	return undefined;
}

interface UsageRecordingOptions {
	/** Where a batch of rows goes; the agent database's writer (`usage-daily`) by default, for the whole process. */
	post?: Post;
	/** Told of a failed write, once until one succeeds; the problem log (`/status`) by default. */
	failed?: (error: unknown) => void;
	now?: () => Date;
}

/**
 * Spend by day (`usage_daily`, read by `/usage`): every model request this process makes, added to its local day's row
 * under its provider, model, kind and billing. The requests come from one place, the session store's append
 * (`core/spend-capture.ts`): a reply, a `usage` entry, a summary, each once, by the process that made it, including a
 * late receipt written to a session this one replaced. Records merged in from another process writing the same session
 * are never counted here. Who paid is what the append stored on the entry. Rows are batched and written through the
 * database writer at the end of each run, a compaction and the session's start and end, so a reply never waits on the
 * database. A session that is not saved records nothing, like the session index. Returns what removes the capture.
 */
export function registerUsageRecording(api: FeatureSetup, options: UsageRecordingOptions = {}): () => void {
	const daily = options.post
		? new DailyUsage(options.post, options.failed ?? ((error) => recordProblem("usage", error)))
		: (processDaily ??= new DailyUsage(
				(rows) => sharedAgentDbWriter().post({ kind: "usage-daily", rows }),
				options.failed ?? ((error) => recordProblem("usage", error)),
			));
	const now = options.now ?? (() => new Date());
	let uninstall = () => {};
	/** The session's model, kept from events so a late append never reads a context the session replaced. */
	let session: { provider: string; id: string } | undefined;
	const capture = (registry: FeatureContext["modelRegistry"]): SpendCapture => {
		const facts = (): BillingFacts => ({
			billingOf: (provider, scope) => registry.getProviderBilling(provider, scope),
			provider: session?.provider,
		});
		const add = (cwd: string, request: Omit<UsageRequest, "unpriced">) =>
			daily.batch.add(localDay(now()), readWorkspaceIdentity(cwd)?.id ?? "", {
				...request,
				unpriced:
					unpricedModel({ ...request, role: "usage" }, (provider, id) => registry.find(provider, id)) !== undefined,
			});
		return {
			billing: (entry) => (entryUsage(entry) ? judgeBilling(entry, facts()) : undefined),
			appended: (entry, cwd) => {
				const request = requestOf(entry, session);
				if (request && spent(request.usage) && entry.billing) add(cwd, { ...request, billing: entry.billing });
			},
			spent: ({ cwd, kind, provider, model, usage, billing }) => {
				if (spent(usage)) add(cwd, { kind, provider, model, usage, billing: billing ?? facts().billingOf(provider) });
			},
		};
	};

	api.bus.on("session_start", async (_event, ctx) => {
		session = ctx.model ? { provider: ctx.model.provider, id: ctx.model.id } : undefined;
		uninstall();
		uninstall = installSpendCapture(capture(ctx.modelRegistry));
		// Late requests the session before this one recorded after its end.
		await daily.flush();
	});
	api.bus.on("message_end", async (event) => {
		const message = event.message;
		if (message.role === "assistant")
			session = { provider: message.provider, id: message.responseModel ?? message.model };
	});
	api.bus.on("agent_end", async () => daily.flush());
	api.bus.on("session_compact", async () => daily.flush());
	api.bus.on("session_shutdown", async () => daily.flush());
	return () => uninstall();
}

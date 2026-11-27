import type { ApplicationEvent } from "@octocodeai/octocode-contracts";
import type { AgentSessionEvent } from "../../agent-session/types.ts";
import type { ApplicationSession } from "../session-port.ts";
import type { ApplicationStateStore } from "../state.ts";
import { applicationModels, publishModelChange } from "./model.ts";
import { type QuotaSource, sessionQuota } from "./quota.ts";
import { UsageTally } from "./usage.ts";

/** Session events that arrive many times a second and change neither the model, its spend nor the model list. */
const STREAMING: ReadonlySet<string> = new Set([
	"message_update",
	"tool_execution_update",
	"bash_execution_update",
	"compaction_progress",
	"model_wait",
]);

const differs = (first: unknown, second: unknown): boolean => JSON.stringify(first) !== JSON.stringify(second);

/** A reply ended (its response's quota headers were read) or the run settled (a CLI's events came in). */
const quotaMayMove = (event: AgentSessionEvent): boolean =>
	(event.type === "message_end" && event.message.role === "assistant") || event.type === "agent_settled";

/**
 * Publishes the session's model, spend, quota and model list when they change (`session.model`, `session.usage`,
 * `session.quota`, `session.models`). The model and spend are checked after every session event but a streamed chunk;
 * the quota when a reply ends, the run settles and on a full check; the model list, which changes only with sign-ins
 * and provider settings, when a run settles and on a full check. While nothing follows them (`hold`) a check is only
 * noted, and the next one is a full check: what a view that arrives then sees, as a view attaching to a session does.
 */
export class SessionFacts {
	private readonly usage = new UsageTally();
	/** A check was skipped since the last one (`hold`): the next is a full check. */
	private due = false;
	private readonly session: () => ApplicationSession;
	private readonly state: ApplicationStateStore;
	private readonly quotas: QuotaSource | undefined;

	/** `quotas`: the quota readings to publish; the process's own (`providerQuotas`) without it. */
	constructor(session: () => ApplicationSession, state: ApplicationStateStore, quotas?: QuotaSource) {
		this.session = session;
		this.state = state;
		this.quotas = quotas;
	}

	/** Forget the entries read: the next check reads the session's spend from its first entry. */
	reset(): void {
		this.usage.reset();
	}

	/** Nothing follows the facts: note that `event` (none: a full check) would have been checked, instead of checking. */
	hold(event?: AgentSessionEvent): void {
		if (!event || !STREAMING.has(event.type)) this.due = true;
	}

	/** The check `hold` skipped, as a full one, when one is due: before a view reads or starts following the facts. */
	catchUp(publish: (event: ApplicationEvent) => void): void {
		if (this.due) this.sync(publish);
	}

	/** Publish what changed. Without `event` (attaching, a changed session, a model command) everything is checked. */
	sync(publish: (event: ApplicationEvent) => void, received?: AgentSessionEvent): void {
		// A held check is made in full: the events it stands for may have moved the quota, the context or the model list.
		const event = this.due ? undefined : received;
		this.due = false;
		if (event && STREAMING.has(event.type)) return;
		const session = this.session();
		publishModelChange(session, this.state, publish);
		// Context use reads the session projection: measured when a run settles and on a full check, not per event.
		const usage = this.usage.read(session, { context: !event || event.type === "agent_settled" });
		if (usage && differs(usage, this.state.getState().usage)) publish({ type: "session.usage", usage });
		if (!event || quotaMayMove(event)) {
			const quota = sessionQuota(this.usage.providers(), session.model?.provider, this.quotas);
			// None published and none in force: no frame for an empty list.
			if (differs(quota, this.state.getState().quota ?? [])) publish({ type: "session.quota", quota });
		}
		if (event && event.type !== "agent_settled") return;
		const models = applicationModels(session);
		if (models && differs(models, this.state.getState().models)) publish({ type: "session.models", models });
	}
}

/**
 * What follows a turn that ended on a usage limit with no `retry.fallbackModels` entry left (F4). A usage limit lasts
 * hours to a month, so retrying is no answer; who decides depends on who is watching.
 *
 * - Interactive (the terminal, and /web through the same dialog): a choice. Wait and resume at the reset (offered when
 *   the reset time is known), switch to the best connected model of another provider (and optionally save it as a
 *   fallback), pick a model with `/model`, or stop.
 * - Unattended (print mode, RPC and ACP hosts, children): wait in place when the reset falls within
 *   `retry.maxUsageWaitMs` (default 0), else fail with an error that names the reset. A `USAGE_LIMIT_ENTRY` session
 *   entry carries the reset time to a parent that runs this session as its child.
 */

import { errorMessage } from "@octocodeai/octocode-contracts/guards";
import type { AssistantMessage, Model } from "@octocodeai/octocode-ai/compat";
import { resetClock } from "@octocodeai/octocode-common/time";
import type { SessionUI } from "../features/types.ts";
import { type ProviderQuotas, providerQuotas } from "../model-runtime/quota-request.ts";
import { billedText } from "./fallback-switch.ts";
import type { SessionInternals } from "./host.ts";
import { recordRunFailure } from "./run-outcome.ts";
import {
	resetText,
	USAGE_LIMIT_ENTRY,
	USAGE_RESUME_GRACE_MS,
	type UsageLimitRecord,
	usageLimitResetsAt,
	waitSpan,
} from "./usage-limit-facts.ts";
import { nextConnectedModel } from "./usage-limit-switch.ts";
import { ResumeTimer, runAbortSignal, waitUntil } from "./usage-limit-wait.ts";

/** The status key of the waiting line. */
const STATUS_KEY = "usage-limit";
/** What a resumed turn sends: the turn it failed is in the context already. */
const RESUME_PROMPT = "Continue";

type Choice = "wait" | "switch" | "save" | "pick" | "stop";

export interface UsageLimitHost extends Pick<SessionInternals, "session" | "run" | "emit"> {
	/** Continue the failed turn on the same model (`run.failedResponse` set); false when the run was stopped. */
	resume(message: AssistantMessage): boolean;
	/** Select `model` for the rest of the session with the fallback notice and entry, then continue the turn. */
	continueOn(message: AssistantMessage, model: Model<any>): Promise<boolean>;
}

export class UsageLimitRecovery {
	private readonly host: UsageLimitHost;
	private readonly quotas: Pick<ProviderQuotas, "current">;
	private readonly resumeTimer: ResumeTimer;

	constructor(host: UsageLimitHost, quotas: Pick<ProviderQuotas, "current"> = providerQuotas) {
		this.host = host;
		this.quotas = quotas;
		this.resumeTimer = new ResumeTimer({
			agent: host.session.agent,
			sessionId: () => host.session.sessionManager.getSessionId(),
			status: (text) => this.ui().setStatus(STATUS_KEY, text, text ? "warning" : undefined),
		});
	}

	/** Whether a resume at the reset is armed. */
	get waiting(): boolean {
		return this.resumeTimer.armed;
	}

	/** The mode's UI as features see it: a dialog through it also reaches /web (`ui_prompt_start`, `answer`). */
	private ui(): SessionUI {
		return this.host.session.featureHost.getUIContext();
	}

	/**
	 * Decide what follows `message`, a usage-limit failure no fallback took.
	 * @returns true if the caller should continue the agent with `run.failedResponse` set
	 */
	async recover(message: AssistantMessage): Promise<boolean> {
		const { session, run } = this.host;
		if (run.agentRunAbortRequested) return false;
		const resetsAt = usageLimitResetsAt(message, this.quotas.current(message.provider));
		const context = session.featureHost.createContext();
		return context.mode === "tui" && context.hasUI ? this.ask(message, resetsAt) : this.unattended(message, resetsAt);
	}

	private async ask(message: AssistantMessage, resetsAt: number | undefined): Promise<boolean> {
		const { session, run } = this.host;
		const now = Date.now();
		const ui = this.ui();
		const candidate = await nextConnectedModel(
			{
				modelRuntime: session.modelRuntime,
				settingsManager: session.settingsManager,
				contextTokens: session.getContextUsage()?.tokens ?? undefined,
			},
			{ provider: message.provider, id: message.model },
		);
		const resumeAt = resetsAt === undefined ? undefined : resetsAt + USAGE_RESUME_GRACE_MS;
		const options = new Map<string, Choice>();
		if (resumeAt !== undefined) options.set(`Wait and resume at ${resetClock(resumeAt, now)}`, "wait");
		const name = candidate ? `${candidate.provider}/${candidate.id}` : "";
		if (candidate) {
			options.set(
				`Switch to ${name} (${billedText(session.modelRuntime.getProviderBilling(candidate.provider))})`,
				"switch",
			);
			options.set(`Switch to ${name} and save it to retry.fallbackModels`, "save");
		}
		options.set("Pick a model (/model)", "pick");
		options.set("Stop", "stop");
		const title = `Usage limit on ${message.provider} — ${resetText(resetsAt, now)}`;
		// A Stop from elsewhere (another client, a peer) while the choice is open dismisses it.
		const stopped = runAbortSignal(run);
		let answer: string | undefined;
		try {
			answer = await ui.select(title, [...options.keys()], { signal: stopped.signal });
		} finally {
			stopped.stop();
		}
		const choice = (answer !== undefined && options.get(answer)) || "stop";
		if (run.agentRunAbortRequested) return false;
		if ((choice === "switch" || choice === "save") && candidate) {
			if (choice === "save") session.settingsManager.addRetryFallbackModel(name);
			return this.host.continueOn(message, candidate);
		}
		if (choice === "wait" && resumeAt !== undefined) {
			const clock = resetClock(resumeAt, Date.now());
			this.resumeTimer.arm(resumeAt, `Usage limit on ${message.provider} · resumes ${clock}`, () => this.resumeNow());
			ui.notify(`Resuming at ${clock} (in ${waitSpan(resumeAt - Date.now())}). Sending a message cancels the wait.`);
		} else if (choice === "pick") ui.setEditorText("/model");
		return false;
	}

	/** The reset came: continue the failed turn, unless something else runs now (that run cancelled the timer first). */
	private resumeNow(): void {
		const { session } = this.host;
		if (!session.isIdle) return;
		void session
			.prompt(RESUME_PROMPT)
			.catch((error: unknown) =>
				this.ui().notify(`Could not resume after the usage limit: ${errorMessage(error)}`, "error"),
			);
	}

	private async unattended(message: AssistantMessage, resetsAt: number | undefined): Promise<boolean> {
		const { session, run } = this.host;
		const now = Date.now();
		const maxWaitMs = session.settingsManager.getRetryMaxUsageWaitMs();
		const resumeAt = resetsAt === undefined ? undefined : resetsAt + USAGE_RESUME_GRACE_MS;
		const line = `Usage limit on ${message.provider} ${resetText(resetsAt, now)}`;
		if (resumeAt !== undefined && maxWaitMs > 0 && resumeAt - now <= maxWaitMs) {
			this.ui().notify(`${line}; waiting for it (retry.maxUsageWaitMs).`, "warning");
			const stopped = runAbortSignal(run);
			try {
				return (await waitUntil(resumeAt, stopped.signal)) && this.host.resume(message);
			} finally {
				stopped.stop();
			}
		}
		const advice =
			resetsAt === undefined
				? ""
				: maxWaitMs > 0
					? " That is later than retry.maxUsageWaitMs waits."
					: " Set retry.maxUsageWaitMs to wait for it.";
		recordRunFailure(run.outcome, `${message.errorMessage ?? "Usage limit reached"}\n${line}.${advice}`);
		const record: UsageLimitRecord = {
			provider: message.provider,
			model: `${message.provider}/${message.model}`,
			...(resetsAt === undefined ? {} : { resetsAt }),
		};
		const entry = session.sessionManager.getEntry(session.sessionManager.appendCustomEntry(USAGE_LIMIT_ENTRY, record));
		if (entry) this.host.emit({ type: "entry_appended", entry });
		return false;
	}
}

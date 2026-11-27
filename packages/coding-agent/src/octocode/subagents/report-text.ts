import { renderPrompt } from "../../core/prompt-template.ts";
import { fenceUntrusted, headerText } from "../shared/fence.ts";
import { USER_SENDER } from "../shared/messages.ts";
import { noticeLines } from "./render.ts";
import type { RunRoute } from "./claim.ts";
import type { RanModel } from "./event-ran.ts";
import { routeSummary } from "./model.ts";
import { routeThinking, thinkingSuffix, withThinking } from "../render/route-thinking.ts";
import { isCredentialError, isRateLimitedText, isRetryableErrorText, isUsageLimitError } from "@octocodeai/octocode-ai";
import { refusedBeforeWork, spentNothing } from "./provider-health.ts";
import type { RunDetails } from "./run-types.ts";
import { resetText } from "../../core/agent-session/usage-limit-facts.ts";
import type { Usage } from "@octocodeai/octocode-ai";
import { runFooter } from "./tracking.ts";
import { referenceProvider } from "../../core/model-reference.ts";

/** Who stopped the runs of a permission change: their reports say so, so the model asks before starting them again. */
export const PERMISSION_STOP = "a permission change";

/**
 * A child report as the model reads it: the header and footer are this process's own words (the agent's name, role
 * and goal, its run statistics, what the parent did), and the child's text sits in the shared fence for untrusted text,
 * so a report cannot pose as the user, a teammate or the system.
 */
export function reportMessage(header: string, body: string, footer: string[] = []): string {
	const tail = footer
		.map((part) => part.trim())
		.filter(Boolean)
		.join("\n\n");
	return fenceUntrusted(headerText(header, 400), body, tail ? { footer: tail } : {});
}

/** A foreground result's lines about the child itself (no fence there): its notices, its compactions, and where its conversation is saved when it failed. */
export const foregroundExtras = (details: RunDetails, failed: boolean): string => {
	const lines = [...noticeLines(details), ...runFooter(details, failed)].filter(Boolean);
	return lines.length > 0 ? `\n\n${lines.join("\n")}` : "";
};

const withoutLevel = (model: string): string => model.slice(0, model.length - thinkingSuffix(model).length);

/**
 * The model and thinking level a run used and what chose them: `Ran on p/m, low thinking (profile researcher: small:low).`
 * `ran` is the model of the child's last assistant message: when `retry.fallbackModels` moved the child off the planned
 * model, the line names the model that answered (at the level its fallback entry names, else the planned one), the planned
 * model and, when the child recorded the switch, its cause and a billing change:
 * `Ran on p/n, medium thinking (fallback from p/m: hit a usage limit; billing changed).`
 */
export function ranOn(route: RunRoute, ran?: RanModel): string {
	if (!route.model) return "";
	const planned = withoutLevel(route.model);
	if (!ran || ran.model === planned) return `Ran on ${routeSummary(route)}.`;
	const entry = route.fallbackModels?.find((candidate) => withoutLevel(candidate) === ran.model);
	const level = routeThinking(entry) ?? routeThinking(route.model);
	const switched = ran.fallback;
	const why = switched ? `: ${switched.reason}${switched.billingChanged ? "; billing changed" : ""}` : "";
	return `Ran on ${routeSummary({ model: level ? withThinking(ran.model, level) : ran.model, via: `fallback from ${planned}${why}` })}.`;
}

/** ` · ran on p/m, low thinking (…)`: a finished report's route, folded into its header line (empty with no route). */
export const routeSuffix = (line: string): string =>
	line ? ` · ran on ${line.slice("Ran on ".length).replace(/\.$/u, "")}` : "";

/** What the parent does after a failed subagent; its partial answer, if any, was never checked. */
export const FAILED_NEXT = renderPrompt("notices/subagents/failed-narrower.md");

/** An unknown or unavailable model id: the provider's other models may work. */
const MODEL_UNKNOWN =
	/no such model|unknown model|model[^\n]{0,40}(?:not found|not available|does not exist|not supported)/i;

/**
 * Why a provider refused the route, which decides the advice: a usage limit or no funds (the key is fine; the shared
 * `isUsageLimitError` the session retry uses), the credential (fix it with /providers), or the request or model
 * (another model may work). All of them fail the same way again on this route.
 */
function refusalKind(error: string, nothingSpent: boolean): "billing" | "credential" | "request" | undefined {
	if (isUsageLimitError(error)) return "billing";
	if (isCredentialError(error)) return "credential";
	if (MODEL_UNKNOWN.test(error) || refusedBeforeWork(error, nothingSpent)) return "request";
	return undefined;
}

const providerOf = (model: string) => referenceProvider(model) ?? "";

/**
 * What the parent does after a failed subagent, then the model it ran on and what chose it. When the provider refused
 * the route (no funds, the credential, the request or the model), a narrower task cannot help: the advice names this
 * session's model to pass as `model` or what to fix, by cause. A rate limit and a transient failure (overloaded, a
 * dropped connection) are the shared classifiers' verdicts, the ones the start gate and the session retry act on: every
 * concurrent run shares a rate limit, so that advice says to start fewer; a transient failure outlasted the child's own
 * retries, so its advice says to wait or move to another provider. `resetsAt` is when the child's usage limit resets,
 * from its `USAGE_LIMIT_ENTRY`: the advice names it.
 */
export function failedNext(
	route: RunRoute,
	error: string,
	partial: boolean,
	nothingSpent = false,
	ran?: RanModel,
	resetsAt?: number,
): string {
	const ranLine = ranOn(route, ran);
	const kind = refusalKind(error, nothingSpent);
	// The provider that refused is the one that answered last: a `retry.fallbackModels` switch moves a child off its route.
	const model = ran?.model ?? route.model;
	const provider = model ? providerOf(model) : "";
	const advice = renderPrompt("notices/subagents/failed-next.md", {
		billing: kind === "billing",
		credential: kind === "credential",
		request: kind === "request",
		rateLimited: isRateLimitedText(error),
		transient: isRetryableErrorText(error),
		narrower: FAILED_NEXT,
		other: Boolean(route.parent) && provider !== providerOf(route.parent ?? ""),
		parent: route.parent,
		provider: provider || "provider",
		resets: kind === "billing" && resetsAt !== undefined ? resetText(resetsAt, Date.now()) : "",
		partial,
	});
	return [advice, ranLine].filter(Boolean).join("\n");
}

/** {@link failedNext} for a failed run: its partial answer, its spend, the model it ended on and its usage-limit reset. */
export const failedAdvice = (
	route: RunRoute,
	error: string,
	outcome: { text?: string; usage?: Usage },
	details: Pick<RunDetails, "ran" | "usageLimit">,
): string =>
	failedNext(
		route,
		error,
		Boolean(outcome.text),
		spentNothing(outcome.usage),
		details.ran,
		details.usageLimit?.resetsAt,
	);

/** Why a foreground run that someone stopped ended: who stopped it, so the model does not just start it again. */
export function stoppedError(id: string, by: string): Error {
	if (by === USER_SENDER) return new Error(`Subagent ${id} was stopped by the user.`);
	return new Error(
		`Subagent ${id} was stopped by ${by}.${by === PERMISSION_STOP ? " Ask the user before starting it again." : ""}`,
	);
}

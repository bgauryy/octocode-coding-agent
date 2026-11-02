import { fenceUntrusted, headerText } from "../shared/fence.ts";
import { USER_SENDER } from "../shared/messages.ts";
import { noticeLines } from "./render.ts";
import type { RunRoute } from "./claim.ts";
import { routeSummary } from "./model.ts";
import type { RunDetails } from "./run-types.ts";
import { runFooter } from "./tracking.ts";

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

/** The model and thinking level a run used and what chose them: `Ran on p/m, low thinking (profile researcher: small:low).` */
export const ranOn = (route: RunRoute): string => (route.model ? `Ran on ${routeSummary(route)}.` : "");

/** What the parent does after a failed subagent; its partial answer, if any, was never checked. */
export const FAILED_NEXT = "Retry with a narrower task or do the work yourself.";
const PARTIAL_UNVERIFIED = " The partial answer is unverified.";

/**
 * A provider refusing the credential or the model (an expired key, no access, an unknown id): retrying the same route
 * fails the same way, whatever the task.
 */
const MODEL_REFUSED =
	/\b(?:401|403)\b|unauthori[sz]ed|forbidden|authenticat|api[ _-]?key|credential|permission[ _]denied|no such model|unknown model|model[^\n]{0,40}(?:not found|not available|does not exist|not supported)|insufficient[ _](?:quota|credit|balance)|billing/i;

/** The provider throttled the request: every concurrent run shares its limit, so an immediate retry hits it again. */
const RATE_LIMITED = /\b429\b|rate[ _-]?limit|too many requests|overloaded/i;

const RATE_LIMIT_NEXT =
	"The provider rate-limited the request. Wait before retrying, start fewer subagents at once (OCTOCODE_MAX_SUBAGENTS lowers the limit), or do the work yourself.";

const providerOf = (model: string) => model.slice(0, Math.max(0, model.indexOf("/")));

/**
 * What the parent does after a failed subagent, then the model it ran on and what chose it. When the provider refused
 * the credential or the model, a narrower task cannot help: the advice names this session's model to pass as `model`
 * (its credential works) or the credential to fix.
 */
export function failedNext(route: RunRoute, error: string, partial: boolean): string {
	const ran = ranOn(route);
	const unverified = partial ? PARTIAL_UNVERIFIED : "";
	if (RATE_LIMITED.test(error) && !MODEL_REFUSED.test(error))
		return [`${RATE_LIMIT_NEXT}${unverified}`, ran].filter(Boolean).join("\n");
	if (!MODEL_REFUSED.test(error)) return [`${FAILED_NEXT}${unverified}`, ran].filter(Boolean).join("\n");
	const provider = route.model ? providerOf(route.model) : "";
	const fix = `ask the user to fix ${provider ? `the ${provider} credential` : "the provider credential"} with /login`;
	const other = route.parent && provider !== providerOf(route.parent);
	const advice = other
		? `The provider refused the credential or the model, so the same route fails again. Retry with model: "${route.parent}" (this session's model) or ${fix}.`
		: `The provider refused the credential or the model, so the same route fails again. To fix it, ${fix}, or pass another provider's model as model.`;
	return [`${advice}${unverified}`, ran].filter(Boolean).join("\n");
}

/** Why a foreground run that someone stopped ended: who stopped it, so the model does not just start it again. */
export function stoppedError(id: string, by: string): Error {
	if (by === USER_SENDER) return new Error(`Subagent ${id} was stopped by the user.`);
	return new Error(
		`Subagent ${id} was stopped by ${by}.${by === PERMISSION_STOP ? " Ask the user before starting it again." : ""}`,
	);
}

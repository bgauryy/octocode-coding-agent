import { renderInstruction } from "../../core/prompt-template.ts";
import { fenceUntrusted, headerText } from "../shared/fence.ts";
import { USER_SENDER } from "../shared/messages.ts";
import { noticeLines } from "./render.ts";
import type { RunRoute } from "./claim.ts";
import { routeSummary } from "./model.ts";
import { BILLING_ERROR, CREDENTIAL_ERROR, refusedBeforeWork } from "./provider-health.ts";
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
export const FAILED_NEXT = renderInstruction("notices/subagents/failed-narrower.md");

/** An unknown or unavailable model id: the provider's other models may work. */
const MODEL_UNKNOWN =
	/no such model|unknown model|model[^\n]{0,40}(?:not found|not available|does not exist|not supported)/i;

/**
 * Why a provider refused the route, which decides the advice: no funds (the key is fine), the credential (fix it with
 * /providers), or the request or model (another model may work). All of them fail the same way again on this route.
 */
function refusalKind(error: string, nothingSpent: boolean): "billing" | "credential" | "request" | undefined {
	if (BILLING_ERROR.test(error)) return "billing";
	if (CREDENTIAL_ERROR.test(error)) return "credential";
	if (MODEL_UNKNOWN.test(error) || refusedBeforeWork(error, nothingSpent)) return "request";
	return undefined;
}

/** The provider throttled the request: every concurrent run shares its limit, so an immediate retry hits it again. */
const RATE_LIMITED = /\b429\b|rate[ _-]?limit|too many requests|overloaded/i;

const providerOf = (model: string) => model.slice(0, Math.max(0, model.indexOf("/")));

/**
 * What the parent does after a failed subagent, then the model it ran on and what chose it. When the provider refused
 * the route (no funds, the credential, the request or the model), a narrower task cannot help: the advice names this
 * session's model to pass as `model` or what to fix, by cause.
 */
export function failedNext(route: RunRoute, error: string, partial: boolean, nothingSpent = false): string {
	const ran = ranOn(route);
	const kind = refusalKind(error, nothingSpent);
	const provider = route.model ? providerOf(route.model) : "";
	const advice = renderInstruction("notices/subagents/failed-next.md", {
		billing: kind === "billing",
		credential: kind === "credential",
		request: kind === "request",
		rateLimited: RATE_LIMITED.test(error),
		narrower: FAILED_NEXT,
		other: Boolean(route.parent) && provider !== providerOf(route.parent ?? ""),
		parent: route.parent,
		provider: provider || "provider",
		partial,
	});
	return [advice, ran].filter(Boolean).join("\n");
}

/** Why a foreground run that someone stopped ended: who stopped it, so the model does not just start it again. */
export function stoppedError(id: string, by: string): Error {
	if (by === USER_SENDER) return new Error(`Subagent ${id} was stopped by the user.`);
	return new Error(
		`Subagent ${id} was stopped by ${by}.${by === PERMISSION_STOP ? " Ask the user before starting it again." : ""}`,
	);
}

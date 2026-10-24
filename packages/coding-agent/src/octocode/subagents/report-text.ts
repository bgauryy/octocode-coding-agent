import { fenceUntrusted, headerText } from "../shared/fence.ts";
import { USER_SENDER } from "../shared/messages.ts";
import { noticeLines } from "./render.ts";
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

/** What the parent does after a failed subagent; its partial answer, if any, was never checked. */
export const FAILED_NEXT = "Retry with a narrower task or do the work yourself.";
export const PARTIAL_UNVERIFIED = " The partial answer is unverified.";

/** Why a foreground run that someone stopped ended: who stopped it, so the model does not just start it again. */
export function stoppedError(id: string, by: string): Error {
	if (by === USER_SENDER) return new Error(`Subagent ${id} was stopped by the user.`);
	return new Error(
		`Subagent ${id} was stopped by ${by}.${by === PERMISSION_STOP ? " Ask the user before starting it again." : ""}`,
	);
}

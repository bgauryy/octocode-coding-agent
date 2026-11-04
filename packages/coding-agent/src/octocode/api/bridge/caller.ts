import { renderInstruction } from "../../../core/prompt-template.ts";
import { isRecord } from "@octocodeai/octocode-contracts/guards";
import { formatClock } from "../../shared/format.ts";
import { headerText } from "../../shared/fence.ts";
import { apiDir, listInstances } from "../registry.ts";
import type { ExternalAdmission } from "./contracts.ts";

/**
 * Who a caller of `message.send` says it is. A Unix socket does not say who is on its other end (Node exposes no peer
 * credentials), and anything this process can check another process of the same user can also read and repeat, so every
 * field here is a claim. The transport is the one thing this process knows.
 */
export interface CallerClaim {
	name?: string;
	instanceId?: string;
	pid?: number;
	cwd?: string;
}

/** What a reader of an external message is told: the same facts in the model's text, the terminal and RPC and ACP events. */
export interface ExternalFacts extends CallerClaim {
	/** What the sender's `from` says. */
	from: string;
	transport?: "socket" | "http";
	/** A caller blocks on this run's answer. */
	waiting: boolean;
	/** The caller asks for an answer later, as a message to `replyTo`. */
	replyRequired?: boolean;
	/** The name of the running instance the claimed caller named: what it can be messaged at. */
	replyTo?: string;
}

/** The caller's claim from a call's params, bounded to one line each; a field of the wrong shape counts as not given. */
export function callerFrom(params: Record<string, unknown>): CallerClaim {
	const given = params.caller;
	if (!isRecord(given)) return {};
	const text = (value: unknown, max: number) =>
		typeof value === "string" && value.trim() ? headerText(value, max) : undefined;
	const pid = Number.isSafeInteger(given.pid) && (given.pid as number) > 0 ? (given.pid as number) : undefined;
	const claim = {
		name: text(given.name, 64),
		instanceId: text(given.instanceId, 64),
		pid,
		cwd: text(given.cwd, 256),
	};
	return Object.fromEntries(Object.entries(claim).filter(([, value]) => value !== undefined));
}

export function externalFacts(
	from: string,
	caller: CallerClaim,
	transport: ExternalFacts["transport"],
	waiting: boolean,
	replyRequired = false,
): ExternalFacts {
	// Only a running instance can be replied to, by the name its own record holds: the hint repeats no text the caller wrote.
	const instance = caller.instanceId
		? listInstances(apiDir(), false).find((each) => each.id === caller.instanceId)
		: undefined;
	const replyTo = instance?.name ?? instance?.id;
	return {
		from,
		...caller,
		...(transport ? { transport } : {}),
		waiting,
		...(replyRequired ? { replyRequired } : {}),
		...(replyTo ? { replyTo } : {}),
	};
}

/** What the session's permission layer decides on: the sender, the running process it named if any, and the rest of its claim. */
export function admission(facts: ExternalFacts, text: string): ExternalAdmission {
	return {
		from: facts.from,
		...(facts.replyTo ? { process: facts.replyTo } : {}),
		details: [
			...(facts.pid === undefined ? [] : [`says pid ${facts.pid}`]),
			...(facts.cwd === undefined ? [] : [`says it works in ${facts.cwd}`]),
		],
		text,
		self: process.title,
	};
}

/** The header the model reads above the fence. Claimed values are quoted: they are the sender's words, on one line. */
export function externalHeader(facts: ExternalFacts, at: number): string {
	const quote = (value: string | undefined) => (value === undefined ? undefined : JSON.stringify(value));
	return renderInstruction("notices/mail/external-message.md", {
		socket: facts.transport === "socket",
		from: quote(facts.from),
		// A sender that goes by its process name needs saying only once.
		name: facts.name === facts.from ? undefined : quote(facts.name),
		instanceId: quote(facts.instanceId),
		pid: facts.pid,
		cwd: quote(facts.cwd),
		at: formatClock(at),
	});
}

/** What the reader can do about it, below the fence. */
export function externalFooter(facts: ExternalFacts): string {
	return renderInstruction("notices/mail/external-reply.md", {
		waiting: facts.waiting,
		replyRequired: facts.replyRequired === true && facts.replyTo !== undefined,
		replyTo: facts.replyTo,
	});
}

import { renderPrompt } from "../../../core/prompt-template.ts";
import { isRecord } from "@octocodeai/octocode-contracts/guards";
import { makeSource } from "../../events/source.ts";
import type { Source } from "../../events/source-types.ts";
import { formatClock } from "../../shared/format.ts";
import { headerText } from "../../shared/fence.ts";
import { apiDir, readInstance } from "../registry.ts";
import type { ExternalAdmission, TurnCeiling } from "./contracts.ts";

/**
 * Who a caller of `message.send` says it is. A Unix socket does not say who is on its other end (Node exposes no peer
 * credentials), and anything this process can check another process of the same user can also read and repeat, so every
 * field here is a claim. The transport is the one thing this process knows.
 */
export interface CallerClaim {
	/** The sender's team name (`shy-barnacle`), as it says it. */
	team?: string;
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
	/** The claimed team name when exactly one live member of this team has it and runs that pid: it reaches the caller too. */
	teamReply?: string;
	/** That instance confirmed on its own registered socket that this call is its own (`bridge/verify.ts`). */
	verified?: boolean;
	/** Another live record carries that instance's name, so its label adds the instance id. */
	sharedName?: boolean;
}

/** The caller's claim from a call's params, bounded to one line each; a field of the wrong shape counts as not given. */
export function callerFrom(params: Record<string, unknown>): CallerClaim {
	const given = params.caller;
	if (!isRecord(given)) return {};
	const text = (value: unknown, max: number) =>
		typeof value === "string" && value.trim() ? headerText(value, max) : undefined;
	const pid = Number.isSafeInteger(given.pid) && (given.pid as number) > 0 ? (given.pid as number) : undefined;
	const claim = {
		team: text(given.team, 64),
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
	members: readonly unknown[] = [],
): ExternalFacts {
	// Only a running instance can be replied to, by the name its own record (`<id>.json`) holds: the hint repeats no text
	// the caller wrote. The claim must be self-consistent (its pid is the named instance's, as `external/peers.ts` sends it).
	const record = caller.instanceId ? readInstance(apiDir(), caller.instanceId) : undefined;
	const instance = record?.pid === caller.pid ? record : undefined;
	const replyTo = instance?.name ?? instance?.id;
	// The claimed team name is offered back only when this team's own roster agrees: one live member of that name, running that pid.
	const named = caller.team
		? members.filter((member) => isRecord(member) && member.id === caller.team && member.pid === caller.pid)
		: [];
	return {
		from,
		...caller,
		...(named.length === 1 && caller.team ? { teamReply: caller.team } : {}),
		...(transport ? { transport } : {}),
		waiting,
		...(replyRequired ? { replyRequired } : {}),
		...(replyTo ? { replyTo } : {}),
	};
}

/**
 * What the session's permission layer decides on: the sender, the running process it named if any, and the rest of its
 * claim. Only a process that confirmed the call (`verified`) is the scope of a process grant or denial, keyed by the
 * instance it confirmed (its id and pid): its name is any record's to repeat, so it is only the label. An unconfirmed
 * claim is asked about as any other caller.
 */
export function admission(facts: ExternalFacts, text: string, ceiling?: TurnCeiling): ExternalAdmission {
	const label = facts.sharedName ? `${facts.replyTo} (${facts.instanceId})` : facts.replyTo;
	const confirmed =
		facts.replyTo && facts.verified && label ? { id: `${facts.instanceId}#${facts.pid}`, name: label } : undefined;
	return {
		...(ceiling ? { ceiling } : {}),
		from: facts.from,
		...(confirmed ? { process: confirmed } : {}),
		details: [
			...(facts.replyTo && !facts.verified ? [`says it is ${facts.replyTo}, which did not confirm it`] : []),
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
	return renderPrompt("notices/mail/external-message.md", {
		socket: facts.transport === "socket",
		team: quote(facts.team),
		from: quote(facts.from),
		// A sender that goes by its process name needs saying only once.
		name: facts.name === facts.from ? undefined : quote(facts.name),
		instanceId: quote(facts.instanceId),
		pid: facts.pid,
		cwd: quote(facts.cwd),
		at: formatClock(at),
	});
}

/** The source of an API message: the sender's name and process are its own claim, unless that instance confirmed the call on its own socket. */
export function externalSource(facts: ExternalFacts): Source {
	return makeSource(
		"external",
		facts.replyTo ?? facts.from,
		"socket",
		facts.verified ? "proven" : "self-reported",
		facts.pid === undefined ? undefined : { pid: facts.pid },
	);
}

/** What the reader can do about it, below the fence. */
export function externalFooter(facts: ExternalFacts): string {
	return renderPrompt("notices/mail/external-reply.md", {
		waiting: facts.waiting,
		replyRequired: facts.replyRequired === true && facts.replyTo !== undefined,
		replyTo: facts.teamReply ?? facts.replyTo,
	}).trim();
}

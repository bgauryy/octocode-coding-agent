import { PERMISSION_ENV } from "../../../../common/src/env.ts";
import type { Permission } from "./ask.ts";
import type { Asker } from "./ask/types.ts";

/** Who a message says it is from and what it asks, as the API bridge read it. */
interface ExternalClaim {
	/** The sender's own label, or its process name. */
	from: string;
	/** A running instance's process name the caller named: only such a caller can hold a process grant. */
	process?: string;
	/** The rest of what it claims (pid, folder), for the dialog. */
	details: string[];
	text: string;
}

/**
 * Whether an external message reaches this session: the `message.external` class of the mode table, so `full` takes it
 * unasked and records it, the other modes ask, and with nobody to ask it is refused like any other ask. Admission says
 * nothing about what the turn may do: its tools follow the session's mode. Refuses by throwing what the sender reads.
 */
export async function admitExternalMessage(
	permission: Permission,
	ctx: Asker,
	claim: ExternalClaim,
	options: { self: string; planning: boolean; onAsk?: () => void; signal?: AbortSignal },
): Promise<void> {
	const verdict = await permission.check(ctx, {
		action: "message.external",
		title: "Let this external message reach the agent?",
		what: [`from ${claim.process ?? claim.from} (external, not you)`, ...claim.details, claim.text],
		// No agent is involved in this ask, so the card shows no purpose line.
		purpose: "",
		...(claim.process ? { grant: { key: claim.process, label: `messages from ${claim.process}` } } : {}),
		...(options.planning ? { asMode: "manual" as const } : {}),
		...(options.onAsk ? { onAsk: options.onAsk } : {}),
		...(options.signal ? { signal: options.signal } : {}),
	});
	if (verdict.allowed) return;
	const note = /^User's note: (.*)$/m.exec(verdict.message)?.[1];
	if (verdict.via === "user")
		throw new Error(
			`The user of ${options.self} denied this message${note ? `, saying: ${note}` : ""}. Nothing reached its agent. Its user can allow it when asked again, or set /permissions full there.`,
		);
	if (verdict.via === "headless")
		throw new Error(
			`${options.self} runs in ${permission.mode} mode with nobody to ask, so this message reached no agent. Its user can start it with ${PERMISSION_ENV}=full, or run it where it can ask.`,
		);
	throw new Error(`The approval dialog in ${options.self} closed unanswered. Nothing reached its agent.`);
}

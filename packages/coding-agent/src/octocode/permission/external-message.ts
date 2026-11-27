import { renderPrompt } from "../../core/prompt-template.ts";
import type { Permission } from "./ask.ts";
import { heldTo } from "./ask/cap.ts";
import type { Asker } from "./ask/types.ts";
import type { PermissionMode } from "./mode.ts";

/** Who a message says it is from and what it asks, as the API bridge read it. */
interface ExternalClaim {
	/** The sender's own label, or its process name. */
	from: string;
	/**
	 * The running instance that confirmed the call: only such a caller can hold a process grant or denial, keyed by `id`
	 * (its instance id and pid); `name` is only the label, since any record can repeat it.
	 */
	process?: { id: string; name: string };
	/** The rest of what it claims (pid, folder), for the dialog. */
	details: string[];
	text: string;
}

/**
 * Whether an external message reaches this session: the `message.external` class of the mode table, so `full` takes it
 * unasked and records it (`bypass` too), the other modes ask, and with nobody to ask it is refused like any other ask.
 * A message carries a `ceiling` only when the user set `sessionApiTurnPermission: "workspace"`; then it is judged in
 * the stricter of the session's mode and that one (`heldTo`; `bypass` is never held), so a session in `full` asks about
 * it too. Without that setting a full session takes it unasked and runs the turn in full, audited. Admission says
 * nothing about what the turn may do: the caller holds the turn's tools to the same ceiling (`Permission.turnCap`).
 * Refuses by throwing what the sender reads.
 */
export async function admitExternalMessage(
	permission: Permission,
	ctx: Asker,
	claim: ExternalClaim,
	options: { self: string; planning: boolean; ceiling?: PermissionMode; onAsk?: () => void; signal?: AbortSignal },
): Promise<void> {
	const capped = options.ceiling ? heldTo(permission.mode, options.ceiling) : undefined;
	// True when the ceiling, not the session's mode, makes this ask: the usual advice (a wider mode) would not help.
	const held = !options.planning && capped !== undefined && capped !== permission.mode;
	const judged = options.planning ? "manual" : capped;
	const sender = claim.process?.name ?? claim.from;
	const verdict = await permission.check(ctx, {
		action: "message.external",
		title: "Let this external message reach the agent?",
		what: [`from ${sender} (external, not you)`, ...claim.details, claim.text],
		// The card shows the sender as metadata and the message as a collapsible quote; `what` stays the title and audit text.
		view: { meta: [`from ${sender} (external, not you)`, ...claim.details], body: claim.text },
		// No agent is involved in this ask, so the card shows no purpose line.
		purpose: "",
		...(claim.process
			? { grant: { key: claim.process.id, label: `messages from ${claim.process.name}`, deniable: true } }
			: {}),
		...(judged ? { asMode: judged } : {}),
		...(options.onAsk ? { onAsk: options.onAsk } : {}),
		...(options.signal ? { signal: options.signal } : {}),
	});
	if (verdict.allowed) return;
	const note = /^User's note: (.*)$/m.exec(verdict.message)?.[1];
	// "Deny messages from <process> for this session", just given or remembered: asking again would not help.
	if (verdict.via === "user" && verdict.lasts === "session")
		throw new Error(renderPrompt("notices/mail/external-denied-session.md", { self: options.self, sender, note }));
	if (verdict.via === "user")
		throw new Error(
			`The user of ${options.self} denied this message${note ? `, saying: ${note}` : ""}. Nothing reached its agent. Its user can allow it when asked again, ${held ? `or set sessionApiTurnPermission to "session" in the global settings` : "or set /permissions full there"}.`,
		);
	if (verdict.via === "headless")
		throw new Error(
			`${options.self} runs in ${held ? `${permission.mode} mode, and a message that starts a turn through the session API is held to ${capped} mode,` : `${permission.mode} mode`} with nobody to ask, so this message reached no agent. Its user can ${held ? `set sessionApiTurnPermission to "session" in the global settings` : `start it with --permission-mode full`}, or run it where it can ask.`,
		);
	throw new Error(`The approval dialog in ${options.self} closed unanswered. Nothing reached its agent.`);
}

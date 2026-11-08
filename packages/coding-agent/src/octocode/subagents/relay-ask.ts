import { checkedReplies, type Question, type Reply } from "@octocodeai/octocode-contracts";
import { isRecord } from "@octocodeai/octocode-contracts/guards";
import type { ExtensionUIContext } from "../../core/features/index.ts";
import { ask } from "../ask/ask.ts";
import { checkedQuestions as checked } from "../ask/check.ts";
import { foldLines } from "../permission/effect.ts";
import { type PermissionHeader, redactNonce, splitHeader } from "../permission/header.ts";

/**
 * A subagent's `ask` request (typed question batch), shown in the parent and answered for the child. The questions are
 * the child's, checked as a remote's: sanitized and bounded, and an `approval` kept only when the child's harness says it
 * is one (`event.approval`); otherwise it is an ordinary choice. The child's name
 * leads every question's meta, taken from the spawn, never from the request. Every string the parent draws has the child's
 * nonce redacted first, as a select title does; ids are never drawn, so they stay as sent (replies name them).
 */

type RelayAskUi = Pick<ExtensionUIContext, "select" | "confirm" | "input" | "notify" | "ask">;

const redacted = (value: unknown, nonce: string): unknown =>
	typeof value === "string"
		? redactNonce(value, nonce)
		: Array.isArray(value)
			? value.map((item) => redacted(item, nonce))
			: isRecord(value)
				? Object.fromEntries(
						Object.entries(value).map(([key, item]) => [key, key === "id" ? item : redacted(item, nonce)]),
					)
				: value;

/** The child's questions as the parent may draw them (its nonce redacted), or undefined when the request is malformed. */
export function relayedQuestions(event: Record<string, unknown>, label: string, nonce: string): Question[] | undefined {
	const questions = checked(redacted(event.questions, nonce), { verifiedApproval: event.approval === true });
	return questions?.map((question) => ({ ...question, meta: [`${label} asks`, ...(question.meta ?? [])] }));
}

/**
 * What the parent needs to answer a child's permission `ask` without a dialog when its own mode allows the action: the
 * child's header (`event.header`, `AskOptions.header` as the child sent it), read with `splitHeader`, so it must carry
 * the child's nonce and name only targets the question shows (its approval's targets or its body lines, drawn as the
 * dialog text a header is checked against). It applies to one approval question that offers "Allow once" by role;
 * `options` are its labels (the header must list the same) and `reply` is that pick.
 */
export function askShortcut(
	event: Record<string, unknown>,
	questions: readonly Question[],
	nonce: string,
): { header: PermissionHeader; options: string[]; reply: Record<string, unknown> } | undefined {
	const [question] = questions;
	const allow = question?.options?.find((option) => option.role === "allow_once");
	const line = event.header;
	if (questions.length !== 1 || question?.type !== "approval" || !allow || typeof line !== "string") return undefined;
	if (line.includes("\n")) return undefined;
	const shown = [...(question.approval?.targets ?? []).map(foldLines), ...(question.body?.text.split("\n") ?? [])];
	const { header } = splitHeader(`${line}\n${shown.map((text) => `  ${text}`).join("\n")}`, nonce);
	return (
		header && {
			header,
			options: (question.options ?? []).map((option) => option.label),
			reply: { replies: [{ id: question.id, picks: [allow.id] }] },
		}
	);
}

/** Replies that refuse every question without asking: an approval with a note option is denied with `note`, any other is declined. */
export function refusedReplies(questions: readonly Question[], note: string): Reply[] {
	return questions.map((question): Reply => {
		const deny =
			question.type === "approval" ? question.options?.find((option) => option.role === "deny_note") : undefined;
		return deny ? { id: question.id, picks: [deny.id], text: note } : { id: question.id, cancelled: "declined" };
	});
}

/**
 * The `extension_ui_response` body for the child: the parent's replies, checked against the questions asked (a reply
 * that does not fit is never forwarded), or `cancelled` when the request is malformed, the parent has no UI or the
 * dialog was dismissed. The parent's `ask` queues behind its other dialogs itself.
 */
export async function relayAsk(
	ui: RelayAskUi,
	questions: Question[],
	opts: { signal: AbortSignal; timeout?: number },
): Promise<Record<string, unknown>> {
	if (opts.signal.aborted) return { cancelled: true };
	// `ui` is the parent's own UI; `ask` needs only the dialog methods and `ask` itself.
	const replies = await ask({ hasUI: true, ui: ui as ExtensionUIContext }, questions, {
		signal: opts.signal,
		blocking: true,
		...(opts.timeout !== undefined ? { timeout: opts.timeout } : {}),
	});
	const valid = opts.signal.aborted ? undefined : checkedReplies(questions, replies);
	return valid ? { replies: valid } : { cancelled: true };
}

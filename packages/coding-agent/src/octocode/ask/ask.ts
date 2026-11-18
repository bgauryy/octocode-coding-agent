import type { CancelReason, Question, Reply } from "@octocodeai/octocode-contracts";
import type { FeatureContext } from "../../core/features/index.ts";
import { withDialog } from "../shared/locks.ts";
import { withDeadline } from "./countdown.ts";
import { degrade } from "./degrade.ts";
import { showAskDialog } from "./dialog.ts";
import type { AskOptions } from "./question.ts";

/** Where a question is shown: a context whose `ui` may offer `ask` (`SessionUI.ask`). */
export type AskContext = Pick<FeatureContext, "hasUI"> &
	Partial<Pick<FeatureContext, "mode">> & { ui: FeatureContext["ui"] };

const cancelledAll = (questions: readonly Question[], cancelled: CancelReason): Reply[] =>
	questions.map((question) => ({ id: question.id, cancelled }));

/** One reply per question, in the questions' order: a reply the host left out is a decline, one for no question is dropped. */
const aligned = (questions: readonly Question[], replies: readonly Reply[]): Reply[] =>
	questions.map(
		(question) => replies.find((reply) => reply.id === question.id) ?? { id: question.id, cancelled: "declined" },
	);

/**
 * Ask `questions` of the person at `ctx`. With no UI every question is `unavailable`; an interrupted turn answers
 * `aborted` without showing anything. Otherwise the terminal draws a batch of text, choice and multi questions with its
 * tabbed dialog, and every other batch goes to `ctx.ui.ask` (the terminal's confirmations and permission cards, an RPC
 * client's, the workspace's); a host without one gets plain select, input and confirm dialogs (`degrade.ts`).
 * A batch whose questions carry `timeoutSeconds` takes their recommended options when it runs out unanswered.
 * The interaction runs inside `withDialog`, so it waits for any dialog already open, as every asker does. A host
 * error propagates: it is not an answer.
 */
export async function ask(ctx: AskContext, questions: Question[], opts: AskOptions = {}): Promise<Reply[]> {
	if (questions.length === 0) return [];
	if (opts.signal?.aborted) return cancelledAll(questions, "aborted");
	if (!ctx.hasUI) return cancelledAll(questions, "unavailable");
	const host = ctx.ui.ask;
	const drawn =
		ctx.mode === "tui" && questions.every((q) => q.type === "text" || q.type === "choice" || q.type === "multi");
	// The terminal dialog counts down itself (a key press stops it); every other host is dismissed when the time is up.
	const show = (): Promise<Reply[]> =>
		drawn
			? showAskDialog(ctx, questions, opts.signal)
			: withDeadline(questions, opts.signal, (signal, hold) => {
					const own = { ...opts, ...(signal ? { signal } : {}), hold };
					return host ? host.call(ctx.ui, questions, own) : degrade(ctx.ui, questions, own);
				});
	return aligned(questions, await withDialog(show, opts.signal));
}

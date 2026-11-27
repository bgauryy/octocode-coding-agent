import { askUserResult } from "../../src/octocode/ask/decode.ts";
import { showAskDialog as showQuestions } from "../../src/octocode/ask/dialog.ts";
import type { AskQuestion, AskResult } from "../../src/octocode/ask/dialog/answers.ts";
import { fromAskUser } from "../../src/octocode/ask/question.ts";

/** The terminal dialog driven as askUser drives it: askUser's questions in, askUser's result out. */
export async function showAskDialog(
	ctx: Parameters<typeof showQuestions>[0],
	questions: AskQuestion[],
	signal?: AbortSignal,
): Promise<AskResult> {
	const asked = fromAskUser(questions);
	return askUserResult(asked, await showQuestions(ctx, asked, signal));
}

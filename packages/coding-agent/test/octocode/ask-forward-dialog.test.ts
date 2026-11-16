import { expect, it } from "vitest";
import { remoteAnswer } from "../../src/octocode/ask/dialog/view.ts";
import { fromAskUser } from "../../src/octocode/ask/question.ts";

it("keeps the child's verbatim question above the parent's in the remote dialog too", () => {
	const label = "jolly-tentacle asks (message #7):";
	const text = "Keep both paths?\n  This indentation matters.\n\nAnd this paragraph.";
	const question = `${label}\n${text}\n\nWhich scope?`;
	const questions = fromAskUser([
		{
			question,
			forwarded: { label, text, ask: "Which scope?" },
			options: [{ label: "Small" }, { label: "Large" }],
		},
	]);
	const remote = remoteAnswer(questions)?.remote;
	expect(remote?.title).toBe(question);
	expect(remote?.ask?.question).toBe(question);
	expect(remote?.ask?.body).toBeUndefined();
});

import { describe, expect, test } from "vitest";
import { trailingUpdateRewritesPrefix } from "../src/utils/transcript-prefix.ts";

const head = { role: "system", content: "base", timestamp: 0 };
const user = { role: "user", content: "hi", timestamp: 1 };
const toolResult = { role: "toolResult", toolCallId: "c", toolName: "t", content: [], isError: false, timestamp: 2 };
const sections = { role: "system", content: "", sections: { planning: "on" }, timestamp: 3 };
const tools = {
	role: "system",
	content: "",
	toolsAdded: [{ name: "x", description: "d", parameters: { type: "object" } }],
	timestamp: 3,
};

describe("trailingUpdateRewritesPrefix", () => {
	test("never for a model that keeps system updates in the history", () => {
		const model = { api: "anthropic-messages", compat: { supportsMidConvoSystemMessages: true } };
		expect(trailingUpdateRewritesPrefix([head, user, tools], model)).toBe(false);
	});

	test("for a collapsing model only when the leading message changes", () => {
		const model = { api: "openai-completions" };
		expect(trailingUpdateRewritesPrefix([head, user, sections], model)).toBe(false);
		expect(trailingUpdateRewritesPrefix([head, user, tools], model)).toBe(true);
		expect(trailingUpdateRewritesPrefix([head, user], model)).toBe(false);
	});

	test("folds a prompt update held after a tool result into the head on mistral", () => {
		const messages = [head, user, toolResult, sections];
		expect(trailingUpdateRewritesPrefix(messages, { api: "mistral-conversations" })).toBe(true);
		expect(trailingUpdateRewritesPrefix(messages, { api: "openai-completions" })).toBe(false);
	});
});

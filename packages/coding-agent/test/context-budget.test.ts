import { describe, expect, it } from "vitest";
import { contextFilesBudgetWarning } from "../src/core/context-budget.ts";
import { buildSystemPrompt } from "../src/core/system-prompt.ts";

const promptWith = (files: Array<{ path: string; content: string }>) =>
	buildSystemPrompt({ cwd: "/repo", contextFiles: files });

describe("contextFilesBudgetWarning", () => {
	it("stays quiet when the context files fit", () => {
		const files = [{ path: "/repo/AGENTS.md", content: "Use yarn." }];
		expect(
			contextFilesBudgetWarning({ systemPrompt: promptWith(files), files, contextWindow: 200_000 }),
		).toBeUndefined();
	});

	it("warns with each file's size, largest first, when they pass 1% of the window", () => {
		const files = [
			{ path: "/repo/AGENTS.md", content: "a".repeat(500) },
			{ path: "/repo/pkg/AGENTS.md", content: "b".repeat(2_000) },
		];
		const warning = contextFilesBudgetWarning({ systemPrompt: promptWith(files), files, contextWindow: 50_000 });
		expect(warning?.text).toMatch(/^Context files too long: \d+ chars, budget 2000/);
		expect(warning?.details).toEqual(["/repo/pkg/AGENTS.md: 2000 chars", "/repo/AGENTS.md: 500 chars"]);
	});
});

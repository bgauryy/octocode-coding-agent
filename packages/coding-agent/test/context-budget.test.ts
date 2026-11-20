import { describe, expect, it } from "vitest";
import { contextFilesBudgetWarning, contextSizeWarnings, mcpToolSizes } from "../src/core/context-budget.ts";
import { skillListingBudgetChars } from "../src/core/skills/listing-budget.ts";
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
		const budget = skillListingBudgetChars(50_000);
		const files = [
			{ path: "/repo/AGENTS.md", content: "a".repeat(500) },
			{ path: "/repo/pkg/AGENTS.md", content: "b".repeat(budget) },
		];
		const warning = contextFilesBudgetWarning({ systemPrompt: promptWith(files), files, contextWindow: 50_000 });
		expect(warning?.text).toMatch(new RegExp(`^Context files too long: \\d+ chars, budget ${budget} `));
		expect(warning?.details).toEqual([`/repo/pkg/AGENTS.md: ${budget} chars`, "/repo/AGENTS.md: 500 chars"]);
	});
});

describe("declared MCP tools", () => {
	const tool = (name: string, size: number) => ({
		name,
		description: "d".repeat(size),
		parameters: { type: "object" },
	});

	it("sums each server's declarations and leaves native tools out", () => {
		const sizes = mcpToolSizes([
			tool("bash", 10),
			tool("mcp__octocode__localSearch", 100),
			tool("mcp__octocode__localFetch", 50),
		]);
		expect(sizes).toEqual([
			{
				server: "octocode",
				tools: 2,
				chars:
					JSON.stringify(tool("mcp__octocode__localSearch", 100)).length +
					JSON.stringify(tool("mcp__octocode__localFetch", 50)).length,
			},
		]);
	});

	it("warns about a server whose declared tools pass 5% of the window, largest first", () => {
		// Five times the instructions budget (1% of the window).
		const budget = skillListingBudgetChars(50_000) * 5;
		const warnings = contextSizeWarnings({
			servers: [],
			tools: [
				{ server: "fits", chars: budget },
				{ server: "big", chars: budget * 3 },
				{ server: "large", chars: budget + 1 },
			],
			contextFilesChars: 0,
			contextWindow: 50_000,
		});
		const fix = "fix: defer its tools with /mcp exposure, or disable the server in /mcp";
		expect(warnings).toEqual([
			`MCP server big tool declarations too long: ${budget * 3} chars, budget ${budget} · ${fix}`,
			`MCP server large tool declarations too long: ${budget + 1} chars, budget ${budget} · ${fix}`,
		]);
	});
});

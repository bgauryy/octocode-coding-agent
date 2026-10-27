import { describe, expect, test } from "vitest";
import type { Skill } from "../src/core/skills.ts";
import { createSyntheticSourceInfo } from "../src/core/source-info.ts";
import { buildSystemPrompt } from "../src/core/system-prompt.ts";

const testSkill: Skill = {
	name: "test-skill",
	description: "A test skill.",
	filePath: "/skills/test-skill/SKILL.md",
	baseDir: "/skills/test-skill",
	sourceInfo: createSyntheticSourceInfo("/skills/test-skill/SKILL.md", { source: "test" }),
	disableModelInvocation: false,
};

describe("buildSystemPrompt", () => {
	test("an empty custom section removes the default section of that name", () => {
		const base = { cwd: "/tmp", selectedTools: ["bash"], contextFiles: [], skills: [] };
		expect(buildSystemPrompt(base)).toContain("<docs>");
		const trimmed = buildSystemPrompt({ ...base, sections: { docs: "" } });
		expect(trimmed).not.toContain("<docs>");
		expect(trimmed).toContain("<rules>");
	});

	test.each([
		"localSearch",
		"localSearchCode",
		"structureSearch",
		"astSearch",
		"lspSearch",
		"localFindFiles",
		"localViewStructure",
	])("does not redirect %s searches to the shell", (name) => {
		const prompt = buildSystemPrompt({
			cwd: "/tmp",
			selectedTools: ["bash", `mcp__octocode__${name}`],
			contextFiles: [],
			skills: [],
		});
		expect(prompt).not.toContain("Use bash for file operations");
	});

	test("counts search tools that tool_search can load, so loading one keeps the rules unchanged", () => {
		const base = { cwd: "/tmp", contextFiles: [], skills: [] };
		const deferred = buildSystemPrompt({
			...base,
			selectedTools: ["bash", "tool_search"],
			deferredTools: ["mcp__octocode__localSearch"],
		});
		expect(deferred).not.toContain("Use bash for file operations");
		const loaded = buildSystemPrompt({
			...base,
			selectedTools: ["bash", "tool_search", "mcp__octocode__localSearch"],
			deferredTools: [],
		});
		expect(loaded.match(/<rules>[\s\S]*<\/rules>/)?.[0]).toBe(deferred.match(/<rules>[\s\S]*<\/rules>/)?.[0]);
		expect(buildSystemPrompt({ ...base, selectedTools: ["bash"] })).toContain("Use bash for file operations");
	});

	test.each(["mcp__octocode__localFetch", "mcp__octocode__localGetFileContent"])(
		"loads skills through %s without read or bash",
		(reader) => {
			const prompt = buildSystemPrompt({ cwd: "/tmp", selectedTools: [reader], contextFiles: [], skills: [testSkill] });
			expect(prompt).toContain("Use Octocode localFetch");
			expect(prompt).toContain("/skills/test-skill/SKILL.md");
			expect(prompt).not.toContain("Use the read tool");
		},
	);

	test("names the skill tool as the skill reader, ahead of any file reader", () => {
		const prompt = buildSystemPrompt({
			cwd: "/tmp",
			selectedTools: ["skill", "bash", "mcp__octocode__localFetch"],
			contextFiles: [],
			skills: [testSkill],
		});
		expect(prompt).toContain(
			"Use the skill tool with a skill's name to load it when the task matches its description.",
		);
		expect(prompt).toContain("resolve it against the skill directory the tool returns");
		expect(prompt).not.toMatch(/Use Octocode localFetch|Use bash to load|localGetFileContent/);
		// The tool needs no file reader.
		expect(
			buildSystemPrompt({ cwd: "/tmp", selectedTools: ["skill"], contextFiles: [], skills: [testSkill] }),
		).toContain("Use the skill tool");
	});

	test("a hidden skill tool is not advertised: the file reader variant stays", () => {
		const prompt = buildSystemPrompt({
			cwd: "/tmp",
			selectedTools: ["skill", "mcp__octocode__localFetch"],
			hiddenTools: ["skill"],
			contextFiles: [],
			skills: [testSkill],
		});
		expect(prompt).toContain("Use Octocode localFetch to load a skill file");
		expect(prompt).not.toContain("skill tool");
	});

	test.each(["mcp__octocode__localFetch", "mcp__octocode__localGetFileContent"])(
		"keeps skills without advertising the hidden %s reader",
		(reader) => {
			const input = { cwd: "/tmp", selectedTools: [reader], hiddenTools: [reader], skills: [testSkill] };
			const indirect = buildSystemPrompt(input);
			expect(indirect).toContain("/skills/test-skill/SKILL.md");
			expect(indirect).not.toContain("Use Octocode localFetch");
			const shell = buildSystemPrompt({ ...input, selectedTools: [reader, "bash"] });
			expect(shell).toContain("Use bash");
			expect(shell).not.toContain("Use Octocode localFetch");
		},
	);

	test("keeps the tool list and docs section free of restated rules", () => {
		const prompt = buildSystemPrompt({ cwd: "/tmp", selectedTools: ["bash"], toolSnippets: { bash: "Run." } });
		expect(prompt).not.toContain("other custom tools");
		expect(prompt.match(/Read the documentation that defines/g)).toBeNull();
		expect(prompt.match(/follow \.md cross-references/g)).toHaveLength(1);
		// SDK sessions without an `octocode` section keep the core communication floor.
		expect(prompt).toContain("- Be concise in your responses");
	});

	test("drops the core brevity floor when Octocode's Communication policy supplies it", () => {
		const prompt = buildSystemPrompt({
			cwd: "/tmp",
			selectedTools: ["bash"],
			sections: { octocode_communication: "# Communication\n- Lead with the result." },
		});
		expect(prompt).not.toContain("Be concise in your responses");
		expect(prompt).not.toContain("Refer to files by their paths");
		expect(prompt).toContain("Lead with the result.");
	});

	describe("empty tools", () => {
		test("shows (none) for empty tools list", () => {
			const prompt = buildSystemPrompt({
				selectedTools: [],
				contextFiles: [],
				skills: [],
				cwd: process.cwd(),
			});

			expect(prompt).toContain("<tools>\n(none)\n");
		});

		test("shows file paths guideline even with no tools", () => {
			const prompt = buildSystemPrompt({
				selectedTools: [],
				contextFiles: [],
				skills: [],
				cwd: process.cwd(),
			});

			expect(prompt).toContain("Refer to files by their paths");
		});
	});

	describe("prompt structure", () => {
		test("keeps the default and custom prompt prefixes exact", () => {
			const defaultPrompt = buildSystemPrompt({ cwd: "/tmp", selectedTools: [], contextFiles: [], skills: [] });
			const customPrompt = buildSystemPrompt({
				customPrompt: "You are Exact.",
				cwd: "/tmp",
				selectedTools: [],
				contextFiles: [],
				skills: [],
			});

			expect(defaultPrompt.startsWith("You are a coding assistant operating inside Octocode")).toBe(true);
			expect(customPrompt.startsWith("You are Exact.\n\n<cwd>")).toBe(true);
		});

		test("preserves an exact forced prompt without sections", () => {
			expect(buildSystemPrompt({ forceSystemPrompt: "exact", cwd: "/tmp" })).toBe("exact");
		});

		test("maps appended instructions and project context to stable sections", () => {
			const prompt = buildSystemPrompt({
				customPrompt: "You are Exact.",
				appendSystemPrompt: "Additional instructions.",
				contextFiles: [{ path: "/tmp/AGENTS.md", content: "Project instructions." }],
				selectedTools: [],
				skills: [],
				cwd: "/tmp",
			});

			expect(prompt).toContain("<addendum>\nAdditional instructions.\n</addendum>");
			expect(prompt).toContain(
				'<project_context>\nProject-specific instructions and guidelines:\n\n<project_instructions path="/tmp/AGENTS.md">',
			);
			expect(prompt).toContain("<cwd>\n/tmp\n</cwd>");
		});
	});

	describe("default tools", () => {
		test("includes the default tool when its snippet is provided", () => {
			const prompt = buildSystemPrompt({
				toolSnippets: { bash: "Execute bash commands" },
				contextFiles: [],
				skills: [],
				cwd: process.cwd(),
			});

			expect(prompt).toContain("- bash: Execute bash commands");
			expect(prompt).toContain("Use bash for file operations like ls, rg, find");
		});

		test("instructs models to resolve Octocode docs and examples under absolute base paths", () => {
			const prompt = buildSystemPrompt({
				contextFiles: [],
				skills: [],
				cwd: process.cwd(),
			});

			expect(prompt).toContain(
				"- Resolve docs/... under Additional docs and examples/... under Examples, not the current working directory",
			);
			expect(prompt).toContain("docs/index.md maps every Octocode topic to its page");
		});
	});

	describe("custom tool snippets", () => {
		test("includes custom tools in available tools section when promptSnippet is provided", () => {
			const prompt = buildSystemPrompt({
				selectedTools: ["read", "dynamic_tool"],
				toolSnippets: {
					dynamic_tool: "Run dynamic test behavior",
				},
				contextFiles: [],
				skills: [],
				cwd: process.cwd(),
			});

			expect(prompt).toContain("- dynamic_tool: Run dynamic test behavior");
		});

		test("omits custom tools from available tools section when promptSnippet is not provided", () => {
			const prompt = buildSystemPrompt({
				selectedTools: ["read", "dynamic_tool"],
				contextFiles: [],
				skills: [],
				cwd: process.cwd(),
			});

			expect(prompt).not.toContain("dynamic_tool");
		});
	});

	describe("prompt guidelines", () => {
		test("appends promptGuidelines to default guidelines", () => {
			const prompt = buildSystemPrompt({
				selectedTools: ["read", "dynamic_tool"],
				promptGuidelines: ["Use dynamic_tool for project summaries."],
				contextFiles: [],
				skills: [],
				cwd: process.cwd(),
			});

			expect(prompt).toContain("- Use dynamic_tool for project summaries.");
		});

		test("deduplicates and trims promptGuidelines", () => {
			const prompt = buildSystemPrompt({
				selectedTools: ["read", "dynamic_tool"],
				promptGuidelines: ["Use dynamic_tool for summaries.", "  Use dynamic_tool for summaries.  ", "   "],
				contextFiles: [],
				skills: [],
				cwd: process.cwd(),
			});

			expect(prompt.match(/- Use dynamic_tool for summaries\./g)).toHaveLength(1);
		});
	});

	describe("skills", () => {
		test.each([
			{ name: "default prompt", customPrompt: undefined },
			{ name: "custom prompt", customPrompt: "Custom system prompt" },
		])("includes skills with only bash in the $name", ({ customPrompt }) => {
			const prompt = buildSystemPrompt({
				customPrompt,
				selectedTools: ["bash"],
				contextFiles: [],
				skills: [testSkill],
				cwd: process.cwd(),
			});

			expect(prompt).toContain("<skills>");
			expect(prompt).toContain("<available_skills>");
			expect(prompt).toContain("<name>test-skill</name>");
			expect(prompt).toContain("Use bash to load a skill's file");
		});

		test("names a deferred Octocode reader and keeps skills when it is the only reader", () => {
			const build = (selectedTools: string[]) =>
				buildSystemPrompt({
					selectedTools,
					deferredTools: ["mcp__octocode__localFetch"],
					contextFiles: [],
					skills: [testSkill],
					cwd: process.cwd(),
				});
			expect(build(["tool_search"])).toContain("<available_skills>");
			expect(build(["tool_search"])).toContain("Use Octocode localFetch");
			expect(build(["bash", "tool_search"])).toContain("Use Octocode localFetch");
			expect(build(["bash", "tool_search"])).not.toContain("Use bash to load a skill's file");
		});

		test("omits skills without read or bash", () => {
			const prompt = buildSystemPrompt({
				selectedTools: ["write"],
				contextFiles: [],
				skills: [testSkill],
				cwd: process.cwd(),
			});

			expect(prompt).not.toContain("<available_skills>");
		});
	});

	// #10343
	describe("hidden tools", () => {
		const build = (hiddenTools: string[]) =>
			buildSystemPrompt({
				selectedTools: ["read", "bash", "run"],
				hiddenTools,
				toolSnippets: { read: "Read files", bash: "Run commands", run: "Run a task" },
				toolGuidelines: { read: ["Use read for files."], run: ["Prefer run."] },
				contextFiles: [],
				skills: [testSkill],
				cwd: process.cwd(),
			});

		test("leaves hidden tools out of the tool list and rules", () => {
			const prompt = build(["read", "bash"]);

			expect(prompt).toContain("<tools>\n- run: Run a task\n");
			expect(prompt).not.toContain("- read: ");
			expect(prompt).not.toContain("Use read for files.");
			expect(prompt).not.toContain("Use bash for file operations");
			expect(prompt).toContain("- Prefer run.");
		});

		test("keeps skills without naming a hidden reader", () => {
			expect(build(["read", "bash"])).toContain("\nLoad a skill's file when the task matches its description.");
			expect(build(["read"])).toContain("Use bash to load a skill's file");
			expect(build([])).toContain("Use the read tool to load a skill's file");
		});
	});
});

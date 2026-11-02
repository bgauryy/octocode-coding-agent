import { describe, expect, test } from "vitest";
import type { Skill } from "../src/core/skills.ts";
import { createSyntheticSourceInfo } from "../src/core/source-info.ts";
import { buildSystemPrompt, buildSystemPromptSections, currentEnvironment } from "../src/core/system-prompt.ts";

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

	test.each(["mcp__octocode__localFetch", "mcp__octocode__localGetFileContent"])(
		"loads skills through %s without read or bash",
		(reader) => {
			const prompt = buildSystemPrompt({ cwd: "/tmp", selectedTools: [reader], contextFiles: [], skills: [testSkill] });
			// The reader is a declared tool with its own description: the skill hint names none.
			expect(prompt).toContain("Load a skill's file when the task matches its description.");
			expect(prompt).not.toContain("localFetch");
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
		// The skill tool's description owns how a loaded skill's relative paths resolve.
		expect(prompt).not.toContain("resolve it against the skill directory");
		expect(prompt).not.toMatch(/Load a skill's file|Use bash to load|localFetch|localGetFileContent/);
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
		expect(prompt).toContain("Load a skill's file when the task matches its description.");
		expect(prompt).not.toContain("skill tool");
	});

	test.each(["mcp__octocode__localFetch", "mcp__octocode__localGetFileContent"])(
		"keeps skills without advertising the hidden %s reader",
		(reader) => {
			const input = { cwd: "/tmp", selectedTools: [reader], hiddenTools: [reader], skills: [testSkill] };
			const indirect = buildSystemPrompt(input);
			expect(indirect).toContain("/skills/test-skill/SKILL.md");
			expect(indirect).not.toContain("localFetch");
			const shell = buildSystemPrompt({ ...input, selectedTools: [reader, "bash"] });
			expect(shell).toContain("Use bash");
			expect(shell).not.toContain("localFetch");
		},
	);

	test("keeps the tool list and docs section free of restated rules", () => {
		const prompt = buildSystemPrompt({ cwd: "/tmp", selectedTools: ["bash"], toolSnippets: { bash: "Run." } });
		expect(prompt).not.toContain("other custom tools");
		expect(prompt.match(/Read the documentation that defines/g)).toBeNull();
		expect(prompt.match(/follow the \.md links/g)).toHaveLength(1);
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
		test("leaves the tools section out for an empty tools list", () => {
			const prompt = buildSystemPrompt({
				selectedTools: [],
				contextFiles: [],
				skills: [],
				cwd: process.cwd(),
			});

			expect(prompt).not.toContain("<tools>");
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
				'<project_context>\nProject-specific instructions and guidelines. They rank above general habits and below the user\'s direct request; the safety rules of this prompt stay in force:\n\n<project_instructions path="/tmp/AGENTS.md">',
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

		test("instructs models to resolve Octocode docs under an absolute base path", () => {
			const prompt = buildSystemPrompt({
				contextFiles: [],
				skills: [],
				cwd: process.cwd(),
			});

			expect(prompt).toMatch(/Octocode documentation, under \S+ \(not the working directory\)/);
			expect(prompt).toContain("README.md and docs/ (docs/index.md maps each topic to its page)");
			expect(prompt).not.toContain("examples/");
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
			// Octocode ships no `read` tool: a tool registered under that name is not a skill loader.
			expect(build([])).toContain("Use bash to load a skill's file");
			expect(build([])).not.toContain("Use the read tool");
		});
	});

	describe("tools section", () => {
		const tools = (selectedTools: string[], toolSnippets: Record<string, string>) =>
			buildSystemPromptSections({ selectedTools, toolSnippets, cwd: "/tmp" }).tools;

		test("lists one `- name: trigger` line per declared tool, in declaration order", () => {
			expect(tools(["file", "bash", "agent"], { agent: "Delegate", bash: "Run", file: "Change files" })).toBe(
				"<tools>\n- file: Change files\n- bash: Run\n- agent: Delegate\n</tools>",
			);
		});

		test("leaves out MCP tools, which `mcps` describes, and tools without a snippet", () => {
			const section = tools(["bash", "mcp__docs__search", "mcp", "quiet"], {
				bash: "Run",
				mcp__docs__search: "Search the docs",
				mcp: "Manage servers",
			});
			expect(section).toBe("<tools>\n- bash: Run\n- mcp: Manage servers\n</tools>");
		});

		test("names each MCP server from the supplied purposes after the native tools, in key order", () => {
			const section = buildSystemPromptSections({
				selectedTools: ["bash", "mcp__docs__search"],
				toolSnippets: { bash: "Run", mcp__docs__search: "ignored" },
				mcpServers: { mcp__web: "Browse the web", mcp__docs: "Product docs", mcp__quiet: "" },
				cwd: "/tmp",
			}).tools;
			expect(section).toBe(
				"<tools>\n- bash: Run\n- mcp__docs__*: Product docs\n- mcp__web__*: Browse the web\n</tools>",
			);
		});

		test("lists a server even when no native tool has a snippet", () => {
			const section = buildSystemPromptSections({
				selectedTools: ["mcp__docs__search"],
				mcpServers: { mcp__docs: "Product docs" },
				cwd: "/tmp",
			}).tools;
			expect(section).toBe("<tools>\n- mcp__docs__*: Product docs\n</tools>");
		});

		test("is absent when no declared tool has a snippet", () => {
			expect(tools(["bash"], {})).toBeUndefined();
			expect(tools(["mcp__docs__search"], { mcp__docs__search: "Search" })).toBeUndefined();
		});

		test("follows the tool set: unchanged by an undeclared tool's snippet, changed by a new tool", () => {
			const snippets = { bash: "Run", file: "Change files" };
			expect(tools(["bash"], snippets)).toBe(tools(["bash"], { ...snippets, unused: "Never declared" }));
			expect(tools(["bash", "file"], snippets)).not.toBe(tools(["bash"], snippets));
		});
	});
});

describe("environment section", () => {
	test("names the platform, the shell and the local date", () => {
		const text = currentEnvironment(new Date(2026, 9, 28, 23, 30), { SHELL: "/bin/zsh" });
		expect(text).toBe(`Platform: ${process.platform} ${process.arch}\nShell: zsh\nDate: 2026-10-28`);
	});

	test("is the last default section when given, and absent otherwise", () => {
		const base = { cwd: "/tmp", selectedTools: ["bash"], contextFiles: [], skills: [] };
		expect(Object.keys(buildSystemPromptSections(base))).not.toContain("environment");
		const sections = buildSystemPromptSections({ ...base, environment: "Date: 2026-10-28" });
		expect(Object.keys(sections).at(-1)).toBe("environment");
		expect(sections.environment).toBe("<environment>\nDate: 2026-10-28\n</environment>");
	});
});

describe("base sections", () => {
	const base = {
		cwd: "/tmp",
		selectedTools: ["bash"],
		contextFiles: [{ path: "/tmp/AGENTS.md", content: "Project rules." }],
		skills: [],
		appendSystemPrompt: "Addendum.",
		environment: "Date: 2026-10-28",
		sections: { octocode: "Policy." },
		baseSections: { mcps: "servers", other_base: "other file" },
	};

	test("follow docs in the given order, ahead of the addendum, project context and custom sections", () => {
		// An extension's own section ends the session sections, ahead of the volatile `environment`.
		expect(Object.keys(buildSystemPromptSections(base))).toEqual([
			"preamble",
			"rules",
			"docs",
			"mcps",
			"other_base",
			"addendum",
			"cwd",
			"project_context",
			"octocode",
			"environment",
		]);
		expect(buildSystemPromptSections(base).mcps).toBe("<mcps>\nservers\n</mcps>");
	});

	test("follow the preamble of a custom prompt, and stay after rules when a subagent removes docs", () => {
		expect(Object.keys(buildSystemPromptSections({ ...base, customPrompt: "Custom." })).slice(0, 3)).toEqual([
			"preamble",
			"mcps",
			"other_base",
		]);
		const child = buildSystemPromptSections({ ...base, sections: { docs: "" } });
		expect(Object.keys(child).slice(0, 4)).toEqual(["preamble", "rules", "mcps", "other_base"]);
	});

	test("reject invalid section names and drop empty ones", () => {
		expect(() => buildSystemPromptSections({ ...base, baseSections: { "Bad Name": "x" } })).toThrow(
			"Invalid system prompt section name",
		);
		expect(Object.keys(buildSystemPromptSections({ ...base, baseSections: { mcps: "" } }))).not.toContain("mcps");
	});
});

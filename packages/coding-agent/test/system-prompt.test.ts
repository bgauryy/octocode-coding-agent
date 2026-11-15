import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import type { Skill } from "../src/core/skills.ts";
import { createSyntheticSourceInfo } from "../src/core/source-info.ts";
import {
	buildSystemPrompt,
	buildSystemPromptSections,
	currentEnvironment,
	linkedWorktreeFact,
} from "../src/core/system-prompt.ts";
import { RESEARCH, useResearchRoles } from "./octocode/fake-research-roles.ts";

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

	describe("with an MCP server declaring reader and search roles", () => {
		useResearchRoles();

		test("loads skills through a reader-role tool without read or bash", () => {
			const prompt = buildSystemPrompt({
				cwd: "/tmp",
				selectedTools: [RESEARCH.reader],
				contextFiles: [],
				skills: [testSkill],
			});
			expect(prompt).toContain("/skills/test-skill/SKILL.md");
		});

		test("a tool without a reader role does not load skills", () => {
			const prompt = buildSystemPrompt({
				cwd: "/tmp",
				selectedTools: [RESEARCH.other],
				contextFiles: [],
				skills: [testSkill],
			});
			expect(prompt).not.toContain("<available_skills>");
		});

		test("keeps skills without advertising a hidden reader-role tool", () => {
			const reader = RESEARCH.reader;
			const input = { cwd: "/tmp", selectedTools: [reader], hiddenTools: [reader], skills: [testSkill] };
			const indirect = buildSystemPrompt(input);
			expect(indirect).toContain("/skills/test-skill/SKILL.md");
			const shell = buildSystemPrompt({ ...input, selectedTools: [reader, "bash"] });
			expect(shell).toContain("/skills/test-skill/SKILL.md");
		});
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
	});

	describe("prompt structure", () => {
		test("uses the supplied custom prompt as the prefix", () => {
			const customPrompt = buildSystemPrompt({
				customPrompt: "You are Exact.",
				cwd: "/tmp",
				selectedTools: [],
				contextFiles: [],
				skills: [],
			});

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
			expect(prompt).toContain('<project_instructions path="/tmp/AGENTS.md">\nProject instructions.');
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
			expect(prompt).toContain('<skill name="test-skill" location=');
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
			expect(prompt).toContain("- Prefer run.");
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

	test("mentions Mermaid only where replies draw it, names the host, and tells surfaces apart", () => {
		const day = new Date(2026, 9, 28);
		const env = (surface: Parameters<typeof currentEnvironment>[3]) =>
			currentEnvironment(day, { SHELL: "sh" }, undefined, surface);
		const plain = env({});
		const on = env({ surface: "tui", host: "kitty, tmux", mermaid: true });
		const off = env({ surface: "tui", host: "kitty, tmux", mermaid: false });

		expect(on).toMatch(/mermaid/i);
		expect(off).not.toMatch(/mermaid/i);
		expect(env({ surface: "subagent" })).not.toMatch(/mermaid/i);
		expect(on).toContain("kitty, tmux");
		// The machine facts stay first; the surface only adds to them.
		expect(on.startsWith(plain)).toBe(true);
		const kinds = ["tui", "print", "json", "rpc", "subagent"] as const;
		const texts = kinds.map((surface) => env({ surface }));
		expect(new Set([plain, ...texts]).size).toBe(kinds.length + 1);
	});

	test("names a linked worktree with its main checkout and branch, and says nothing in a main checkout", () => {
		const root = mkdtempSync(join(tmpdir(), "env-worktree-"));
		try {
			const linked = join(root, "main", ".octocode", "worktrees", "feat");
			const gitdir = join(root, "main", ".git", "worktrees", "feat");
			mkdirSync(linked, { recursive: true });
			mkdirSync(gitdir, { recursive: true });
			writeFileSync(join(linked, ".git"), `gitdir: ${gitdir}\n`);
			writeFileSync(join(gitdir, "HEAD"), "ref: refs/heads/feat/x\n");
			const fact = linkedWorktreeFact(linked);
			expect(fact).toBe(`linked worktree of ${join(root, "main")}, branch feat/x`);
			expect(currentEnvironment(new Date(2026, 9, 28), { SHELL: "sh" }, fact)).toContain(`\nCheckout: ${fact}`);
			mkdirSync(join(root, "main", ".git"), { recursive: true });
			expect(linkedWorktreeFact(join(root, "main"))).toBeUndefined();
			expect(currentEnvironment(new Date(2026, 9, 28), { SHELL: "sh" })).not.toContain("Checkout");
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
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
			"project_context",
			"octocode",
			"cwd",
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

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import {
	buildSystemPrompt,
	buildSystemPromptSections,
	currentEnvironment,
	linkedWorktreeFact,
} from "../src/core/system-prompt.ts";

describe("buildSystemPrompt", () => {
	test("an empty custom section removes the default section of that name", () => {
		const base = { cwd: "/tmp", selectedTools: ["bash"], contextFiles: [] };
		expect(buildSystemPrompt(base)).toContain("<docs>");
		const trimmed = buildSystemPrompt({ ...base, sections: { docs: "" } });
		expect(trimmed).not.toContain("<docs>");
		expect(trimmed).toContain("<rules>");
	});

	test("carries no skills section: the skill tool lists them", () => {
		const prompt = buildSystemPrompt({ cwd: "/tmp", selectedTools: ["bash", "skill"], contextFiles: [] });
		expect(prompt).not.toMatch(/<skills>|<available_skills>/);
	});

	describe("empty tools", () => {
		test("leaves the tools section out for an empty tools list", () => {
			const prompt = buildSystemPrompt({
				selectedTools: [],
				contextFiles: [],
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
				cwd: process.cwd(),
			});

			expect(prompt).toContain("- bash: Execute bash commands");
		});
	});

	describe("custom tool snippets", () => {
		test("only points to native schema lookup when the management tool is declared", () => {
			const options = {
				cwd: "/tmp",
				selectedTools: ["mcp"],
				onDemandTools: ["archive"],
				toolSnippets: { archive: "Search sessions" },
			};
			expect(buildSystemPromptSections(options).tools).toContain("`mcp`");
			const hidden = buildSystemPromptSections({ ...options, hiddenTools: ["mcp"] }).tools;
			expect(hidden).toContain("archive");
			expect(hidden).not.toContain("`mcp`");
		});

		test("includes custom tools in available tools section when promptSnippet is provided", () => {
			const prompt = buildSystemPrompt({
				selectedTools: ["read", "dynamic_tool"],
				toolSnippets: {
					dynamic_tool: "Run dynamic test behavior",
				},
				contextFiles: [],
				cwd: process.cwd(),
			});

			expect(prompt).toContain("- dynamic_tool: Run dynamic test behavior");
		});

		test("omits custom tools from available tools section when promptSnippet is not provided", () => {
			const prompt = buildSystemPrompt({
				selectedTools: ["read", "dynamic_tool"],
				contextFiles: [],
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
				cwd: process.cwd(),
			});

			expect(prompt).toContain("- Use dynamic_tool for project summaries.");
		});

		test("deduplicates and trims promptGuidelines", () => {
			const prompt = buildSystemPrompt({
				selectedTools: ["read", "dynamic_tool"],
				promptGuidelines: ["Use dynamic_tool for summaries.", "  Use dynamic_tool for summaries.  ", "   "],
				contextFiles: [],
				cwd: process.cwd(),
			});

			expect(prompt.match(/- Use dynamic_tool for summaries\./g)).toHaveLength(1);
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
			const linked = join(root, "main", ".octocode", "agent", "worktrees", "feat");
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
		const base = { cwd: "/tmp", selectedTools: ["bash"], contextFiles: [] };
		expect(Object.keys(buildSystemPromptSections(base))).not.toContain("environment");
		const sections = buildSystemPromptSections({ ...base, environment: "Date: 2026-10-28" });
		expect(Object.keys(sections).slice(-3)).toEqual(["environment", "environment:date", "environment:/"]);
		expect(sections.environment).toBe("<environment>");
		expect(sections["environment:date"]).toBe("Date: 2026-10-28");
		expect(sections["environment:/"]).toBe("</environment>");
	});
});

describe("base sections", () => {
	const base = {
		cwd: "/tmp",
		selectedTools: ["bash"],
		contextFiles: [{ path: "/tmp/AGENTS.md", content: "Project rules." }],
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
			"mcps:/",
			"other_base",
			"addendum",
			"project_context",
			"project_context:/tmp/AGENTS.md",
			"project_context:/",
			"octocode",
			"cwd",
			"environment",
			"environment:date",
			"environment:/",
		]);
		expect(buildSystemPromptSections(base).mcps).toBe("<mcps>\nservers");
	});

	test("follow the preamble of a custom prompt, and stay after rules when a subagent removes docs", () => {
		expect(Object.keys(buildSystemPromptSections({ ...base, customPrompt: "Custom." })).slice(0, 4)).toEqual([
			"preamble",
			"mcps",
			"mcps:/",
			"other_base",
		]);
		const child = buildSystemPromptSections({ ...base, sections: { docs: "" } });
		expect(Object.keys(child).slice(0, 5)).toEqual(["preamble", "rules", "mcps", "mcps:/", "other_base"]);
	});

	test("reject invalid section names and drop empty ones", () => {
		expect(() => buildSystemPromptSections({ ...base, baseSections: { "Bad Name": "x" } })).toThrow(
			"Invalid system prompt section name",
		);
		expect(Object.keys(buildSystemPromptSections({ ...base, baseSections: { mcps: "" } }))).not.toContain("mcps");
	});
});

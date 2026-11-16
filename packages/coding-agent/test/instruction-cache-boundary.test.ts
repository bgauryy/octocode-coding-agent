import { afterEach, describe, expect, it, vi } from "vitest";
import { splitSystemMessageIntoBlocks } from "@octocodeai/octocode-ai/utils/instruction-split";
import {
	findInstructionCacheBoundary,
	findInstructionVolatileBoundary,
	instructionCacheBoundaryOption,
} from "../src/core/model-runtime/instruction-boundary.ts";
import { buildSystemPromptSections } from "../src/core/system-prompt.ts";

const system = (sections?: Record<string, string | null>) => [
	{ role: "system", content: sections ? "" : "forced", ...(sections ? { sections } : {}), timestamp: 0 },
	{ role: "user", content: "hi", timestamp: 1 },
];

afterEach(() => vi.unstubAllEnvs());

describe("instruction cache boundary", () => {
	it("is the first present session section, in prompt order", () => {
		const base = { preamble: "p", tools: "t", rules: "r", docs: "d" };
		expect(findInstructionCacheBoundary(system({ ...base, addendum: "a", project_context: "pc", cwd: "c" }))).toBe(
			"addendum",
		);
		expect(findInstructionCacheBoundary(system({ ...base, project_context: "pc", skills: "s", cwd: "c" }))).toBe(
			"project_context",
		);
		expect(findInstructionCacheBoundary(system({ ...base, skills: "s", cwd: "c" }))).toBe("skills");
		expect(findInstructionCacheBoundary(system({ ...base, cwd: "c", octocode: "o" }))).toBe("cwd");
		expect(findInstructionCacheBoundary(system({ ...base, environment: "e", octocode: "o" }))).toBe("environment");
	});

	it("leaves base sections such as the MCP server blocks in the first block", () => {
		const sections = {
			preamble: "p",
			tools: "t",
			rules: "r",
			docs: "d",
			mcps: "f",
			project_context: "pc",
		};
		expect(findInstructionCacheBoundary(system({ ...sections, cwd: "c" }))).toBe("project_context");
		expect(findInstructionCacheBoundary(system({ preamble: "p", mcps: "f", cwd: "c" }))).toBe("cwd");
	});

	it("gives byte-identical first blocks to sessions that differ only in cwd and date", () => {
		const build = (cwd: string, date: string) => {
			const sections = buildSystemPromptSections({
				cwd,
				selectedTools: ["bash"],
				contextFiles: [],
				skills: [],
				environment: `Date: ${date}`,
				baseSections: { mcps: "docs file" },
				sections: { octocode: "Policy." },
			});
			const boundary = findInstructionCacheBoundary(system(sections));
			const names = Object.keys(sections);
			const first = names.slice(0, names.indexOf(boundary!)).map((name) => sections[name]);
			return { boundary, first: first.join("\n\n") };
		};
		const one = build("/work/one", "2026-10-28");
		const two = build("/work/two", "2026-10-29");
		// `cwd` is volatile now: the unknown `octocode` section ends the session tier, so the first known one is `cwd`.
		expect(one.boundary).toBe("cwd");
		expect(one.first).toContain("docs file");
		expect(one.first).toBe(two.first);
	});

	it("leaves blocks one and two byte-identical when only the date, the directory or mcp_status changes", () => {
		const build = (cwd: string, date: string, status?: string) => {
			const sections = buildSystemPromptSections({
				cwd,
				selectedTools: ["bash"],
				contextFiles: [{ path: "/work/AGENTS.md", content: "Project rules." }],
				skills: [],
				environment: `Date: ${date}`,
				baseSections: { mcps: "docs file" },
				sections: { work: "Policy.", ...(status ? { mcp_status: status } : {}) },
			});
			const messages = system(sections);
			const options = instructionCacheBoundaryOption(messages);
			const blocks = splitSystemMessageIntoBlocks(
				messages[0] as never,
				options.instructionCacheBoundary,
				options.instructionVolatileBoundary,
			)!;
			return { options, blocks, text: Object.values(sections).join("\n\n") };
		};
		const one = build("/work/one", "2026-10-28");
		expect(one.options).toEqual({ instructionCacheBoundary: "work", instructionVolatileBoundary: "cwd" });
		expect(one.blocks.cached).toHaveLength(2);
		expect(one.blocks.cached[0]).toContain("docs file");
		expect(one.blocks.cached[1]).toContain("Policy.");
		expect(one.blocks.cached[1]).toContain("Project rules.");
		expect(one.blocks.cached.join("")).not.toMatch(/\/work\/one|2026-10-28/);
		expect(one.blocks.volatile).toMatch(/^<cwd>\n\/work\/one\n<\/cwd>/);
		// Providers without explicit breakpoints send the sections joined in order: the same bytes as the blocks.
		expect([...one.blocks.cached, one.blocks.volatile].join("")).toBe(one.text);
		for (const other of [
			build("/work/one", "2026-10-29"),
			build("/work/two", "2026-10-28"),
			build("/work/one", "2026-10-28", "- docs: connecting"),
		]) {
			expect(other.blocks.cached).toEqual(one.blocks.cached);
			expect(other.blocks.volatile).not.toBe(one.blocks.volatile);
		}
	});

	it("starts the volatile block at the first of the volatile sections that end the prompt", () => {
		const base = { preamble: "p", docs: "d", work: "w" };
		expect(findInstructionVolatileBoundary(system({ ...base, cwd: "c", environment: "e", mcp_status: "m" }))).toBe(
			"cwd",
		);
		expect(findInstructionVolatileBoundary(system({ ...base, environment: "e" }))).toBe("environment");
		expect(findInstructionVolatileBoundary(system({ ...base, cwd: "c", environment: null }))).toBe("cwd");
		// A session saved before `cwd` moved keeps it ahead of the policy: only the trailing run is volatile.
		expect(findInstructionVolatileBoundary(system({ preamble: "p", cwd: "c", work: "w", environment: "e" }))).toBe(
			"environment",
		);
		expect(findInstructionVolatileBoundary(system(base))).toBeUndefined();
		expect(findInstructionVolatileBoundary(system({ ...base, cwd: "c", octocode: "o" }))).toBeUndefined();
		expect(findInstructionVolatileBoundary(system())).toBeUndefined();
		expect(findInstructionVolatileBoundary([])).toBeUndefined();
	});

	it("starts after a removed docs section too, as in a subagent prompt", () => {
		expect(findInstructionCacheBoundary(system({ preamble: "p", tools: "t", rules: "r", cwd: "c" }))).toBe("cwd");
		expect(findInstructionCacheBoundary(system({ preamble: "p", docs: null, cwd: "c" }))).toBe("cwd");
	});

	it("is absent for a forced prompt, a prompt with no session section, and an empty transcript", () => {
		expect(findInstructionCacheBoundary(system())).toBeUndefined();
		expect(findInstructionCacheBoundary(system({ preamble: "p", tools: "t", rules: "r", docs: "d" }))).toBeUndefined();
		expect(findInstructionCacheBoundary(system({ preamble: "p", docs: "d", octocode: "o" }))).toBeUndefined();
		expect(findInstructionCacheBoundary([])).toBeUndefined();
	});

	it("honors a caller-supplied boundary and the off switch", () => {
		const messages = system({ preamble: "p", docs: "d", cwd: "c" });
		const both = { instructionCacheBoundary: "cwd", instructionVolatileBoundary: "cwd" };
		expect(instructionCacheBoundaryOption(messages)).toEqual(both);
		// Each caller-supplied value is kept, and the other is still filled in.
		expect(instructionCacheBoundaryOption(messages, { instructionCacheBoundary: "custom" })).toEqual({
			instructionVolatileBoundary: "cwd",
		});
		expect(instructionCacheBoundaryOption(messages, { instructionVolatileBoundary: "custom" })).toEqual({
			instructionCacheBoundary: "cwd",
		});
		expect(instructionCacheBoundaryOption(messages, both)).toEqual({});
		expect(instructionCacheBoundaryOption(messages, { env: { OCTOCODE_INSTRUCTION_CACHE_SPLIT: "off" } })).toEqual({});
		vi.stubEnv("OCTOCODE_INSTRUCTION_CACHE_SPLIT", "OFF");
		expect(instructionCacheBoundaryOption(messages)).toEqual({});
		vi.stubEnv("OCTOCODE_INSTRUCTION_CACHE_SPLIT", "on");
		expect(instructionCacheBoundaryOption(messages)).toEqual(both);
	});

	it("ends the shared tool prefix at the first role-variant tool of the initial tools", () => {
		const withTools = (names: string[]) => [
			{
				role: "system",
				content: "",
				sections: { preamble: "p", cwd: "c" },
				toolsAdded: names.map((name) => ({ name, description: name, parameters: {} })),
				timestamp: 0,
			},
			{ role: "user", content: "hi", timestamp: 1 },
		];
		const roleVariantTools = new Set(["archive", "memory", "agent", "skill"]);
		const tools = ["bash", "file", "web", "mcp", "wait", "mcp__octocode__localSearch", "archive", "memory", "agent"];
		expect(instructionCacheBoundaryOption(withTools(tools), { roleVariantTools }).toolCacheBoundary).toBe("archive");
		expect(
			instructionCacheBoundaryOption(withTools(["bash", "agent", "skill"]), { roleVariantTools }).toolCacheBoundary,
		).toBe("agent");
		// No role-variant tool, or one first: nothing to share apart from the last tool's own marker.
		expect(instructionCacheBoundaryOption(withTools(["bash", "file"]), { roleVariantTools })).not.toHaveProperty(
			"toolCacheBoundary",
		);
		expect(instructionCacheBoundaryOption(withTools(["agent", "bash"]), { roleVariantTools })).not.toHaveProperty(
			"toolCacheBoundary",
		);
		// Without the declared set no tool is role-variant, so no boundary is set.
		expect(instructionCacheBoundaryOption(withTools(tools))).not.toHaveProperty("toolCacheBoundary");
		// A caller's value and the off switch, as for the instruction boundaries.
		expect(
			instructionCacheBoundaryOption(withTools(tools), { toolCacheBoundary: "x", roleVariantTools }),
		).not.toHaveProperty("toolCacheBoundary");
		expect(
			instructionCacheBoundaryOption(withTools(tools), {
				env: { OCTOCODE_INSTRUCTION_CACHE_SPLIT: "off" },
				roleVariantTools,
			}),
		).toEqual({});
	});
});

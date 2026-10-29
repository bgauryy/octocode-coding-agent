import { afterEach, describe, expect, it, vi } from "vitest";
import {
	findInstructionCacheBoundary,
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

	it("leaves base sections such as MCP server contracts in the first block", () => {
		const sections = {
			preamble: "p",
			tools: "t",
			rules: "r",
			docs: "d",
			mcp_contract_docs: "f",
			project_context: "pc",
		};
		expect(findInstructionCacheBoundary(system({ ...sections, cwd: "c" }))).toBe("project_context");
		expect(findInstructionCacheBoundary(system({ preamble: "p", mcp_contract_docs: "f", cwd: "c" }))).toBe("cwd");
	});

	it("gives byte-identical first blocks to sessions that differ only in cwd and date", () => {
		const build = (cwd: string, date: string) => {
			const sections = buildSystemPromptSections({
				cwd,
				selectedTools: ["bash"],
				contextFiles: [],
				skills: [],
				environment: `Date: ${date}`,
				baseSections: { mcp_contract_docs: "docs file" },
				sections: { octocode: "Policy." },
			});
			const boundary = findInstructionCacheBoundary(system(sections));
			const names = Object.keys(sections);
			const first = names.slice(0, names.indexOf(boundary!)).map((name) => sections[name]);
			return { boundary, first: first.join("\n\n") };
		};
		const one = build("/work/one", "2026-10-28");
		const two = build("/work/two", "2026-10-29");
		expect(one.boundary).toBe("cwd");
		expect(one.first).toContain("docs file");
		expect(one.first).toBe(two.first);
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
		expect(instructionCacheBoundaryOption(messages)).toEqual({ instructionCacheBoundary: "cwd" });
		expect(instructionCacheBoundaryOption(messages, { instructionCacheBoundary: "custom" })).toEqual({});
		expect(instructionCacheBoundaryOption(messages, { env: { OCTOCODE_INSTRUCTION_CACHE_SPLIT: "off" } })).toEqual({});
		vi.stubEnv("OCTOCODE_INSTRUCTION_CACHE_SPLIT", "OFF");
		expect(instructionCacheBoundaryOption(messages)).toEqual({});
		vi.stubEnv("OCTOCODE_INSTRUCTION_CACHE_SPLIT", "on");
		expect(instructionCacheBoundaryOption(messages)).toEqual({ instructionCacheBoundary: "cwd" });
	});
});

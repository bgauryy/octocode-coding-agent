import { describe, expect, test } from "vitest";
import { MCP_STATUS_SECTION, MCPS_SECTION } from "../../mcp/src/section.ts";
import { findInstructionCacheBoundary } from "../src/core/model-runtime/instruction-boundary.ts";
import { buildSystemPromptSections, diffSystemPromptSections } from "../src/core/system-prompt.ts";
import { SYSTEM_PROMPT_SECTIONS, systemPromptSectionSpec } from "../src/core/system-prompt-spec.ts";
import { leanPromptSections } from "../src/octocode/instructions/lean.ts";
import { octocodePromptSections } from "../src/octocode/instructions/policy.ts";
import { FAKE_RESEARCH } from "./octocode/fake-research.ts";

describe("system prompt section spec", () => {
	test("pins every section's order, tier and custom-prompt rule", () => {
		expect(
			SYSTEM_PROMPT_SECTIONS.map(({ name, tier, underCustomPrompt }) => `${name}:${tier}:${underCustomPrompt}`),
		).toEqual([
			"preamble:base:replace",
			"tools:base:keep",
			"rules:base:keep",
			"docs:base:drop",
			"mcps:base:keep",
			"addendum:session:keep",
			"cwd:session:keep",
			"work:session:keep",
			"research:session:keep",
			"delegation:session:keep",
			"safety:session:keep",
			"communication:session:keep",
			"lean:session:keep",
			"project_context:session:keep",
			"skills:session:keep",
			"hooks:session:keep",
			"role:session:keep",
			"harnesses:session:keep",
			"environment:volatile:keep",
			"planning:volatile:keep",
			"mcp_status:volatile:keep",
		]);
	});

	test("declares every section name the native producers write", () => {
		const policy = octocodePromptSections({ research: FAKE_RESEARCH, canDelegate: true, profiles: [] });
		const lean = leanPromptSections({ canShell: true, canSave: true, readOnly: false });
		const produced = [
			...Object.keys(policy),
			...Object.keys(lean),
			"role",
			"planning",
			MCPS_SECTION,
			MCP_STATUS_SECTION,
		];
		for (const name of produced)
			expect(systemPromptSectionSpec(name), name).toMatchObject({
				name,
				tier: expect.stringMatching(/^(base|session|volatile)$/),
			});
	});

	test("a custom prompt keeps tools, guidelines, MCP servers, skills and policy, and drops only docs and default lines", () => {
		const sections = buildSystemPromptSections({
			customPrompt: "You are Exact.",
			cwd: "/tmp",
			selectedTools: ["bash", "file", "skill"],
			toolSnippets: { bash: "Run commands", file: "Change files", skill: "Load a skill" },
			toolGuidelines: { file: ["Prefer file over shell redirection"] },
			skills: [
				{
					name: "demo",
					description: "Demo skill",
					filePath: "/tmp/demo/SKILL.md",
					baseDir: "/tmp/demo",
					source: "test",
					disableModelInvocation: false,
				} as never,
			],
			baseSections: { [MCPS_SECTION]: '<mcp name="docs" tools="mcp__docs__*">Docs</mcp>' },
			sections: { work: "Work.", [MCP_STATUS_SECTION]: "- docs: connecting" },
			environment: "Date: 2026-10-31",
		});
		expect(sections.preamble).toBe("You are Exact.");
		expect(sections.tools).toBe("<tools>\n- bash: Run commands\n- file: Change files\n- skill: Load a skill\n</tools>");
		expect(sections.rules).toBe("<rules>\n- Prefer file over shell redirection\n</rules>");
		expect(sections.docs).toBeUndefined();
		expect(Object.keys(sections)).toEqual([
			"preamble",
			"tools",
			"rules",
			MCPS_SECTION,
			"cwd",
			"work",
			"skills",
			"environment",
			MCP_STATUS_SECTION,
		]);
		// An empty custom section still removes a section.
		expect(buildSystemPromptSections({ customPrompt: "X", cwd: "/tmp", sections: { cwd: "" } }).cwd).toBeUndefined();
	});

	test("the second cache block starts at the first section outside the base tier", () => {
		const sections = buildSystemPromptSections({
			cwd: "/tmp",
			selectedTools: [],
			baseSections: { [MCPS_SECTION]: "servers" },
			sections: { work: "Work." },
		});
		const message = { role: "system", content: "", sections, timestamp: 0 };
		expect(findInstructionCacheBoundary([message])).toBe("cwd");
	});

	test("a resumed session with the old MCP sections migrates by the section diff", () => {
		const current = buildSystemPromptSections({
			cwd: "/tmp",
			selectedTools: [],
			baseSections: { [MCPS_SECTION]: "servers" },
		});
		const old = {
			...current,
			mcp_contract_octocode: "<mcp_contract_octocode>\nold\n</mcp_contract_octocode>",
			mcp_status: "<mcp_status>\nold\n</mcp_status>",
		} as Record<string, string>;
		delete old[MCPS_SECTION];
		expect(diffSystemPromptSections(old, current)).toEqual({
			[MCPS_SECTION]: "<mcps>\nservers\n</mcps>",
			mcp_contract_octocode: null,
			mcp_status: null,
		});
	});
});

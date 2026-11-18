import { describe, expect, it } from "vitest";
import type { HarnessStatus } from "../../src/core/discovery/vendors/types.ts";
import { buildSystemPromptSections } from "../../src/core/system-prompt.ts";
import { SYSTEM_PROMPT_SECTIONS, systemPromptSectionSpec } from "../../src/core/system-prompt-spec.ts";

describe("instruction context edges", () => {
	it("places the harnesses section in the session tier after role", () => {
		const octocode: HarnessStatus = {
			id: "octocode",
			label: "Octocode",
			on: true,
			defaultOn: true,
			switchable: false,
			found: {},
			loaded: {},
		};
		const sections = buildSystemPromptSections({
			cwd: "/tmp",
			selectedTools: [],
			harnesses: [octocode],
			sections: { role: "Role." },
			environment: "Date: 2026-11-08",
		});
		expect(systemPromptSectionSpec("harnesses")).toMatchObject({ name: "harnesses", tier: "session" });
		const order = SYSTEM_PROMPT_SECTIONS.map((spec) => spec.name);
		expect(order.indexOf("harnesses")).toBe(order.indexOf("role") + 1);
		expect(order.indexOf("cwd")).toBe(order.indexOf("harnesses") + 1);
		expect(Object.keys(sections).slice(-6)).toEqual([
			"role",
			"harnesses",
			"cwd",
			"environment",
			"environment:date",
			"environment:/",
		]);
	});
});

import { readFileSync } from "node:fs";
import { expect, it } from "vitest";
import { validateCodexOutput } from "../../src/octocode/hooks/codex-output.ts";

const contract: {
	revision: string;
	fixtures: { event: string; output: Record<string, unknown>; valid: boolean }[];
} = JSON.parse(readFileSync(new URL("../fixtures/hooks/codex-output-contract.json", import.meta.url), "utf8"));

it("retains the complete pinned upstream corpus", () => {
	expect(contract.revision).toBe("8eaf5fd115f036d207be236009938261758e30f2");
	expect(contract.fixtures).toHaveLength(2816);
});

it.each([
	"PermissionRequest",
	"PreToolUse",
	"PostToolUse",
	"SessionStart",
	"PreCompact",
	"PostCompact",
	"UserPromptSubmit",
	"Stop",
	"SubagentStart",
	"SubagentStop",
	"Interrupt",
])("matches upstream Codex %s output acceptance", (event) => {
	const fixtures = contract.fixtures.filter((fixture) => fixture.event === event);
	expect(fixtures).toHaveLength(event === "PermissionRequest" ? 496 : 232);
	for (const fixture of fixtures) {
		expect(validateCodexOutput(event, fixture.output) === undefined, JSON.stringify(fixture.output)).toBe(
			fixture.valid,
		);
	}
});

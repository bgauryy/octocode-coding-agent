import { describe, expect, it } from "vitest";
import { READ_ONLY_ENV, SUBAGENT_ENV } from "@octocodeai/octocode-common/env";
import { coordinateGuidelines } from "../../src/octocode/native/tools/coordinate/guidelines.ts";

const text = (subagent: boolean, env: NodeJS.ProcessEnv) => coordinateGuidelines(subagent, env).join("\n");

describe("coordinate guideline", () => {
	it("gives a read-only role no lock or edit guidance", () => {
		const out = text(true, { [SUBAGENT_ENV]: "1", [READ_ONLY_ENV]: "1" });
		expect(out).toContain("`list`");
		expect(out).toContain("`changes`");
		expect(out).not.toMatch(/\block\b|reserved for you|editing|edit wave/);
	});

	it("keeps lock and edit guidance for a writable subagent and the main session", () => {
		expect(text(true, { [SUBAGENT_ENV]: "1" })).toMatch(/lock those files with `agent` type `coordinate`/);
		expect(text(false, {})).toMatch(/lock your paths with `agent` type `coordinate`/);
	});

	it("ignores a read-only flag that is not inside a subagent", () => {
		expect(text(false, { [READ_ONLY_ENV]: "1" })).toMatch(/lock your paths/);
	});
});

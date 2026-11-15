import { readFileSync } from "node:fs";
import { expect, it } from "vitest";

it("names no removed debug tool in role tool lists", () => {
	for (const name of ["researcher", "reviewer"]) {
		const role = readFileSync(new URL(`../../src/octocode/instructions/roles/${name}.md`, import.meta.url), "utf8");
		expect(role).not.toMatch(/^(?:tools|excludeTools):.*\bdebug\b/m);
	}
});

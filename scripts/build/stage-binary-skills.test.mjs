import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { stageCodingAgentSkills } from "./stage-binary.mjs";

test("standalone staging preserves the installed collection and supporting bytes", () => {
	const root = mkdtempSync(join(tmpdir(), "stage-skills-"));
	try {
		writeFileSync(join(root, "package.json"), "{}");
		const dependency = join(root, "node_modules", "octocode");
		const source = join(dependency, "skills");
		mkdirSync(join(source, "one", "scripts"), { recursive: true });
		writeFileSync(join(dependency, "package.json"), '{"name":"octocode"}');
		writeFileSync(join(source, "one", "SKILL.md"), "skill");
		writeFileSync(join(source, "one", "scripts", "helper.mjs"), "export const value = 42;");
		const result = stageCodingAgentSkills(root, join(root, "dist", "skills"));
		assert.deepEqual(result.skills, ["one"]);
		assert.equal(readFileSync(join(result.target, "one", "scripts", "helper.mjs"), "utf8"), "export const value = 42;");
		assert.deepEqual(stageCodingAgentSkills(root, join(root, "dist", "skills")), result);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { loadSkillsFromDir } from "../src/core/skills.ts";
import { SkillListing } from "../src/core/skills/listing.ts";
const roots: string[] = [];
afterEach(() => {
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
function load(yaml: string, protocol?: "codex" | "claude", frontmatter = "") {
	const root = mkdtempSync(join(tmpdir(), "codex-skill-policy-"));
	roots.push(root);
	mkdirSync(join(root, "agents"));
	writeFileSync(join(root, "SKILL.md"), `---\nname: sample\ndescription: Test skill\n${frontmatter}---\nSkill body`);
	writeFileSync(join(root, "agents/openai.yaml"), yaml);
	return loadSkillsFromDir({ dir: root, source: "test", protocol });
}
it("keeps explicitly invocable skills out of the implicit catalog", () => {
	const result = load("policy: {allow_implicit_invocation: false}");
	expect(result.skills).toHaveLength(1);
	expect(result.skills[0].disableModelInvocation).toBe(true);
	expect(result.skills[0].userInvocable).not.toBe(false);
	expect(SkillListing.fromSkills(result.skills).render()).not.toContain("Test skill");
});
it("excludes product-restricted skills without assuming a vendor identity", () => {
	const result = load("policy: {products: [CODEX]}", "codex");
	expect(result.skills).toHaveLength(0);
	expect(result.diagnostics.some((d) => d.message.includes("product"))).toBe(true);
});
it("ignores Codex metadata for the Claude dialect", () =>
	expect(load("policy: {allow_implicit_invocation: false}", "claude").skills[0].disableModelInvocation).toBe(false));
it("does not override native opt-out", () =>
	expect(
		load("policy: {allow_implicit_invocation: true}", undefined, "disable-model-invocation: true\n").skills[0]
			.disableModelInvocation,
	).toBe(true));
it("discards the entire malformed optional metadata without echoing its content", () => {
	const result = load("policy: {allow_implicit_invocation: false}\ndependencies: {tools: [{command: [SECRET_VALUE]}]}");
	expect(result.skills[0].disableModelInvocation).toBe(false);
	expect(result.diagnostics.length).toBeGreaterThan(0);
	expect(JSON.stringify(result.diagnostics)).not.toContain("SECRET_VALUE");
});
it("accepts serde string scalars while retaining implicit opt-out", () =>
	expect(
		load("policy: {allow_implicit_invocation: false}\ninterface: {display_name: 1}").skills[0].disableModelInvocation,
	).toBe(true));

it("ignores a directory at the optional sidecar path like the upstream probe", () => {
	load("");
	const root = roots.at(-1)!;
	rmSync(join(root, "agents/openai.yaml"));
	mkdirSync(join(root, "agents/openai.yaml"));
	const result = loadSkillsFromDir({ dir: root, source: "test" });
	expect(result.skills).toHaveLength(1);
	expect(result.skills[0].disableModelInvocation).toBe(false);
	expect(result.diagnostics).toEqual([]);
});
it("does not apply a sibling sidecar to loose Markdown commands", () => {
	load("policy: {allow_implicit_invocation: false}");
	const root = roots.at(-1)!;
	rmSync(join(root, "SKILL.md"));
	writeFileSync(join(root, "command.md"), "---\nname: sample\ndescription: Test command\n---\nBody");
	const result = loadSkillsFromDir({ dir: root, source: "test" });
	expect(result.skills).toHaveLength(1);
	expect(result.skills[0].disableModelInvocation).toBe(false);
});

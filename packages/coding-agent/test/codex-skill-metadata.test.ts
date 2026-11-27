import { readFileSync } from "node:fs";
import { expect, it } from "vitest";
import { parseCodexSkillMetadata } from "../src/core/codex-skill-metadata.ts";
const corpus = JSON.parse(
	readFileSync(new URL("./fixtures/codex-skill-metadata/corpus.json", import.meta.url), "utf8"),
);
for (const fixture of corpus.cases)
	it(fixture.id, () => {
		if (!fixture.expected.ok) {
			expect(() => parseCodexSkillMetadata(fixture.yaml)).toThrow();
			return;
		}
		const value = parseCodexSkillMetadata(fixture.yaml);
		expect(value.policy?.allowImplicitInvocation ?? null).toBe(
			fixture.expected.policy?.allow_implicit_invocation ?? null,
		);
		expect(value.policy?.products ?? []).toEqual(fixture.expected.policy?.products ?? []);
		expect(value.interfaceDeclared).toBe(fixture.expected.has_interface);
	});

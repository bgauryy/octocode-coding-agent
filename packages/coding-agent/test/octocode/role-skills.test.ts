import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { getBundledSkillsDir, getNativeSkillsDir } from "../../src/config.ts";

const rolesDir = fileURLToPath(new URL("../../src/octocode/instructions/roles/", import.meta.url));

/** The skill names a role's frontmatter lists (`skills: a, b`; `[]` is none). */
function roleSkills(file: string): string[] {
	const front = /^---\n([\s\S]*?)\n---/.exec(fs.readFileSync(path.join(rolesDir, file), "utf8"))?.[1] ?? "";
	const value = /^skills:\s*(.*)$/m.exec(front)?.[1]?.trim() ?? "";
	return value
		.replace(/^\[|\]$/g, "")
		.split(",")
		.map((name) => name.trim())
		.filter(Boolean);
}

describe("skills named by bundled roles", () => {
	const roles = fs.readdirSync(rolesDir).filter((file) => file.endsWith(".md") && file !== "README.md");

	it.each(roles)("%s names only skills the application ships", (file) => {
		for (const name of roleSkills(file)) {
			const shipped = [getNativeSkillsDir(), getBundledSkillsDir()].some((dir) =>
				fs.existsSync(path.join(dir, name, "SKILL.md")),
			);
			expect(
				shipped,
				`${file} names skill ${name}, which is neither a core native skill nor in the bundled collection`,
			).toBe(true);
		}
	});

	it("gives the implementer the debugging skill and the research roles the research skill", () => {
		expect(roleSkills("implementer.md")).toEqual(["octocode-debugging"]);
		expect(roleSkills("researcher.md")).toEqual(["octocode-research"]);
		expect(roleSkills("reviewer.md")).toEqual(["octocode-research"]);
		expect(roleSkills("browser.md")).toEqual(["octocode-chrome-devtools"]);
	});
});

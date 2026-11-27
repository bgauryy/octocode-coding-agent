import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { getNativeSkillsDir } from "../../src/config.ts";

const rolesDir = fileURLToPath(new URL("../../src/octocode/native/agents/", import.meta.url));

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
			expect(
				fs.existsSync(path.join(getNativeSkillsDir(), name, "SKILL.md")),
				`${file} names skill ${name}, which is not a core native skill`,
			).toBe(true);
		}
	});

	it("gives the bundled roles no default skill, so a child does not carry the whole catalog", () => {
		for (const file of roles) expect(roleSkills(file), file).toEqual([]);
	});
});

import fs from "node:fs";
import path from "node:path";
import { expandClaudeArguments, expandClaudeVariables } from "../../core/claude-arguments.ts";
import { renderPrompt } from "../../core/prompt-template.ts";
import { type SkillCategory, skillCategory } from "../../core/skills/category.ts";
import { stripFrontmatter } from "../../utils/frontmatter.ts";
import { repoKey } from "../../utils/git-repository.ts";
import type { CatalogSkill } from "./catalog.ts";
import { skillOrigin } from "./render.ts";

/** What a skill load reports beside its text: shown on the row, and read back by compaction to name the loaded skills. */
export interface SkillDetails {
	name: string;
	location: string;
	baseDir: string;
	lines: number;
	/** Where the skill came from (`skillOrigin`), shown on the row. */
	origin?: string;
	/** Its listing group (`skillCategory`): core, octocode, workspace or global. */
	category?: SkillCategory;
	/** Its description as listed, shown above the instructions. */
	description?: string;
}

function body(entry: CatalogSkill, sessionId: string, cwd: string): string {
	// The catalog's snapshot is validated once per loaded skill list: the file read now must still be the one captured.
	if (fs.realpathSync(entry.file) !== entry.file || !fs.statSync(entry.file).isFile())
		throw new Error("its file now resolves to another path");
	const raw = stripFrontmatter(fs.readFileSync(entry.file, "utf8")).trim();
	const { skill } = entry;
	// The same expansion `/skill:name` does, without arguments: a Claude skill's `${CLAUDE_*}` values resolve here too.
	return skill.argumentStyle === "claude"
		? expandClaudeVariables(expandClaudeArguments(raw, "", [], skill.argumentNames), {
				sessionId,
				projectDir: repoKey(cwd).root,
				skillDir: path.dirname(entry.file),
				pluginRoot: skill.claudePluginRoot,
				pluginData: skill.claudePluginData,
			})
		: raw;
}

/**
 * A catalog skill as the model loads it: the `<skill>` block (the directory its references resolve against, then its
 * instructions) and the details that record the load. The `skill` tool and the first-use delivery share it, so both
 * read the same file the same way.
 */
export function loadSkill(
	entry: CatalogSkill,
	sessionId: string,
	cwd: string,
): { text: string; block: string; details: SkillDetails } {
	const { skill } = entry;
	const text = body(entry, sessionId, cwd);
	const baseDir = path.dirname(entry.file);
	return {
		text,
		block: `<skill name="${skill.name}" location="${entry.file}">\n${renderPrompt("system/skill-references.md", { dir: baseDir })}\n\n${text}\n</skill>`,
		details: {
			name: skill.name,
			location: entry.file,
			baseDir,
			lines: text.split("\n").length,
			origin: skillOrigin(skill),
			category: skillCategory(skill),
			...(skill.description?.trim() ? { description: skill.description.trim() } : {}),
		},
	};
}

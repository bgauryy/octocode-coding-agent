import path from "node:path";
import { extraSkillDirs, extraSkillsEnabled } from "../skill/folders.ts";
import { tildePath } from "../shared/home.ts";
import { isDirectory } from "../../utils/fs-probe.ts";
import { claudeConfigDir } from "../../utils/host-config.ts";
import { loadSkills } from "../../core/skills.ts";
import type { InventoryItem } from "../../core/extensibility/inventory-types.ts";

const within = (file: string, dir: string) => file === dir || file.startsWith(dir + path.sep);

/**
 * One read-only row per skill folder the session loads besides the package resolver's: Claude's and Codex's skill
 * folders, Octocode's home and the project's `.claude/skills`. The resolver does not return them, so without a row
 * `/harness list skills` would omit skills that load. They have no switch here (`/skills` and the `skills` setting own
 * them), so the row is locked and names its skills.
 */
export function hostSkillItems(cwd: string, agentDir: string, projectTrusted: boolean, home?: string): InventoryItem[] {
	if (!extraSkillsEnabled()) return [];
	const paths = extraSkillDirs(cwd, home, projectTrusted);
	// A folder that held a `synced/` subtree is passed as its skill files; its root is still the folder.
	const roots = [...new Set([...paths.filter(isDirectory), path.join(claudeConfigDir(home), "skills")])].map((dir) =>
		path.resolve(dir),
	);
	const { skills } = loadSkills({ cwd, agentDir, skillPaths: paths, includeDefaults: false });
	const byRoot = new Map<string, string[]>();
	for (const skill of skills) {
		const file = path.resolve(skill.filePath);
		const root = roots.filter((dir) => within(file, dir)).sort((a, b) => b.length - a.length)[0] ?? path.dirname(file);
		byRoot.set(root, [...(byRoot.get(root) ?? []), skill.name]);
	}
	return [...byRoot]
		.sort(([a], [b]) => a.localeCompare(b))
		.map(([root, names]): InventoryItem => {
			const dir = tildePath(root, home);
			return {
				id: `skills-folder:${dir}`,
				host: "skills",
				kind: "skill",
				depth: 0,
				label: `${dir} (${names.length} skill${names.length === 1 ? "" : "s"}, read-only)`,
				on: true,
				detail: `${names.sort().join(", ")} · loaded from another agent's skill folder; switch them with /skills`,
				locked: "loaded from a skill folder shared with another agent; switch these with /skills",
				...(path.relative(cwd, root).startsWith("..") ? {} : { project: true as const }),
			};
		});
}

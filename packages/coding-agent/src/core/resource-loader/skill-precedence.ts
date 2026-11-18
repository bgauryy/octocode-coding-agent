import { join, resolve, sep } from "node:path";
import { claudeConfigDir, codexConfigDir } from "../../utils/host-config.ts";
import type { PathMetadata } from "../package-manager.ts";
import type { SkillPrecedence } from "../skills.ts";

export interface SkillPrecedenceContext {
	metadataByPath: Map<string, PathMetadata> | undefined;
	/** Paths a feature supplied (the host folders of other agents). */
	featurePaths: ReadonlySet<string>;
	agentDir: string;
}

/**
 * Where a skill path sits in the collision order against the skills bundled with this build:
 * - `bundled`: the bundle (metadata source `builtin`).
 * - `replaceable`: a copy another tool installed at user level, such as `npx octocode skill install` into `~/.agents/skills`,
 *   `~/.claude/skills` or `~/.pi/agent/skills`. Those folders are discovered automatically, so the user never chose them.
 * - undefined: a deliberate choice that beats the bundle: the agent directory, project folders, `skills` settings entries,
 *   packages and `--skill`.
 */
export function skillPathPrecedence(path: string, context: SkillPrecedenceContext): SkillPrecedence | undefined {
	const resolved = resolve(path);
	const metadata = context.metadataByPath?.get(resolved) ?? context.metadataByPath?.get(path);
	if (metadata) {
		if (metadata.source === "builtin") return "bundled";
		if (
			metadata.source === "auto" &&
			metadata.scope === "user" &&
			metadata.baseDir !== undefined &&
			resolve(metadata.baseDir) !== resolve(context.agentDir)
		)
			return "replaceable";
		return undefined;
	}
	return context.featurePaths.has(resolved) && isUnderHostSkillDir(resolved) ? "replaceable" : undefined;
}

/** The user-level `skills` folders of Claude Code and Codex, which the native feature adds. */
function isUnderHostSkillDir(path: string): boolean {
	const roots: string[] = [join(claudeConfigDir(), "skills")];
	try {
		roots.push(join(codexConfigDir(), "skills"));
	} catch {
		/* An invalid selected home names no folder. */
	}
	return roots.some((root) => path === root || path.startsWith(`${root}${sep}`));
}

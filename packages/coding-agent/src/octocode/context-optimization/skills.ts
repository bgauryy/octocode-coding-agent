/**
 * The skills listing an agent reads, after optimization: each skill's description is replaced by the rewrite stored
 * for its current source (`skills-store.ts`). Skills inside the session's repository are stored in the project's
 * folder, all others in the user folder (`contextOptimizationDirs`); a lookup reads the project's store first. A root
 * session records the skills it discovers whenever they change (startup, `/reload`, a changed `skills` setting);
 * subagents only read. The stores are read once per
 * session start and per change of the discovered skills, so a rewrite applied mid-session reaches agents at the next
 * start or `/reload`, not in the middle of a cached prompt.
 */

import path from "node:path";
import { getNativeSkillsDir } from "../../config.ts";
import type { ExtensionAPI } from "../../core/features/index.ts";
import type { Skill } from "../../core/skills.ts";
import { contextOptimizationDirs, inContextProject } from "../shared/home.ts";
import { isWithin } from "../../../../common/src/paths.ts";
import {
	effectiveDescription,
	readSkillsStore,
	type SkillSource,
	type SkillsStore,
	syncSkills,
	updateSkillsStore,
} from "./skills-store.ts";

/** Skills whose description reaches the model; the others are listed nowhere it reads. */
const listed = (skill: Skill) => !skill.disableModelInvocation && skill.description.trim() !== "";

/** Record `sources` in the store at `dir` and return it; a failed write only costs the record. */
async function record(dir: string, sources: readonly SkillSource[]): Promise<SkillsStore> {
	try {
		return await updateSkillsStore(
			dir,
			(current) => {
				const synced = syncSkills(current, sources);
				return synced.dirty ? synced.store : current;
			},
			"record",
		);
	} catch {
		// The store is a record for the next session and for tooling; this prompt reads it from memory.
		return syncSkills(readSkillsStore(dir), sources).store;
	}
}

export function registerSkillDescriptions(
	api: ExtensionAPI,
	options: { isSubagent: boolean; agentDir?: () => string },
): void {
	let frozen: { key: string; stores: SkillsStore[] } | undefined;
	api.on("session_start", async () => {
		frozen = undefined;
	});
	api.on("before_agent_start", async (event, ctx) => {
		const skills = event.systemPromptOptions.skills;
		if (!skills?.length) return undefined;
		const dirs = contextOptimizationDirs(ctx.cwd, options.agentDir?.());
		const sources = skills.filter(listed).map((skill) => ({
			name: skill.name,
			description: skill.description.trim(),
			file: skill.filePath,
		}));
		const key = JSON.stringify([dirs, sources]);
		if (frozen?.key !== key) {
			const project = dirs.project;
			let stores: SkillsStore[];
			if (options.isSubagent) {
				stores = [...(project ? [readSkillsStore(project.dir)] : []), readSkillsStore(dirs.user)];
			} else {
				// A bundled skill is user-level, also when Octocode runs from a checkout of its own repository.
				const bundled = getNativeSkillsDir();
				const inProject = (source: SkillSource) =>
					!isWithin(path.resolve(source.file), bundled) && inContextProject(dirs, source.file);
				const user = await record(
					dirs.user,
					sources.filter((source) => !inProject(source)),
				);
				stores = project ? [await record(project.dir, sources.filter(inProject)), user] : [user];
			}
			frozen = { key, stores };
		}
		const { stores } = frozen;
		event.systemPromptOptions.skills = skills.map((skill) => {
			if (!listed(skill)) return skill;
			const description = effectiveDescription(stores, skill.name, skill.description.trim());
			return description === skill.description ? skill : { ...skill, description };
		});
		return undefined;
	});
}

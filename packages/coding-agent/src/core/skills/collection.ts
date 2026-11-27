import { getNativeSkillsDir } from "../../config.ts";
import { skillName } from "../discovery/roots.ts";
import { collectSkillEntries } from "../package-manager/discovery.ts";

const coreNames = new Map<string, ReadonlySet<string>>();

/** The names of the core skills in `dir`, read once per folder: the shipped folder does not change while Octocode runs. */
function namesIn(dir: string): ReadonlySet<string> {
	let names = coreNames.get(dir);
	if (!names) {
		names = new Set(collectSkillEntries(dir, "octocode").map(skillName));
		coreNames.set(dir, names);
	}
	return names;
}

/**
 * The skill files of the Octocode collection (`getOctocodeSkillsDir`) that this build offers. A collection skill whose
 * name a core skill (`native/skills/`) also has is left out: both ship with Octocode, the core one is the harness's own
 * version and always wins, so the collection copy would only ever load as a duplicate the user cannot act on.
 */
export function collectionSkillFiles(dir: string, coreDir: string = getNativeSkillsDir()): string[] {
	const core = namesIn(coreDir);
	return collectSkillEntries(dir, "octocode").filter((file) => !core.has(skillName(file)));
}

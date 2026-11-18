import { clip } from "./text.ts";

/** The agents and bash jobs a `waiting` phase names, as the owners call them (an agent's name, a job's reason or command). */
export interface WaitNames {
	agents: readonly string[];
	bash: readonly string[];
}

const NAME_CLIP = 40;
const NAMES_SHOWN = 3;

/** `fix report, lock status, +2`: the first few names, each clipped to one short line. */
function nameList(names: readonly string[]): string {
	const shown = names.slice(0, NAMES_SHOWN).map((name) => clip(name.trim().split("\n", 1)[0] ?? "", NAME_CLIP));
	return names.length > NAMES_SHOWN ? `${shown.join(", ")}, +${names.length - NAMES_SHOWN}` : shown.join(", ");
}

/** `words` followed by its names in parentheses, when there are any. */
export const named = (words: string, names: readonly string[] | undefined) =>
	names && names.length > 0 ? `${words} (${nameList(names)})` : words;

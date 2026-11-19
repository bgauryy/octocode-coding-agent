import type { EditorWordHighlight } from "@octocodeai/octocode-tui";
import { stem } from "../history/rank/terms.ts";

/** A loaded skill's name and the extra words (`metadata.triggers`) that point to it. */
export interface SkillWordSource {
	name: string;
	triggers?: readonly string[];
}

/** A highlighted span of one line, as UTF-16 offsets: `start` inclusive, `end` exclusive, and the skills it points to. */
export interface SkillWordHit {
	start: number;
	end: number;
	skills: readonly string[];
}

/** Name parts too generic to steer a skill: they would colour ordinary prose. */
const GENERIC = new Set(["skill", "skills", "code", "local", "agentic", "clean", "test", "plan", "doc", "docs"]);
const PUNCTUATION = /^[("'[{<]+|[)"'\]}>.,;:!?]+$/gu;
const PLAIN_WORD = /^[\p{L}\p{N}]+$/u;
const EXPLICIT = /^[$/]([\w:-]+)$/;

/** Words that differ only by case, an inflection or a doubled final letter (`debugging`, `debugs`) share one key. */
function wordKey(word: string): string {
	return stem(word.toLowerCase()).replace(/([^aeiou\d])\1$/u, "$1");
}

export interface SkillVocabulary {
	/** Skills a typed word points to, or none. */
	skillsFor(word: string): readonly string[];
	/** Whether `name` is a loaded skill (the target of `$name` and `/name`). */
	has(name: string): boolean;
}

/**
 * The closed list of words that point to skills: each part of a skill's name (`octocode-debugging` gives `octocode`
 * and `debug`) and its declared triggers. Descriptions are never read.
 */
export function buildSkillVocabulary(skills: readonly SkillWordSource[]): SkillVocabulary {
	const words = new Map<string, Set<string>>();
	const names = new Set<string>();
	for (const { name, triggers = [] } of skills) {
		names.add(name);
		const parts = name.split(/[-_:]+/u).filter((part) => part.length >= 3 && !GENERIC.has(part.toLowerCase()));
		for (const word of [...parts, ...triggers.filter((trigger) => PLAIN_WORD.test(trigger))]) {
			const key = wordKey(word);
			const owners = words.get(key) ?? new Set<string>();
			owners.add(name);
			words.set(key, owners);
		}
	}
	return {
		skillsFor: (word) => [...(words.get(wordKey(word)) ?? [])],
		has: (name) => names.has(name),
	};
}

/**
 * The skill words of one line: plain words of the vocabulary, and `$name` / `/name` of a loaded skill. Words inside
 * backticks, paths, URLs, file names and identifiers (anything joined to other characters) are skipped.
 */
export function findSkillWords(line: string, vocabulary: SkillVocabulary): SkillWordHit[] {
	const hits: SkillWordHit[] = [];
	let inCode = false;
	for (const chunk of line.matchAll(/\S+/gu)) {
		const raw = chunk[0];
		const ticks = raw.split("`").length - 1;
		const wasInCode = inCode;
		if (ticks % 2 === 1) inCode = !inCode;
		if (wasInCode || ticks > 0) continue;
		const core = raw.replace(PUNCTUATION, "");
		if (!core) continue;
		const start = chunk.index + raw.indexOf(core);
		const explicit = EXPLICIT.exec(core);
		if (explicit) {
			if (vocabulary.has(explicit[1])) hits.push({ start, end: start + core.length, skills: [explicit[1]] });
			continue;
		}
		if (!PLAIN_WORD.test(core)) continue;
		const skills = vocabulary.skillsFor(core);
		if (skills.length > 0) hits.push({ start, end: start + core.length, skills });
	}
	return hits;
}

/** The skills behind the session's commands: `skill:name` and `skill:name:2` (a duplicate) are `name`. */
export function skillWordSources(
	commands: readonly { name: string; source: string; triggers?: readonly string[] }[],
): SkillWordSource[] {
	return commands
		.filter((command) => command.source === "skill")
		.map((command) => ({
			name: command.name.replace(/^skill:/u, "").replace(/:\d+$/u, ""),
			...(command.triggers ? { triggers: command.triggers } : {}),
		}));
}

/** The editor's word highlight plus the hint for the word at a cursor position. */
export interface SkillWordHighlight extends EditorWordHighlight {
	/** `word → skill, skill` while `column` is on or right after a highlighted word of `line`; undefined elsewhere. */
	hintAt(line: string, column: number): string | undefined;
}

/**
 * Reads the loaded skills on every call and rebuilds its vocabulary only when their names or triggers change, so a
 * skill reload shows on the next keystroke.
 */
export function skillWordHighlight(
	skills: () => readonly SkillWordSource[],
	paint: (text: string) => string,
): SkillWordHighlight {
	let signature = "";
	let vocabulary = buildSkillVocabulary([]);
	const current = () => {
		const list = skills();
		const next = list.map((skill) => `${skill.name}\u0000${(skill.triggers ?? []).join("\u0001")}`).join("\u0002");
		if (next !== signature) {
			signature = next;
			vocabulary = buildSkillVocabulary(list);
		}
		return vocabulary;
	};
	return {
		find: (line) => findSkillWords(line, current()),
		style: paint,
		hintAt(line, column) {
			const hit = findSkillWords(line, current()).find((word) => column >= word.start && column <= word.end);
			return hit ? `${line.slice(hit.start, hit.end)} → ${hit.skills.join(", ")}` : undefined;
		},
	};
}

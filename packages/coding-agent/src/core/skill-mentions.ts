import { isAbsolute, normalize } from "node:path";
import type { ExplicitSkill } from "./skills.ts";

const ENVIRONMENT_NAMES = new Set([
	"PATH",
	"HOME",
	"USER",
	"SHELL",
	"PWD",
	"TMPDIR",
	"TEMP",
	"TMP",
	"LANG",
	"TERM",
	"XDG_CONFIG_HOME",
]);
const RUST_SPACE = "[\\u0009-\\u000d \\u0085\\u00a0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000]";
const trimPath = (value: string) => value.replace(new RegExp(`^${RUST_SPACE}+|${RUST_SPACE}+$`, "g"), "");
const foreignResource = (value: string) => /^(?:app|mcp|plugin):\/\//.test(value);

export function extractSkillMentions(text: string): {
	plainNames: string[];
	paths: string[];
} {
	const plainNames = new Set<string>();
	const paths = new Set<string>();
	for (let index = 0; index < text.length;) {
		if (text[index] === "[") {
			const link = /^\[\$([a-zA-Z0-9_:-]+)\][\t\n\f\r ]*\(([^)]*)\)/.exec(text.slice(index));
			if (link) {
				const path = trimPath(link[2]);
				if (path) {
					if (!ENVIRONMENT_NAMES.has(link[1].toUpperCase())) paths.add(path);
					index += link[0].length;
					continue;
				}
			}
		}
		if (text[index] === "$") {
			const name = /^[a-zA-Z0-9_:-]+/.exec(text.slice(index + 1))?.[0];
			if (name) {
				if (!ENVIRONMENT_NAMES.has(name.toUpperCase())) plainNames.add(name);
				index += name.length + 1;
				continue;
			}
		}
		index++;
	}
	return { plainNames: [...plainNames].sort(), paths: [...paths].sort() };
}

/**
 * A `/name` or `/skill:name` token that starts after whitespace or an opening bracket or quote, outside a path: no name
 * character, `/` or `.` plus a non-space follows it, so `/tmp/x`, `src/a` and `/notes.md` never match.
 */
const SLASH_MENTION = /(^|[\s([{"'`])\/(?:skill:)?([a-zA-Z0-9_][a-zA-Z0-9_:-]*)(?![a-zA-Z0-9_:/-]|\.\S)/g;

/**
 * Skill names typed as `/name` or `/skill:name` after the first token. A `/` at the very start of the input is the
 * command (`expandSkillCommand` and the command table own it); a later `/name` names a skill, so one request can name
 * several.
 */
export function extractSlashSkillNames(text: string): string[] {
	const names = new Set<string>();
	for (const match of text.matchAll(SLASH_MENTION)) {
		if (match.index === 0 && match[1] === "") continue;
		names.add(match[2]);
	}
	return [...names].sort();
}

/**
 * Select only discovered local host identities; mention text never authorizes a new file read. Names come from `$name`
 * mentions and from `/name` tokens after the first one (`extractSlashSkillNames`).
 */
export function selectExplicitSkills(
	text: string,
	inventory: readonly ExplicitSkill[],
	connectorSlugCounts: ReadonlyMap<string, number> = new Map(),
): ExplicitSkill[] {
	const mentions = extractSkillMentions(text);
	const plainNames = new Set([...mentions.plainNames, ...extractSlashSkillNames(text)]);
	const paths = new Set<string>();
	for (const raw of mentions.paths) {
		if (foreignResource(raw)) continue;
		const path = raw.startsWith("skill://") ? raw.slice(8) : raw;
		if (isAbsolute(path)) paths.add(normalize(path));
	}
	const candidates: ExplicitSkill[] = [];
	const identities = new Set<string>();
	for (const candidate of inventory) {
		if (candidate.skill.userInvocable === false || candidate.skill.argumentStyle === "claude") continue;
		if (identities.has(candidate.canonicalPath)) continue;
		identities.add(candidate.canonicalPath);
		candidates.push(candidate);
	}
	const counts = new Map<string, number>();
	for (const candidate of candidates) counts.set(candidate.name, (counts.get(candidate.name) ?? 0) + 1);
	const selected: ExplicitSkill[] = [];
	const seenPaths = new Set<string>();
	const seenNames = new Set<string>();
	for (const candidate of candidates) {
		if (paths.has(candidate.canonicalPath) || paths.has(candidate.discoveryPath)) {
			selected.push(candidate);
			seenPaths.add(candidate.canonicalPath);
			seenNames.add(candidate.name);
		}
	}
	for (const candidate of candidates) {
		if (
			seenPaths.has(candidate.canonicalPath) ||
			seenNames.has(candidate.name) ||
			!plainNames.has(candidate.name) ||
			(counts.get(candidate.name) ?? 0) !== 1 ||
			(connectorSlugCounts.get(candidate.name.toLowerCase()) ?? 0) !== 0
		)
			continue;
		selected.push(candidate);
		seenPaths.add(candidate.canonicalPath);
		seenNames.add(candidate.name);
	}
	return selected;
}

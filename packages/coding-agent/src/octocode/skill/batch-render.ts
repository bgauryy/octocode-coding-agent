import path from "node:path";
import type { Component } from "@octocodeai/octocode-tui";
import type { ToolDisplay } from "@octocodeai/octocode-contracts";
import { parseSkillBlock } from "../../core/agent-session/prompt-expansion.ts";
import { shortPath } from "../../utils/display-path.ts";
import { plural } from "../shared/text.ts";
import type { Theme } from "../../theme/theme.ts";
import { resultBlock } from "../render/tool.ts";
import type { RenderContext } from "../render/types.ts";
import { type SkillBatchDetails, skillReference } from "./batch.ts";
import { skillHeader, skillInstructions, skillLoadSummary } from "./render.ts";

/** What a batch call asked for, as its header shows it: each skill's name, a listed path shown as its folder's name. */
function requestedNames(args: { name?: unknown; names?: unknown } | undefined): string[] {
	const all = [
		...(Array.isArray(args?.names) ? args.names : []),
		...(typeof args?.name === "string" ? [args.name] : []),
	].filter((value): value is string => typeof value === "string");
	return all
		.map(skillReference)
		.filter(Boolean)
		.map((reference) => (reference.includes("/") ? path.basename(path.dirname(reference)) : reference));
}

/** The row header: `Skill(alpha, beta)`. */
export function batchHeader(
	theme: Theme,
	context: RenderContext,
	args: { name?: unknown; names?: unknown } | undefined,
): Component {
	return skillHeader(theme, context, requestedNames(args).join(", "));
}

/** A result of an older session or another surface: one skill's own details, not a batch's. */
function batchOf(details: unknown): SkillBatchDetails {
	const value = details as Partial<SkillBatchDetails> | undefined;
	return { skills: value?.skills ?? [], refused: value?.refused ?? [], loadedSkills: value?.loadedSkills ?? [] };
}

/** `2 skills · 120 lines · 1 not loaded`; one skill alone reads as its own load (`Octocode skill · 120 lines`). */
function batchSummary(details: unknown): string {
	const { skills, refused } = batchOf(details);
	if (skills.length === 1 && refused.length === 0) return skillLoadSummary(skills[0]);
	const lines = skills.reduce((sum, skill) => sum + skill.lines, 0);
	return [
		plural(skills.length, "skill"),
		skills.length > 0 ? plural(lines, "line") : undefined,
		refused.length > 0 ? `${refused.length} not loaded` : undefined,
	]
		.filter(Boolean)
		.join(" · ");
}

/** The expanded body: per skill its name, description, file and line count; per refusal what was asked and why not. */
function batchLines(details: SkillBatchDetails): string[] {
	return [
		...details.skills.flatMap((skill) => [
			skill.name,
			...(skill.description ? [`  ${skill.description}`] : []),
			`  ${shortPath(skill.location)} · ${plural(skill.lines, "line")}`,
		]),
		...details.refused.map((entry) => `Not loaded: ${entry.message}`),
	];
}

/** The instructions of the one skill a call loaded, as the row has always shown them. */
function singleBody(text: string, details: SkillBatchDetails): string {
	const skill = details.skills[0];
	const instructions = skillInstructions(parseSkillBlock(text)?.content ?? text);
	const preface = [skill.description, shortPath(skill.location)]
		.filter(Boolean)
		.map((line) => `${line}\n\n`)
		.join("");
	return `${preface}${instructions}`;
}

/** The result row: a one-line summary, and the loaded skills and failures once expanded. */
export function batchResult(
	text: string,
	details: unknown,
	theme: Theme,
	context: RenderContext,
	extra: Record<string, unknown>,
): Component {
	const batch = batchOf(details);
	const single = batch.skills.length === 1 && batch.refused.length === 0;
	return resultBlock(theme, context, {
		summary: batchSummary(batch),
		summaryColor: "customMessageText",
		...(single ? { body: singleBody(text, batch) } : { lines: batchLines(batch) }),
		max: 0,
		...extra,
	});
}

/** The web and ACP view of a call: the skills in the title, a path block per loaded skill, a text block per failure. */
export function batchDisplay(
	args: { name?: unknown; names?: unknown } | undefined,
	details: unknown,
	text: string,
): Pick<ToolDisplay, "title" | "outcome" | "blocks"> {
	const batch = batchOf(details);
	const names = requestedNames(args);
	const single = batch.skills.length === 1 && batch.refused.length === 0;
	const instructions = skillInstructions(parseSkillBlock(text)?.content ?? text);
	return {
		title: names.length > 0 ? `Skill: ${names.join(", ")}` : "Skill",
		outcome: { text: batchSummary(batch), tone: "muted" },
		blocks: [
			...batch.skills.flatMap((skill) => [
				...(skill.description
					? [{ type: "text" as const, text: `${skill.name}: ${skill.description}`, tone: "muted" as const }]
					: []),
				{
					type: "path" as const,
					text: `file: ${skill.location} · ${plural(skill.lines, "line")}`,
					label: "file",
					path: skill.location,
				},
			]),
			...batch.refused.map((entry) => ({ type: "text" as const, text: entry.message, tone: "error" as const })),
			...(single ? [{ type: "markdown" as const, text: instructions }] : []),
		],
	};
}

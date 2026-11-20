import { CHARS_PER_TOKEN } from "@octocodeai/octocode-ai/utils/estimate";
import { homeTilde } from "@octocodeai/octocode-common/home-tilde";
import { isRecord } from "@octocodeai/octocode-contracts/guards";
import type { FeatureContext, SetupPick } from "../../core/features/index.ts";
import { renderPrompt } from "../../core/prompt-template.ts";
import { contextMessages } from "../files/reads.ts";
import { contentText, isStaleSessionError } from "../shared/util.ts";
import { carriedLoadedSkills, SKILL_BLOCK, skillBlocksIn, skillsOf } from "./loaded-skills.ts";

/**
 * Skill instructions after a compaction. A loaded skill's body is an ordinary tool result (or a `/skill:` block in a user
 * message), so a summary drops it and keeps only a pointer (`loaded-skills.ts`); the agent then works on without the
 * workflow it loaded, and seldom loads it again. After each compaction the bodies of the `RESTORE_SKILLS` skills loaded
 * most recently, among those the summary still carries, come back as one hidden message, like the files worked on
 * (`restore.ts`) and the deferred tool schemas (`deferred-schemas.ts`): as the agent loaded them, each within
 * `RESTORE_SKILL_TOKENS` (a longer one is cut at a line, with a note naming its file) and all within
 * `RESTORE_SKILLS_TOKENS` and a share of the window. A skill the kept messages or the system prompt already show is not
 * sent again. The message is written once, so the prompt stays byte-stable.
 */

export const RESTORED_SKILLS_TYPE = "octocode-restored-skills";

/** At most this many skill bodies come back... */
export const RESTORE_SKILLS = 2;
/** ...each within this many tokens (by `CHARS_PER_TOKEN`)... */
export const RESTORE_SKILL_TOKENS = 5_000;
/** ...all within this many... */
export const RESTORE_SKILLS_TOKENS = 10_000;
/** ...and within this share of the model's context window. */
const RESTORE_SKILLS_SHARE = 0.05;
/** A body cut below this many characters helps no one: the skill is left to its pointer. */
const MIN_BODY_CHARS = 1_500;

/** The `<skill>` blocks in the text of `message` (a tool result or a user message), by skill name, the last of each. */
function blocksOf(message: unknown): Map<string, { location: string; block: string }> {
	const blocks = new Map<string, { location: string; block: string }>();
	if (!isRecord(message) || (message.role !== "toolResult" && message.role !== "user")) return blocks;
	for (const match of contentText(message.content).matchAll(SKILL_BLOCK))
		blocks.set(match[1], { location: match[2], block: match[0] });
	return blocks;
}

/** The skills whose bodies `messages` (the context kept after a compaction) already show, a restored message included. */
function shownSkills(messages: readonly unknown[]): Set<string> {
	const names = new Set<string>();
	for (const message of messages) {
		for (const name of blocksOf(message).keys()) names.add(name);
		if (!isRecord(message) || message.role !== "custom" || message.customType !== RESTORED_SKILLS_TYPE) continue;
		const skills = isRecord(message.details) ? message.details.skills : undefined;
		if (Array.isArray(skills)) for (const name of skills) if (typeof name === "string") names.add(name);
	}
	return names;
}

/**
 * `block` within `max` characters: whole, or its opening line and the whole lines that fit, a note saying where it was
 * cut and where the rest is, and its closing tag. Undefined when too little of the body fits.
 */
function fittedBlock(block: string, location: string, max: number): { text: string; cut: boolean } | undefined {
	if (block.length <= max) return { text: block, cut: false };
	const lines = block.split("\n");
	const close = lines.pop() ?? "";
	const open = lines.shift() ?? "";
	const note = (line: number) =>
		renderPrompt("notices/compaction/restored-skill-cut.md", {
			line,
			lines: lines.length,
			location: homeTilde(location),
		});
	let used = open.length + close.length + note(lines.length).length + 3;
	let kept = 0;
	while (kept < lines.length && used + lines[kept].length + 1 <= max) used += lines[kept++].length + 1;
	if (used - open.length - close.length < MIN_BODY_CHARS) return undefined;
	return { text: [open, ...lines.slice(0, kept), note(kept), close].join("\n"), cut: true };
}

/**
 * The restore message for `messages` (the branch, oldest first): the bodies of the skills in `carried` (what the latest
 * summary records) not in `shown`, most recently loaded first, as their latest load showed them, within the budgets.
 * Undefined when none comes back.
 */
function restoredSkills(
	messages: readonly unknown[],
	carried: ReadonlySet<string>,
	shown: ReadonlySet<string>,
	budget: number,
): { content: string; skills: string[]; cut: string[] } | undefined {
	const intro = renderPrompt("notices/compaction/restored-skills.md").trim();
	const picked: string[] = [];
	const skills: string[] = [];
	const cut: string[] = [];
	let left = budget - intro.length;
	const seen = new Set<string>();
	for (let at = messages.length - 1; at >= 0 && skills.length < RESTORE_SKILLS; at--) {
		const loaded = skillsOf(messages[at]);
		if (loaded.length === 0) continue;
		const blocks = blocksOf(messages[at]);
		for (const { name, location } of loaded) {
			if (seen.has(name)) continue;
			seen.add(name);
			const block = blocks.get(name)?.block;
			if (!carried.has(name) || shown.has(name) || block === undefined || skills.length >= RESTORE_SKILLS) continue;
			const fitted = fittedBlock(block, location, Math.min(RESTORE_SKILL_TOKENS * CHARS_PER_TOKEN, left - 2));
			if (!fitted) continue;
			left -= fitted.text.length + 2;
			picked.push(fitted.text);
			skills.push(name);
			if (fitted.cut) cut.push(name);
		}
	}
	return skills.length > 0 ? { content: [intro, ...picked].join("\n\n"), skills, cut } : undefined;
}

type RestoreContext = Pick<FeatureContext, "sessionManager"> &
	Partial<Pick<FeatureContext, "model" | "getSystemPrompt">>;

/** Sends the bodies of the skills loaded most recently back into the context after a compaction; returns the skills restored. */
export async function restoreLoadedSkills(
	api: SetupPick<"session", "sendMessage">,
	ctx: RestoreContext,
): Promise<string[]> {
	try {
		const branch = ctx.sessionManager.getBranch();
		const carried = new Set(carriedLoadedSkills(branch).map((skill) => skill.name));
		if (carried.size === 0) return [];
		const shown = shownSkills(contextMessages(ctx).map((entry) => entry.message));
		const system = ctx.getSystemPrompt?.() ?? "";
		const inSystem = skillBlocksIn(system);
		for (const name of carried) if (inSystem.has(name)) shown.add(name);
		const window = ctx.model?.contextWindow;
		const total = RESTORE_SKILLS_TOKENS * CHARS_PER_TOKEN;
		const budget =
			typeof window === "number" && Number.isFinite(window) && window > 0
				? Math.min(total, Math.floor(window * CHARS_PER_TOKEN * RESTORE_SKILLS_SHARE))
				: total;
		const messages = branch.flatMap((entry) => (entry.type === "message" ? [entry.message] : []));
		const restored = restoredSkills(messages, carried, shown, budget);
		if (!restored) return [];
		const details = { skills: restored.skills, ...(restored.cut.length > 0 ? { cut: restored.cut } : {}) };
		await api.session.sendMessage(
			{ customType: RESTORED_SKILLS_TYPE, content: restored.content, display: false, details },
			{ triggerTurn: false },
		);
		return restored.skills;
	} catch (error) {
		// Octocode's ctx and api throw this once the session was replaced; any other failure is a real error and goes on.
		if (isStaleSessionError(error)) return [];
		throw error;
	}
}

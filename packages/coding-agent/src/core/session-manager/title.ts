import { sanitizeTerminalText } from "@octocodeai/octocode-common/sanitize";
import { withoutSourceHeader } from "@octocodeai/octocode-common/text";
import { parseSkillBlock } from "../skill-block.ts";
import type { SessionInfo } from "./types.ts";

let graphemesCache: Intl.Segmenter | undefined;
/** Made on first use: a segmenter loads ICU data (about 10 ms), which a process that never needs it should not pay at load. */
const graphemes = (): Intl.Segmenter => (graphemesCache ??= new Intl.Segmenter(undefined, { granularity: "grapheme" }));

/** Most characters a session title shows. */
export const SESSION_TITLE_MAX = 60;

/**
 * One line of text fit for a session title: a leading skill block becomes `skill-name: request` (its body is the
 * skill's instructions, not the user's words), control characters go, whitespace collapses, and the result is capped
 * at `max` characters with an ellipsis.
 */
export function cleanTitle(text: string, max = SESSION_TITLE_MAX): string {
	const skill = parseSkillBlock(text);
	const raw = skill ? (skill.userMessage ? `${skill.name}: ${skill.userMessage}` : skill.name) : text;
	const flat = sanitizeTerminalText(raw).replace(/\s+/g, " ").trim();
	// Graphemes, so an emoji or a combined character is never cut in half.
	const line = Array.from(graphemes().segment(flat), (part) => part.segment);
	return line.length > max ? `${line.slice(0, max - 1).join("")}…` : flat;
}

/** What a session is called: its name (given by the user, generated, or a subagent's goal), else its first prompt. */
export function sessionTitle(session: Pick<SessionInfo, "name" | "firstMessage">, max = SESSION_TITLE_MAX): string {
	return cleanTitle(session.name?.trim() || withoutSourceHeader(session.firstMessage), max);
}

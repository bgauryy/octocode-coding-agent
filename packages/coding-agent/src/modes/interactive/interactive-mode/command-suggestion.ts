/**
 * The warning for a command-shaped `/name` that no command owns, naming the command the user most likely meant.
 */

import { retiredCommandNotice } from "../../../octocode/shared/commands.ts";
import { editDistance } from "../../../octocode/skill/catalog.ts";

/** What the suggestion reads of a command: the fields the /help picker searches. */
interface CommandEntry {
	name: string;
	description?: string;
}

/** A description's words, lower case. */
function words(text: string): string[] {
	return text
		.toLowerCase()
		.split(/[^a-z0-9]+/)
		.filter(Boolean);
}

/** One command when exactly one matches, so a hint never picks arbitrarily between equals. */
function only(matches: readonly CommandEntry[]): string | undefined {
	return matches.length === 1 ? matches[0].name : undefined;
}

/**
 * The command a mistyped or unknown name most likely means, read as the /help picker reads a command: its name first,
 * then the words of its description, and edit distance only when neither matches. Short words tolerate one edit, so
 * a three-letter word never points at an unrelated three-letter command.
 */
function closestCommand(name: string, commands: readonly CommandEntry[]): string | undefined {
	const wanted = name.toLowerCase();
	const byName = commands
		.map((command) => ({ command, lower: command.name.toLowerCase() }))
		.filter(
			({ lower }) =>
				lower.startsWith(wanted) || wanted.startsWith(lower) || (wanted.length >= 3 && lower.includes(wanted)),
		)
		.sort(
			(a, b) =>
				Math.abs(a.lower.length - wanted.length) - Math.abs(b.lower.length - wanted.length) ||
				a.lower.localeCompare(b.lower),
		);
	if (byName.length > 0) return byName[0].command.name;

	const forms = new Set([wanted, `${wanted}s`, wanted.replace(/s$/, "")]);
	const byDescription = commands.filter((command) => words(command.description ?? "").some((word) => forms.has(word)));
	if (byDescription.length > 0) return only(byDescription);

	const limit = wanted.length <= 4 ? 1 : Math.max(2, Math.floor(wanted.length / 3));
	const [nearest] = commands
		.map((command) => ({ command, edits: editDistance(wanted, command.name.toLowerCase()) }))
		.filter(({ edits }) => edits <= limit)
		.sort((a, b) => a.edits - b.edits || a.command.name.localeCompare(b.command.name));
	return nearest?.command.name;
}

/** The message for retired input (`/plugins`, `/settings`): where the command moved. A refusal that cannot be sent as text. */
export function retiredInputNotice(text: string, name: string, commands: readonly CommandEntry[]): string | undefined {
	const names = commands.map((command) => command.name);
	return names.includes(name) ? undefined : retiredCommandNotice(text, names);
}

/**
 * The warning for `text`, whose command `name` no command owns: the closest command, or /help when none is close.
 * Undefined when `name` is not command-shaped or exists.
 */
export function unknownCommandWarning(
	text: string,
	name: string,
	commands: readonly CommandEntry[],
): string | undefined {
	if (!/^[a-z][a-z0-9-]*$/i.test(name)) return undefined;
	const names = commands.map((command) => command.name);
	if (names.includes(name)) return undefined;
	const suggestion = closestCommand(name, commands);
	return suggestion
		? `Unknown command /${name}. Did you mean /${suggestion}?`
		: `Unknown command /${name}. Search commands with /help ${name}.`;
}

/**
 * What the `/` menu and the /help picker list, in which order, and the usage /help shows for one command.
 */

import { Markdown, type SlashCommand, Spacer } from "@octocodeai/octocode-tui";
import { BUILTIN_SLASH_COMMANDS, COMMAND_ALIASES, SLASH_MENU_ORDER } from "../../../core/slash-commands.ts";
import { DynamicBorder } from "../../../theme/dynamic-border.ts";
import type { InteractiveModeHost } from "./host.ts";

const HIDDEN = new Set(BUILTIN_SLASH_COMMANDS.filter((command) => command.menuHidden).map((command) => command.name));
/** Argument values /help lists for one command; more are reachable through completion. */
const USAGE_VALUES = 20;

/** `command` carrying the Claude Code names that run it: they match in the menu and its row says "also /name". */
function withAliases(command: SlashCommand): SlashCommand {
	const aliases = [...COMMAND_ALIASES].filter(([, target]) => target === command.name).map(([alias]) => alias);
	if (aliases.length === 0) return command;
	const also = `also ${aliases.map((alias) => `/${alias}`).join(" ")}`;
	return { ...command, aliases, description: command.description ? `${command.description} · ${also}` : also };
}

/** `commands` as the menu lists them: aliases are no rows but match their target, in `SLASH_MENU_ORDER`, others after them, skills last. */
export function menuCommands(commands: readonly SlashCommand[]): SlashCommand[] {
	const rank = (command: SlashCommand): number => {
		if (command.skill) return SLASH_MENU_ORDER.length + 1;
		const at = SLASH_MENU_ORDER.indexOf(command.name);
		return at >= 0 ? at : SLASH_MENU_ORDER.length;
	};
	// Array.prototype.sort is stable, so equal ranks keep registration order.
	return commands
		.filter((command) => !HIDDEN.has(command.name))
		.map((command) => (command.skill ? command : withAliases(command)))
		.sort((a, b) => rank(a) - rank(b));
}

/** The command `query` names exactly (with or without its slash), if any. */
export function findCommand(commands: readonly SlashCommand[], query: string): SlashCommand | undefined {
	const name = query.trim().replace(/^\//, "");
	return name ? commands.find((command) => command.name === name) : undefined;
}

const code = (text: string): string => `\`${text.replaceAll("`", "'")}\``;

/** Writes `command`'s description, usage and argument values to the chat. */
export async function showCommandUsage(
	host: Pick<InteractiveModeHost, "chatContainer" | "getMarkdownThemeWithSettings" | "ui">,
	command: SlashCommand,
): Promise<void> {
	const lines = [`**/${command.name}**${command.description ? ` · ${command.description}` : ""}`, ""];
	lines.push(`Usage: ${code(`/${command.name}${command.argumentHint ? ` ${command.argumentHint}` : ""}`)}`);
	const values = (await command.getArgumentCompletions?.("")) ?? [];
	if (values.length > 0) {
		lines.push("");
		for (const item of values.slice(0, USAGE_VALUES))
			lines.push(`- ${code(item.value)}${item.description ? ` · ${item.description}` : ""}`);
		if (values.length > USAGE_VALUES)
			lines.push(`- ${values.length - USAGE_VALUES} more: type ${code(`/${command.name} `)}`);
	}
	host.chatContainer.addChild(new Spacer(1));
	host.chatContainer.addChild(new DynamicBorder());
	host.chatContainer.addChild(new Markdown(lines.join("\n"), 1, 1, host.getMarkdownThemeWithSettings()));
	host.chatContainer.addChild(new DynamicBorder());
	host.ui.requestRender();
}

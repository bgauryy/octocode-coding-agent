import { Type } from "typebox";
import { SETTINGS_DEFAULTS } from "../settings-defaults.ts";

const COMPLETION = SETTINGS_DEFAULTS.terminal.completion;
const SUGGESTIONS = SETTINGS_DEFAULTS.terminal.suggestions;

/** `terminal.completion`: Tab completion of `!` shell commands. */
export const TerminalCompletionSettingsSchema = Type.Object(
	{
		shell: Type.Optional(
			Type.Union(
				[
					Type.Literal("auto"),
					Type.Literal("zsh"),
					Type.Literal("bash"),
					Type.Literal("fish"),
					Type.Literal("pwsh"),
					Type.Literal("none"),
				],
				{
					description:
						'The shell whose completions Tab offers after `!`: "auto" follows your login shell ($SHELL; PowerShell on Windows without it). "none" starts no shell: Tab then completes program names, git branches and paths only. The shell runs only in a trusted folder.',
					default: COMPLETION.shell,
				},
			),
		),
		loadRc: Type.Optional(
			Type.Boolean({
				description:
					"Start the completion shell with your own startup files (.zshrc, .bashrc, config.fish, the PowerShell profile), so plugin and custom completions work. Off loads only the shell's built-in completion system, which starts faster.",
				default: COMPLETION.loadRc,
			}),
		),
		carapace: Type.Optional(
			Type.Boolean({
				description:
					"When the shell has no completion for a command and `carapace` is on PATH, ask carapace. Trusted folders only.",
				default: COMPLETION.carapace,
			}),
		),
	},
	{ additionalProperties: false, description: "Tab completion of `!` shell commands." },
);

/** `terminal.suggestions`: ghost text while typing a `!` command. */
export const TerminalSuggestionSettingsSchema = Type.Object(
	{
		history: Type.Optional(
			Type.Boolean({
				description:
					"Show ghost text while typing a `!` command: a command from the agent's last reply or your earlier `!` commands that starts with what you typed. Right or End accepts it.",
				default: SUGGESTIONS.history,
			}),
		),
		model: Type.Optional(
			Type.Boolean({
				description:
					"When neither the last reply nor your history has a match, ask the cheapest connected model (the small tier, resolved from the providers you are signed in to) for the rest of the command. Costs a small call per pause in typing, recorded in the session's usage; no call is made when no cheaper model is available. Read from the global settings only: a project file cannot turn it on.",
				default: SUGGESTIONS.model,
			}),
		),
	},
	{ additionalProperties: false, description: "Ghost text while typing a `!` command." },
);

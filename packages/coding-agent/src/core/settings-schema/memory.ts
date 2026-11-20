import { Type } from "typebox";
import { SETTINGS_DEFAULTS } from "../settings-defaults.ts";

const defaults = SETTINGS_DEFAULTS.memory;

/** The `memory` settings of the root schema: the MEMORY.md files and per-prompt recall. */
export const MemorySettingsProperties = {
	memory: Type.Optional(
		Type.Object(
			{
				file: Type.Optional(
					Type.Boolean({
						description:
							"Load the global MEMORY.md (in the Octocode home) and the repository's .octocode/octocodecode/MEMORY.md into the system prompt at session start. Off: neither is read or written.",
						default: defaults.file,
					}),
				),
				autoUpdate: Type.Optional(
					Type.Union([Type.Literal("off"), Type.Literal("explicit"), Type.Literal("auto")], {
						description:
							'Who writes the MEMORY.md files: "off" nobody (the files are only read), "explicit" saves you or the agent make with memory set or /memory add, "auto" those plus the background passes that harvest and consolidate lessons.',
						default: defaults.autoUpdate,
					}),
				),
				subagents: Type.Optional(
					Type.Union([Type.Literal("workspace"), Type.Literal("all"), Type.Literal("none")], {
						description:
							'Which MEMORY.md files a subagent gets: "workspace" the repository\'s, "all" the global one too, "none" neither. A lean subagent gets none.',
						default: defaults.subagents,
					}),
				),
				recall: Type.Optional(
					Type.Union([Type.Literal("off"), Type.Literal("main"), Type.Literal("all")], {
						description:
							'Before each prompt, add pinned and word-matched notes from the notes database: "off" never, "main" in the main session only, "all" in subagents too. OCTOCODE_MEMORY_AUTO=0 turns it off for the process.',
						default: defaults.recall,
					}),
				),
				reflection: Type.Optional(
					Type.Boolean({
						description:
							'Let a long main session end with one call to the cheaper model (subagents.models.small) that proposes lessons for MEMORY.md. Needs autoUpdate "auto".',
						default: defaults.reflection,
					}),
				),
				subagentPinnedKind: Type.Optional(
					Type.Union(
						[
							Type.Literal("preference"),
							Type.Literal("fact"),
							Type.Literal("decision"),
							Type.Literal("gotcha"),
							Type.Literal("procedure"),
							Type.Literal("reference"),
						],
						{
							description:
								'The one kind of pinned note a subagent\'s recall includes (with recall "all"); pinned notes of other kinds stay out of its prompt. The main session always gets every pinned kind.',
							default: defaults.subagentPinnedKind,
						},
					),
				),
			},
			{ additionalProperties: false },
		),
	),
};

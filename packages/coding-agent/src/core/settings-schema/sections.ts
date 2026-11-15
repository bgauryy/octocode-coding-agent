/** Nested settings schemas composed into `SettingsSchema`. */

import { type TSchemaOptions, Type } from "typebox";
import { SETTINGS_DEFAULTS } from "../settings-defaults.ts";
import { TerminalCompletionSettingsSchema, TerminalSuggestionSettingsSchema } from "./terminal-completion.ts";

export function timeoutSetting(options?: TSchemaOptions) {
	return Type.Union([Type.Number({ minimum: 0 }), Type.Literal("disabled")], options);
}

export const BranchSummarySettingsSchema = Type.Object({
	reserveTokens: Type.Optional(
		Type.Number({
			description: "Tokens reserved for the prompt and LLM response.",
			default: SETTINGS_DEFAULTS.branchSummary.reserveTokens,
		}),
	),
	skipPrompt: Type.Optional(
		Type.Boolean({
			description: 'When true, skips the "Summarize branch?" prompt and defaults to no summary.',
			default: SETTINGS_DEFAULTS.branchSummary.skipPrompt,
		}),
	),
});

const ProviderRetrySettingsSchema = Type.Object({
	timeoutMs: Type.Optional(Type.Number({ description: "SDK or provider request timeout in milliseconds." })),
	maxRetries: Type.Optional(Type.Number({ description: "SDK or provider retry attempts." })),
	maxRetryDelayMs: Type.Optional(
		Type.Number({
			description: "Maximum server-requested delay before failing.",
			default: SETTINGS_DEFAULTS.retry.provider.maxRetryDelayMs,
		}),
	),
});

export const RetrySettingsSchema = Type.Object({
	enabled: Type.Optional(Type.Boolean({ default: SETTINGS_DEFAULTS.retry.enabled })),
	maxRetries: Type.Optional(Type.Number({ default: SETTINGS_DEFAULTS.retry.maxRetries })),
	baseDelayMs: Type.Optional(
		Type.Number({
			description: "Exponential backoff base delay in milliseconds: 2s, 4s, 8s.",
			default: SETTINGS_DEFAULTS.retry.baseDelayMs,
		}),
	),
	maxAgentDelayMs: Type.Optional(Type.Number({ default: SETTINGS_DEFAULTS.retry.maxAgentDelayMs })),
	provider: Type.Optional(ProviderRetrySettingsSchema),
	fallbackModels: Type.Optional(
		Type.Array(Type.String(), {
			description:
				'Models to continue on when the current one fails on a usage limit (quota, billing or plan limit), a refused credential (401, 403, an expired sign-in) or an outage that outlasts the retries, tried in order, each as `provider/id` with an optional `:thinking` level, for example `["openrouter/some-model", "openai/other-model:high"]`. After a refused credential, entries of the same provider are skipped. The first one with credentials becomes the session model with a notice, which names a change between plan and per-token billing, and stays selected; `/model` switches back. Empty: such a failure ends the turn.',
			default: SETTINGS_DEFAULTS.retry.fallbackModels,
		}),
	),
});

export const ToolExecutionSettingsSchema = Type.Object(
	{
		earlyStart: Type.Optional(
			Type.Boolean({
				description:
					"Start read-only tool calls that need no approval while the model is still writing its message, instead of after it ends.",
				default: SETTINGS_DEFAULTS.toolExecution.earlyStart,
			}),
		),
	},
	{ description: "When tool calls start." },
);

export const TerminalSettingsSchema = Type.Object({
	showImages: Type.Optional(
		Type.Boolean({
			description: "Show images when the terminal supports them.",
			default: SETTINGS_DEFAULTS.terminal.showImages,
		}),
	),
	imageWidthCells: Type.Optional(
		Type.Number({
			description: "Preferred inline image width in terminal cells.",
			default: SETTINGS_DEFAULTS.terminal.imageWidthCells,
		}),
	),
	clearOnShrink: Type.Optional(
		Type.Boolean({
			description: "Clear empty rows when content shrinks.",
			default: SETTINGS_DEFAULTS.terminal.clearOnShrink,
		}),
	),
	replayRows: Type.Optional(
		Type.Integer({
			minimum: 0,
			description:
				"Regular mode: the most rows a full redraw writes back into the terminal (after a resize or a resume from the background); earlier rows are left out behind one marker row. 0 redraws every row.",
			default: SETTINGS_DEFAULTS.terminal.replayRows,
		}),
	),
	showTerminalProgress: Type.Optional(
		Type.Boolean({
			description: "Show OSC 9;4 terminal progress indicators.",
			default: SETTINGS_DEFAULTS.terminal.showTerminalProgress,
		}),
	),
	reduceMotion: Type.Optional(
		Type.Union([Type.Boolean(), Type.Literal("auto")], {
			description:
				'Freeze spinners, shimmer and glow; elapsed times still tick. "auto" follows OCTOCODE_REDUCE_MOTION (1 or true).',
			default: SETTINGS_DEFAULTS.terminal.reduceMotion,
		}),
	),
	hyperlinks: Type.Optional(Type.Union([Type.Boolean(), Type.Literal("auto")])),
	images: Type.Optional(
		Type.Union([Type.Literal("kitty"), Type.Literal("iterm2"), Type.Literal("auto"), Type.Literal(false)]),
	),
	trueColor: Type.Optional(Type.Union([Type.Boolean(), Type.Literal("auto")])),
	completion: Type.Optional(TerminalCompletionSettingsSchema),
	suggestions: Type.Optional(TerminalSuggestionSettingsSchema),
});

export const ImageSettingsSchema = Type.Object({
	autoResize: Type.Optional(
		Type.Boolean({
			description: "Resize images to 2000x2000 maximum for better model compatibility.",
			default: SETTINGS_DEFAULTS.images.autoResize,
		}),
	),
	blockImages: Type.Optional(
		Type.Boolean({
			description: "When true, prevents all images from being sent to LLM providers.",
			default: SETTINGS_DEFAULTS.images.blockImages,
		}),
	),
});

export function thinkingBudgetsSettings(options?: TSchemaOptions) {
	return Type.Object(
		{
			minimal: Type.Optional(Type.Number()),
			low: Type.Optional(Type.Number()),
			medium: Type.Optional(Type.Number()),
			high: Type.Optional(Type.Number()),
		},
		options,
	);
}

export const ThinkingBudgetsSettingsSchema = thinkingBudgetsSettings();

export const MarkdownSettingsSchema = Type.Object({
	codeBlockIndent: Type.Optional(Type.String({ default: SETTINGS_DEFAULTS.markdown.codeBlockIndent })),
	mermaid: Type.Optional(
		Type.Union([Type.Literal("off"), Type.Literal("final"), Type.Literal("streaming")], {
			default: SETTINGS_DEFAULTS.markdown.mermaid,
		}),
	),
});

export const WarningSettingsSchema = Type.Object({
	anthropicExtraUsage: Type.Optional(Type.Boolean({ default: SETTINGS_DEFAULTS.warnings.anthropicExtraUsage })),
});

export const PackageSourceSchema = Type.Union(
	[
		Type.String({ description: "Load all resources from the package." }),
		Type.Object({
			source: Type.String(),
			autoload: Type.Optional(
				Type.Boolean({ description: "When false, start empty and only apply explicit resource patterns." }),
			),
			extensions: Type.Optional(Type.Array(Type.String())),
			skills: Type.Optional(Type.Array(Type.String())),
			prompts: Type.Optional(Type.Array(Type.String())),
			themes: Type.Optional(Type.Array(Type.String())),
		}),
	],
	{
		description:
			"Package source for npm or git packages. Use the string form to load all resources or the object form to filter resources.",
	},
);

export const SkillsInputSchema = Type.Array(Type.String(), { description: "Local skill file paths or directories." });

/** Install record on a `plugins[]` entry written by `octocode plugin install`. */
export const PluginInstallSourceSchema = Type.Object(
	{
		marketplace: Type.String({ description: "Marketplace name." }),
		plugin: Type.String({ description: "Plugin name in that marketplace." }),
		sha: Type.String({ description: "Pinned commit, or a content hash for a local directory marketplace." }),
	},
	{ description: "Where the cached copy at `path` came from; written by `octocode plugin install`." },
);

/** Where a marketplace is fetched from: a local directory, a GitHub repository or a git URL. No other kinds. */
const MarketplaceSourceSchema = Type.Union([
	Type.Object({ source: Type.Literal("directory"), path: Type.String({ description: "Absolute directory." }) }),
	Type.Object({
		source: Type.Literal("github"),
		repo: Type.String({ description: "owner/repo." }),
		ref: Type.Optional(Type.String({ description: "Branch or tag; default branch when omitted." })),
	}),
	Type.Object({
		source: Type.Literal("git"),
		url: Type.String({ description: "https, ssh, git or file URL, or a local repository path; no credentials." }),
		ref: Type.Optional(Type.String({ description: "Branch or tag; default branch when omitted." })),
	}),
]);

export const MarketplaceRecordSchema = Type.Object({
	source: MarketplaceSourceSchema,
	addedAt: Type.String({ description: "ISO time the marketplace was added." }),
});

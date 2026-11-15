import { Type } from "typebox";
import { SETTINGS_DEFAULTS } from "../settings-defaults.ts";

const BashSettingsSchema = Type.Object(
	{
		inheritProviderKeys: Type.Optional(
			Type.Boolean({
				description:
					"Keep provider API keys (`OPENAI_API_KEY`, `HF_TOKEN`…) in the environment of bash commands. Off by default: a command's output reaches the model, and a build script or an injected command can read its environment. `GH_TOKEN` and other tool tokens are not provider keys and stay either way. A nested `octocode` still signs in through `auth.json`. Read from the global settings file; a project file cannot turn it on. Takes effect for new sessions.",
				default: SETTINGS_DEFAULTS.bash.inheritProviderKeys,
			}),
		),
		spillMaxBytes: Type.Optional(
			Type.Integer({
				minimum: 0,
				description:
					"Most bytes the saved full output of one foreground bash command holds (commands the agent runs and the user's own `!` commands). Past it the file keeps the first half and the end of the output around a marker, and the result's header says how much was dropped, so a command stuck in a loop cannot fill the disk. What reaches the model below the cap does not change. 0 lifts the cap.",
				default: SETTINGS_DEFAULTS.bash.spillMaxBytes,
			}),
		),
		longCommandAfterSeconds: Type.Optional(
			Type.Number({
				minimum: 0,
				description:
					"Seconds a known long command (test runner, `yarn run check`, build, server, stream follower, or a `longCommandPatterns` match) may run in the foreground before it moves to the background as a job. It applies only when sooner than `bashBackgroundAfterSeconds`.",
				default: SETTINGS_DEFAULTS.bash.longCommandAfterSeconds,
			}),
		),
		deliberateMaxSeconds: Type.Optional(
			Type.Number({
				minimum: 1,
				description:
					"The longest a foreground bash call that names its own `timeout` holds the turn before the command moves to the background (it is still stopped at its timeout).",
				default: SETTINGS_DEFAULTS.bash.deliberateMaxSeconds,
			}),
		),
		longCommandPatterns: Type.Optional(
			Type.Array(Type.String(), {
				description:
					'Regular expressions for commands that count as long, added to the built-in runners (vitest, jest, pytest, cargo, go, yarn test/check/build/dev…), for example `["bazel\\s+(?:test|build)", "make\\s+(?:test|check)"]`. Each is matched where a command starts (the line, or after `;`, `&`, `|`, `(` and `VAR=value` words) and must end at a space or the end of a part. An entry that is not a valid regular expression is ignored.',
				default: SETTINGS_DEFAULTS.bash.longCommandPatterns,
			}),
		),
	},
	{ additionalProperties: false },
);

/** The bash settings of the root schema. */
export const BashSettingsProperties = {
	bashBackgroundAfterSeconds: Type.Optional(
		Type.Number({
			description:
				"Seconds a foreground bash command may run before it moves to the background as a job (its exit arrives as a message). 0 turns this off. The OCTOCODE_BASH_BACKGROUND_AFTER_SECONDS environment variable overrides it.",
			minimum: 0,
			default: SETTINGS_DEFAULTS.bashBackgroundAfterSeconds,
		}),
	),
	bashOutputMaxBytes: Type.Optional(
		Type.Number({
			description:
				"Most bytes of one foreground bash result that reach the model (about 4 bytes per token); the line limit scales with it (500 lines at the default). Longer output keeps its first 20% and last 80%, plus matched error lines, and is saved in full. A call can lower it with maxOutputTokens, or raise it up to 50,000 bytes. Output of the user's own `!` commands follows the same limit.",
			minimum: 1024,
			default: SETTINGS_DEFAULTS.bashOutputMaxBytes,
		}),
	),
	bash: Type.Optional(BashSettingsSchema),
};

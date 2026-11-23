// What the `bash` tool declares to the model: description, parameters and output schema.
import { StringEnum } from "@octocodeai/octocode-contracts/schema";
import { Type, type TSchema } from "typebox";
import { SETTINGS_DEFAULTS } from "../../../core/settings-defaults.ts";
import { maxOutputTokensParameter } from "../../../core/tools/bash.ts";
import { reasonSchema } from "../../shared/reason.ts";
import { probeCliHost, renderCliGuide } from "./cli-guide.ts";
import { MAX_FOREGROUND_TIMEOUT } from "./results.ts";
import { verificationSchema } from "./verification.ts";

/** `structuredContent` of a background start; a foreground command returns Octocode's own bash output. */
const BACKGROUND_OUTPUT = Type.Object({
	job: Type.String({ description: "Job id, for `/jobs kill <id>`" }),
	pid: Type.Number({ description: "Process group leader" }),
	log: Type.String({ description: "Log file with the combined output" }),
	joined: Type.Optional(Type.Boolean({ description: "true: an identical job already ran, so nothing was started" })),
	verification: Type.Optional(verificationSchema),
});

/**
 * The thresholds are the defaults, said as such: the description is declared once, ahead of the cached prompt, while
 * `bashBackgroundAfterSeconds` and `bash.longCommandAfterSeconds` are read per call (`settingsFor`).
 */
export function bashDescription(): string {
	return `Background builds, suites, servers and work over a minute. Get job id, pid and log now, completion by message. Foreground combines output and backgrounds on user input or after ${SETTINGS_DEFAULTS.bashBackgroundAfterSeconds}s (${SETTINGS_DEFAULTS.bash.longCommandAfterSeconds}s for builds, tests, servers). Inspect effects before retrying a timeout.\n\n${renderCliGuide(probeCliHost())}`;
}

/** Programmatic callers receive `structuredContent` only from tools that declare its schema. */
export function bashOutputSchema(builtin: TSchema) {
	return Type.Union([
		Type.Intersect([builtin, Type.Object({ verification: Type.Optional(verificationSchema) })]),
		BACKGROUND_OUTPUT,
	]);
}

export const bashParameters = Type.Object({
	type: Type.Optional(
		StringEnum(["bash", "powershell"] as const, {
			description: "Default: configured shell",
		}),
	),
	command: Type.String({ description: "Command in the selected syntax" }),
	timeout: Type.Optional(
		Type.Number({
			// The description states when an unset foreground call backgrounds; this field says only when the command stops.
			description: `Seconds before stop (max ${MAX_FOREGROUND_TIMEOUT}); a foreground call with it waits at most ${SETTINGS_DEFAULTS.bash.deliberateMaxSeconds} s, then backgrounds. Unset: never stopped`,
		}),
	),
	maxOutputTokens: maxOutputTokensParameter,
	background: Type.Optional(
		Type.Boolean({
			description: "true: return at once",
		}),
	),
	fresh: Type.Optional(
		Type.Boolean({
			description: "Background: start anew though an identical job runs",
		}),
	),
	verify: Type.Optional(
		Type.Boolean({
			description: "Record verification for current edits (later edits make it stale)",
		}),
	),
	sandbox: Type.Optional(
		Type.Boolean({
			description: "false: run outside the sandbox after it refused; asks the user",
		}),
	),
	item: Type.Optional(
		Type.String({
			description: "Background: your ongoing item (B<n>) this job serves",
		}),
	),
	// Declared here (last, as the native wrapper adds it) so a job keeps it as its why.
	reason: reasonSchema(),
});

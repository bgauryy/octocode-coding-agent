// What the `bash` tool declares to the model: description, parameters and output schema.
import { StringEnum } from "@octocodeai/octocode-contracts/schema";
import { Type, type TSchema } from "typebox";
import { SETTINGS_DEFAULTS } from "../../../core/settings-defaults.ts";
import { maxOutputTokensParameter } from "../../../core/tools/bash.ts";
import { reasonSchema } from "../../shared/reason.ts";
import { probeCliHost, renderCliGuide } from "./cli-guide.ts";
import { DEFAULT_BASH_TIMEOUT, MAX_FOREGROUND_TIMEOUT } from "./results.ts";
import { verificationSchema } from "./verification.ts";

/** `structuredContent` of a background start; a foreground command returns Octocode's own bash output. */
const BACKGROUND_OUTPUT = Type.Object({
	job: Type.String({ description: "Job id, for `/jobs kill <id>`" }),
	pid: Type.Number({ description: "Process group leader" }),
	log: Type.String({ description: "Log file with the combined output" }),
	verification: Type.Optional(verificationSchema),
});

/**
 * The thresholds are the defaults, said as such: the description is declared once, ahead of the cached prompt, while
 * `bashBackgroundAfterSeconds` and `bash.longCommandAfterSeconds` are read per call (`settingsFor`).
 */
export function bashDescription(): string {
	return `Run commands in the working directory. Builds, full test suites, servers and work over a minute go in background: job id, pid and log path now, a completion message later. Foreground returns combined output; it moves to background after ${SETTINGS_DEFAULTS.bashBackgroundAfterSeconds}s by default (${SETTINGS_DEFAULTS.bash.longCommandAfterSeconds}s for test runners, builds, servers) or on a user message. A timeout does not undo effects: inspect results before rerunning.\n\n${renderCliGuide(probeCliHost())}`;
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
			description: "bash (default, configured shell) or powershell (Windows)",
		}),
	),
	command: Type.String({ description: "Command in the selected syntax" }),
	timeout: Type.Optional(
		Type.Number({
			description: `Seconds until it stops (foreground: default ${DEFAULT_BASH_TIMEOUT}, max ${MAX_FOREGROUND_TIMEOUT}; background: none unless set); omit: a long command moves to the background`,
		}),
	),
	maxOutputTokens: maxOutputTokensParameter,
	background: Type.Optional(
		Type.Boolean({
			description: "true: return at once; a foreground wait over 10 min moves to the background",
		}),
	),
	verify: Type.Optional(
		Type.Boolean({
			description:
				"Record verification for current edits (later edits make it stale); exit 0 proves only the command succeeded",
		}),
	),
	sandbox: Type.Optional(
		Type.Boolean({
			description:
				"false: run outside the command sandbox after it refused something the command needs; asks the user each time",
		}),
	),
	item: Type.Optional(
		Type.String({
			description: "Background: your ongoing item (B<n>) this job serves; it is not idle meanwhile",
		}),
	),
	// Declared here (last, as the native wrapper adds it) so a job keeps it as its why.
	reason: reasonSchema(),
});

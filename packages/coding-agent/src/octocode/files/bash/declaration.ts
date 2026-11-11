// What the `bash` tool declares to the model: description, parameters, output schema and call header.
import { StringEnum } from "@octocodeai/octocode-contracts/schema";
import { Type, type Static, type TSchema } from "typebox";
import { SETTINGS_DEFAULTS } from "../../../core/settings-defaults.ts";
import { maxOutputTokensParameter } from "../../../core/tools/bash.ts";
import type { Theme } from "../../../theme/theme.ts";
import { formatDuration } from "../../shared/format.ts";
import { reasonSchema } from "../../shared/reason.ts";
import { toolHeader } from "../../render/tool.ts";
import type { RenderContext } from "../../render/types.ts";
import { probeCliHost, renderCliGuide } from "./cli-guide.ts";
import { LONG_COMMAND_AFTER_SECONDS } from "./long-commands.ts";
import { MAX_FOREGROUND_TIMEOUT } from "./results.ts";
import { verificationSchema } from "./verification.ts";

/** `structuredContent` of a background start; a foreground command returns Octocode's own bash output. */
const BACKGROUND_OUTPUT = Type.Object({
	job: Type.String({ description: "Job id, for `/jobs kill <id>`" }),
	pid: Type.Number({ description: "Process group leader" }),
	log: Type.String({ description: "Log file with the combined output" }),
	verification: Type.Optional(verificationSchema),
});

export function bashDescription(): string {
	return (
		"Run a command in the working directory. Foreground returns the combined output. " +
		`Background (use it for builds, full test suites, servers, anything over a minute) returns a job id, pid and log path; completion arrives as a message. A foreground call moves to the background after ${SETTINGS_DEFAULTS.bashBackgroundAfterSeconds}s (${LONG_COMMAND_AFTER_SECONDS}s for test runners, builds and servers) or on a user message. A timeout does not undo side effects: inspect the result before rerunning.\n\n${renderCliGuide(probeCliHost())}`
	);
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
			description: `Seconds (max ${MAX_FOREGROUND_TIMEOUT}): a foreground command moves to the background then, or is stopped with background false; a background job has none unless set`,
		}),
	),
	maxOutputTokens: maxOutputTokensParameter,
	background: Type.Optional(
		Type.Boolean({
			description: "true: return at once; false with a timeout: wait; stop at the timeout or move after 10 min",
		}),
	),
	verify: Type.Optional(
		Type.Boolean({
			description:
				"Record a verification receipt tied to the current edits; a later edit makes it stale, and a zero exit proves only that the command succeeded.",
		}),
	),
	// Declared here (last, as the native wrapper adds it) so a job keeps it as its why.
	reason: reasonSchema(),
});

export function renderBashCall(args: Static<typeof bashParameters>, theme: Theme, context: RenderContext) {
	// The timeout shows only when the model set one; the default deadline is in the tool description.
	const asked = typeof args.timeout === "number" && args.timeout > 0 ? args.timeout : undefined;
	const timeout = asked ? `timeout ${formatDuration(asked * 1000)}` : "";
	const meta = [args.background ? "background" : "", timeout].filter(Boolean).join(" · ");
	return toolHeader(
		theme,
		context,
		args.type === "powershell" ? "PowerShell" : "Bash",
		typeof args.command === "string" ? args.command : "",
		meta ? { meta } : {},
	);
}

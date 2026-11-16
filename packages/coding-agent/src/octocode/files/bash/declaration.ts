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
import { DEFAULT_BASH_TIMEOUT, MAX_FOREGROUND_TIMEOUT } from "./results.ts";
import { verificationSchema } from "./verification.ts";

/** `structuredContent` of a background start; a foreground command returns Octocode's own bash output. */
const BACKGROUND_OUTPUT = Type.Object({
	job: Type.String({ description: "Job id, for `/jobs kill <id>`" }),
	pid: Type.Number({ description: "Process group leader" }),
	log: Type.String({ description: "Log file with the combined output" }),
	verification: Type.Optional(verificationSchema),
});

export function bashDescription(): string {
	return `Run commands in the working directory. Run builds, full test suites, servers or work over a minute in background: get job id, pid and log path, then a completion message. Foreground returns combined output and moves to background after ${SETTINGS_DEFAULTS.bashBackgroundAfterSeconds}s (${SETTINGS_DEFAULTS.bash.longCommandAfterSeconds}s for test runners, builds and servers) or on a user message. Timeouts do not undo effects; inspect results before rerunning.\n\n${renderCliGuide(probeCliHost())}`;
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
			description: `Seconds until the command is stopped (foreground default ${DEFAULT_BASH_TIMEOUT}s, max ${MAX_FOREGROUND_TIMEOUT}s; a background job has none unless set); omit to let a long command move to the background`,
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
				"Record verification for current edits; later edits make it stale. Zero exit proves only command success.",
		}),
	),
	item: Type.Optional(
		Type.String({
			description: "Background: your ongoing backlog item (B<n>) this job serves; it is not idle meanwhile.",
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

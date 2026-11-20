import { applyNoColor } from "./no-color.ts";
import { configureHttpDispatcher } from "../core/http-dispatcher.ts";
import { initialTitle, setProcessTitle } from "../octocode/shared/process-title.ts";
import { dropForeignChildEnv } from "../octocode/subagents/process/child-env.ts";

export function setupCli(argv: readonly string[] = []): void {
	// An Octocode a subagent's command started is a top-level session, not that subagent.
	dropForeignChildEnv();
	// `octocode-agent-<role>-<id>`; a main session gets its id once its session exists (`octocode/processes/register.ts`).
	setProcessTitle(initialTitle(process.env, "main"));
	process.env.OCTOCODE_CODING_AGENT = "true";
	process.env.AI_AGENT = "octocode";
	process.emitWarning = () => {};
	applyNoColor(argv);

	// Configure undici before provider SDKs issue requests. Settings are applied
	// once SettingsManager has loaded global/project configuration.
	configureHttpDispatcher();
}

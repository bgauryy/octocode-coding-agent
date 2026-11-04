import chalk, { chalkStderr } from "chalk";
import { configureHttpDispatcher } from "../core/http-dispatcher.ts";
import { initialTitle, setProcessTitle } from "../octocode/processes/title.ts";
import { dropForeignChildEnv } from "../octocode/subagents/process/child-env.ts";

export function setupCli(): void {
	// An Octocode a subagent's command started is a top-level session, not that subagent.
	dropForeignChildEnv();
	// `octocode-<role>-<id>`; a main session gets its id once its session exists (`octocode/processes/register.ts`).
	setProcessTitle(initialTitle(process.env, "main"));
	process.env.OCTOCODE_CODING_AGENT = "true";
	process.env.AI_AGENT = "octocode";
	process.emitWarning = () => {};
	// https://no-color.org: any non-empty NO_COLOR turns off ANSI color in CLI output.
	if (process.env.NO_COLOR) {
		chalk.level = 0;
		chalkStderr.level = 0;
	}

	// Configure undici before provider SDKs issue requests. Settings are applied
	// once SettingsManager has loaded global/project configuration.
	configureHttpDispatcher();
}

import chalk, { chalkStderr } from "chalk";
import { APP_NAME } from "../config.ts";
import { configureHttpDispatcher } from "../core/http-dispatcher.ts";

export function setupCli(): void {
	process.title = APP_NAME;
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

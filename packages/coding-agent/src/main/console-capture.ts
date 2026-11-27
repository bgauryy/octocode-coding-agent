import { appendFileSync, mkdirSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { PRIVATE_FILE_MODE } from "@octocodeai/octocode-common/file-mode";
import { redactSecrets } from "@octocodeai/octocode-common/sanitize";
import { isScreenOwned } from "@octocodeai/octocode-tui";
import { APP_NAME, getAgentDir } from "../config.ts";
import { captureConsole } from "../core/output-guard.ts";

const MAX_LOG_BYTES = 1024 * 1024;

function getConsoleLogPath(): string {
	return path.join(getAgentDir(), `${APP_NAME}-console.log`);
}

/** Appends one line to the console log; a log past 1 MiB starts over, so it never grows without bound. */
function appendConsoleLine(file: string, level: string, text: string): void {
	mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
	let size = 0;
	try {
		size = statSync(file).size;
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
	}
	if (size > MAX_LOG_BYTES) writeFileSync(file, "", { mode: PRIVATE_FILE_MODE });
	appendFileSync(file, redactSecrets(`${new Date().toISOString()} ${level} ${text}\n`), { mode: PRIVATE_FILE_MODE });
}

/**
 * While the terminal UI owns the screen, `console.*` output goes to the console log in the agent folder instead of
 * the frame. Returns the function that restores the console; call it on every exit path.
 */
export function captureConsoleToLog(file: string = getConsoleLogPath()): () => void {
	return captureConsole((level, text) => appendConsoleLine(file, level, text), isScreenOwned);
}

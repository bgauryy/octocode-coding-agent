/** `/fork pane [right|down]` and `/fork window`: open a fork of this session in a new tmux pane or window. */

import { existsSync } from "node:fs";
import { getCliInvocation } from "../../../config.ts";
import { hasTmuxSession } from "@octocodeai/octocode-tui";
import { forwardedLaunchEnv, launchInTmux, type TmuxLaunchRequest } from "../../../octocode/terminal-launch/tmux.ts";
import { errorMessage } from "@octocodeai/octocode-contracts/guards";
import type { InteractiveModeHost } from "./host.ts";

const FORK_LAUNCH_USAGE = "Usage: /fork [pane [right|down] | window]";

type ForkLaunchHost = Pick<InteractiveModeHost, "sessionManager" | "showError" | "showStatus" | "showWarning">;

/** Where `/fork`'s arguments ask to open the fork, or undefined when they are not a launch request. */
export function parseForkLaunch(args: string): Pick<TmuxLaunchRequest, "placement" | "direction"> | undefined {
	const [place, direction, ...rest] = args.trim().toLowerCase().split(/\s+/u);
	if (rest.length > 0) return undefined;
	if (place === "window" && direction === undefined) return { placement: "window" };
	if (place !== "pane") return undefined;
	if (direction === undefined || direction === "right") return { placement: "pane", direction: "right" };
	if (direction === "down") return { placement: "pane", direction: "down" };
	return undefined;
}

/** Handles `/fork`'s launch arguments; anything else shows the usage line. */
export async function handleForkLaunchCommand(host: ForkLaunchHost, args: string): Promise<void> {
	const where = parseForkLaunch(args);
	if (!where) return host.showWarning(FORK_LAUNCH_USAGE);
	if (!hasTmuxSession()) return host.showError("/fork pane and /fork window need Octocode to run inside tmux.");
	const sessionFile = host.sessionManager.getSessionFile();
	if (!sessionFile || !existsSync(sessionFile)) return host.showStatus("Nothing to fork yet");

	const { command, prefix } = getCliInvocation();
	try {
		const result = await launchInTmux({
			...where,
			command: [command, ...prefix, "--fork", sessionFile, "--session-dir", host.sessionManager.getSessionDir()],
			cwd: host.sessionManager.getCwd(),
			env: forwardedLaunchEnv(process.env),
		});
		host.showStatus(`Opened fork in tmux ${result.placement} ${result.id}`);
	} catch (error: unknown) {
		host.showError(`Could not open the fork in tmux: ${errorMessage(error)}`);
	}
}

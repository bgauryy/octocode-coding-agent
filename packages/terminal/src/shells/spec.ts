import type { DriverLaunch } from "../driver-process.ts";
import type { ShellName } from "../types.ts";

interface LaunchInput {
	/** Absolute path of the shell binary. */
	binary: string;
	/** A private directory holding the spec's `files`, removed when the shell stops. */
	dir: string;
	loadRc: boolean;
	env: NodeJS.ProcessEnv;
}

/** How one shell is started as a completion driver. */
export interface ShellSpec {
	name: ShellName;
	/** Executable names tried on PATH, in order. */
	binary: string | string[];
	/** Files written to the private directory before the shell starts. */
	files: Record<string, string>;
	launch(input: LaunchInput): Omit<DriverLaunch, "cwd">;
	/** True when the driver can only complete the command the cursor is in (bash splits words itself). */
	segmentOnly: boolean;
}

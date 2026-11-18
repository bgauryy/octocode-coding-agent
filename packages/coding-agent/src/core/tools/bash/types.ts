/** Types shared by the bash tool, the shell executor and the feature contract; imports nothing from them. */

/**
 * Pluggable operations for the bash tool.
 * Override these to delegate command execution to remote systems (for example SSH).
 */
export interface BashOperations {
	/**
	 * Execute a command and stream output.
	 * @param command The command to execute
	 * @param cwd Working directory
	 * @param options Execution options
	 * @returns Promise resolving to the exit code. Report signal terminations as 128 + signal number;
	 * a null exit code is treated as a failed command.
	 */
	exec: (
		command: string,
		cwd: string,
		options: {
			onData: (data: Buffer) => void;
			signal?: AbortSignal;
			timeout?: number;
			env?: NodeJS.ProcessEnv;
		},
	) => Promise<{ exitCode: number | null }>;
}

export interface BashResult {
	/** Combined stdout + stderr output (sanitized; trimmed to the budget when `truncated`) */
	output: string;
	/** Process exit code (undefined if killed/cancelled) */
	exitCode: number | undefined;
	/** Whether the command was cancelled via signal */
	cancelled: boolean;
	/** Whether the output was truncated */
	truncated: boolean;
	/** Path to the file containing full output (if output exceeded the budget) */
	fullOutputPath?: string;
	/**
	 * The result's first line for the model and the terminal, e.g. `[exit 0 · 4.2s · 312 lines · 18 KB]`; a trimmed
	 * result adds what was kept and where the full output is. Absent from results a feature supplies.
	 */
	header?: string;
	/** Lines and bytes of the whole output, and the run time in seconds. */
	totalLines?: number;
	totalBytes?: number;
	wallTimeSeconds?: number;
}

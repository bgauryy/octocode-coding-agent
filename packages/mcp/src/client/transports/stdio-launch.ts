/** What a sandbox runs instead of a server's launch; `release` is called once the server has ended or never started. */
export interface StdioWrappedLaunch {
	file: string;
	args: string[];
	/** Variables the sandbox needs, over the server's own. */
	env: Record<string, string>;
	release(): void;
}

/** Turns a server's launch into the program that runs it inside a sandbox; rejects when it cannot. */
export type StdioLaunchWrapper = (launch: {
	command: string;
	args: readonly string[];
	cwd: string;
}) => Promise<StdioWrappedLaunch>;

/** The program a stdio transport spawns, its arguments and environment, and what to release when it ends. */
export interface StdioLaunch {
	file: string;
	args: string[];
	env: NodeJS.ProcessEnv;
	release: (() => void) | undefined;
}

/** The server's own launch, or the one `wrap` turns it into. */
export async function stdioLaunch(
	options: { command: string; args?: readonly string[]; cwd?: string; wrapLaunch?: StdioLaunchWrapper },
	env: NodeJS.ProcessEnv,
): Promise<StdioLaunch> {
	const args = [...(options.args ?? [])];
	if (!options.wrapLaunch) return { file: options.command, args, env, release: undefined };
	const wrapped = await options.wrapLaunch({ command: options.command, args, cwd: options.cwd ?? process.cwd() });
	return { file: wrapped.file, args: wrapped.args, env: { ...env, ...wrapped.env }, release: wrapped.release };
}

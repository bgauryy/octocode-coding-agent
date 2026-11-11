import { captureCli } from "./run.ts";
import { resolveOctocodeCli } from "./resolve.ts";

/** The chat notice when the CLI reports GitHub as not signed in. */
export const GITHUB_LOGIN_NOTICE = "GitHub is not connected for code search: run /octocode auth login";

/** The CLI's documented exit codes (`octocode --help`, Exits): invalid input (an unknown option too) and auth required. */
const EXIT_INVALID = 2;
const EXIT_AUTH = 4;
const LIMIT = 64_000;

/** How the check runs the CLI: `captureCli` on the resolved bin; tests replace it. */
export type RunCli = (argv: string[], signal: AbortSignal) => Promise<{ code: number | null; stdout: string }>;

/**
 * Whether the octocode CLI says GitHub is not signed in, from `octocode auth status --json`: exit code 4, the CLI's
 * documented "auth required", or the documented JSON field `authenticated: false`. A CLI too old for `--json` rejects it
 * as invalid input (exit 2); it is then asked plainly and only its exit code counts. One run on a current CLI, two on an
 * old one. False whenever the answer is not that clear: no CLI, a run that fails, times out or is cancelled, or output
 * that does not parse. Each run is bounded by `timeoutMs` and by `signal`.
 */
export async function githubLoginMissing(
	signal: AbortSignal,
	options: { cwd: string; timeoutMs?: number; run?: RunCli },
): Promise<boolean> {
	const cli = resolveOctocodeCli();
	if (!cli) return false;
	const run: RunCli =
		options.run ?? ((argv, giveUp) => captureCli(cli.bin, argv, { cwd: options.cwd, signal: giveUp, maxBytes: LIMIT }));
	const bounded = (argv: string[]) => {
		const giveUp = AbortSignal.any([signal, AbortSignal.timeout(options.timeoutMs ?? 10_000)]);
		return run(argv, giveUp).then(
			(result) => (giveUp.aborted ? undefined : result),
			// A CLI that cannot start is the same as no answer: the check stays silent.
			() => undefined,
		);
	};
	const status = await bounded(["auth", "status", "--json"]);
	if (!status || signal.aborted) return false;
	if (status.code === EXIT_AUTH) return true;
	if (status.code === EXIT_INVALID) {
		const plain = await bounded(["auth", "status"]);
		return plain?.code === EXIT_AUTH;
	}
	try {
		return (JSON.parse(status.stdout) as { authenticated?: unknown }).authenticated === false;
	} catch {
		return false;
	}
}

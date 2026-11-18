import type { FeatureSetup, CommandContext } from "../../core/features/index.ts";
import { parseCommandArgs } from "../../core/prompt-templates.ts";
import { hintText, interruptKey } from "../../theme/theme-tui-helpers.ts";
import { type Subcommand, type Subcommands, say } from "../shared/commands.ts";
import { isStaleSessionError } from "../shared/util.ts";
import { completeCliArgs, isCliCommand } from "./help.ts";
import { GITHUB_LOGIN_NOTICE, githubLoginMissing } from "./login-check.ts";
import { resolveOctocodeCli } from "./resolve.ts";
import { captureCli, ownsTerminal, runCliInTerminal } from "./run.ts";
import { octocodeShimError } from "./shim.ts";

const MAX_OUTPUT = 20_000;
const MISSING =
	"The octocode research CLI is not available: Octocode Code depends on the `octocode` package, which did not resolve or is not built (in a checkout, build ../octocode/packages/octocode).";
const STATUS_KEY = "octocode-cli";

/**
 * Without a terminal to hand over (RPC, web, a piped session) the CLI runs with stdin closed and its output becomes the
 * command result. Esc in the terminal or `ctx.signal` stops it.
 */
async function captured(ctx: CommandContext, bin: string, argv: string[], label: string): Promise<void> {
	const cancel = new AbortController();
	const stopListening = ctx.ui.onTerminalInput((data) => {
		if (data !== "\x1b") return undefined;
		cancel.abort();
		return { consume: true };
	});
	const signal = ctx.signal ? AbortSignal.any([cancel.signal, ctx.signal]) : cancel.signal;
	ctx.ui.setStatus(
		STATUS_KEY,
		`${label}…${interruptKey() ? ` · ${hintText([[interruptKey(), "cancel"]])}` : ""}`,
		"accent",
	);
	try {
		const { output, code, truncated, cancelled } = await captureCli(bin, argv, {
			cwd: ctx.cwd,
			signal,
			maxBytes: MAX_OUTPUT,
		});
		const text = [
			output || (cancelled ? "" : `${label} exited with ${code ?? "an error"}.`),
			truncated ? `[output cut at ${MAX_OUTPUT / 1000} KB]` : undefined,
			cancelled ? `${label} was cancelled.` : undefined,
			octocodeShimError(),
		]
			.filter(Boolean)
			.join("\n\n");
		say(ctx, text, !cancelled && code === 0 ? "info" : "warning");
	} finally {
		stopListening();
		ctx.ui.setStatus(STATUS_KEY, undefined);
	}
}

/** Sends text to the agent as a prompt the user typed. */
export type SendPrompt = (text: string, ctx: CommandContext) => void;

/**
 * `/octocode <args>`: the research CLI, run with the arguments exactly as typed (quotes group words, as in a shell); no
 * arguments is the CLI's own no-argument behavior. It knows no subcommand: on a terminal the CLI gets the real terminal
 * (`runCliInTerminal`), so interactive commands such as a device-flow sign-in work; elsewhere its output is captured.
 * A first word that is neither an option nor a command of the CLI (`isCliCommand`) is not meant for it: with `send`,
 * the whole line goes to the agent as a regular prompt instead.
 * The user typed it, so it runs in every mode, plan mode included, as `!cmd` does; `record` (the permission audit's
 * `typed`, wired by the composition root, since `cli` may not import `permission`) logs each run before it starts.
 */
export const createOctocodeCommand = (
	record?: (command: string, cwd: string) => void,
	send?: SendPrompt,
): Subcommand => ({
	description: "Run the Octocode research CLI",
	argumentHint: "[octocode arguments]",
	dialog: "interaction",
	complete: completeCliArgs,
	handler: async (args, ctx) => {
		const cli = resolveOctocodeCli();
		if (!cli) return say(ctx, MISSING, "warning");
		const argv = parseCommandArgs(args);
		const first = argv[0];
		if (send && first !== undefined && !first.startsWith("-") && !isCliCommand(first))
			return send(`/octocode ${args.trim()}`, ctx);
		const label = ["octocode", ...argv].join(" ");
		record?.(`/octocode ${args.trim()}`.trimEnd(), ctx.cwd);
		if (ownsTerminal()) {
			const code = await runCliInTerminal(ctx, cli.bin, argv, label);
			if (code !== undefined) {
				const text = [`${label} exited with ${code ?? "an error"}.`, octocodeShimError()].filter(Boolean);
				return say(ctx, text.join("\n\n"), code === 0 ? "info" : "warning");
			}
		}
		await captured(ctx, cli.bin, argv, label);
	},
});

/**
 * Registers `/octocode` and, for a session a person watches, one background GitHub sign-in check per Octocode run
 * (`githubLoginMissing`): a single notice when the CLI says GitHub is not connected, silence otherwise. Session end
 * cancels a check still running; a cancelled check runs again with the next session.
 */
export function registerOctocodeCli(
	api: FeatureSetup,
	commands: Subcommands,
	record?: (command: string, cwd: string) => void,
): void {
	commands.add(
		"octocode",
		createOctocodeCommand(record, (text, ctx) =>
			api.session.sendUserMessage(text, ctx.isIdle() ? undefined : { deliverAs: "followUp" }),
		),
	);
	let done = false;
	let running: AbortController | undefined;
	api.bus.on("session_start", async (_event, ctx) => {
		if (done || running || !ctx.hasUI) return;
		const check = new AbortController();
		running = check;
		void githubLoginMissing(check.signal, { cwd: ctx.cwd }).then((missing) => {
			if (running === check) running = undefined;
			if (check.signal.aborted) return;
			done = true;
			if (!missing) return;
			try {
				say(ctx, GITHUB_LOGIN_NOTICE, "warning");
			} catch (error) {
				// The session was replaced or reloaded while the check ran: its ctx is gone and the notice has no reader.
				if (!isStaleSessionError(error)) throw error;
			}
		});
	});
	api.bus.on("session_shutdown", async () => {
		running?.abort();
		running = undefined;
	});
}

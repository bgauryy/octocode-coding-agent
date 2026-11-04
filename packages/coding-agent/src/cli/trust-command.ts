import path from "node:path";
import { createInterface } from "node:readline/promises";
import { APP_NAME } from "../config.ts";
import type { GrantTarget } from "../octocode/trust/grants.ts";
import {
	addTrust,
	appliesTo,
	describeAll,
	describeGrant,
	findEntry,
	GRANT_TARGETS,
	grantPath,
	liveGrants,
	removeTrust,
	TrustCommandError,
} from "../octocode/trust/manage.ts";
import { shown } from "../octocode/trust/messages.ts";
import { belowSession, insideSessionShell, sessionShellRefusal } from "../octocode/trust/session-shell.ts";
import { resolveFolderTrust, type TrustOptions } from "../octocode/trust/resolve.ts";

const TRUST_COMMAND_USAGE = `Usage:
  ${APP_NAME} trust list [--json]
  ${APP_NAME} trust add [path] [--scope folder|parent|grandparent] [--yes]
  ${APP_NAME} trust remove <number|path> [--yes]

list shows where the current folder stands and every stored decision. add trusts a folder (default: the current one)
and asks first; --yes skips the question for scripts. remove deletes a decision, so Octocode asks about the folder
again. Decisions live in Octocode's agent database (OCTOCODE_AGENT_DB names another file). add and remove refuse to
run from inside an Octocode session's shell, and add --yes with no terminal refuses below a running session: trust is
your decision, so run them in your own terminal.`;

export interface TrustCommandIo {
	cwd: string;
	/** Where the records are read from; tests name an isolated database and home. */
	options?: TrustOptions;
	out?: (text: string) => void;
	err?: (text: string) => void;
	/** Answers a yes/no question; undefined when there is no terminal to ask on. */
	confirm?: ((question: string) => Promise<boolean>) | undefined;
	/** Whether a running session started this process; the process tree by default. */
	belowSession?: () => boolean;
}

async function askOnTerminal(question: string): Promise<boolean> {
	const lines = createInterface({ input: process.stdin, output: process.stderr });
	try {
		return /^y(es)?$/i.test((await lines.question(`${question} [y/N] `)).trim());
	} finally {
		lines.close();
	}
}

const terminalConfirm = (): TrustCommandIo["confirm"] =>
	process.stdin.isTTY && process.stderr.isTTY ? askOnTerminal : undefined;

/** Runs `octocode trust ...` and returns the process exit code: 0 done or nothing to do, 1 refused or failed. */
export async function runTrustCommand(args: string[], io: TrustCommandIo): Promise<number> {
	const out = io.out ?? ((text: string) => console.log(text));
	const err = io.err ?? ((text: string) => console.error(text));
	const options = io.options ?? {};
	const confirm = "confirm" in io ? io.confirm : terminalConfirm();
	const [sub = "list", ...words] = args;
	if (sub === "help" || sub === "--help" || sub === "-h") {
		out(TRUST_COMMAND_USAGE);
		return 0;
	}
	let scope: GrantTarget = "folder";
	let yes = false;
	let json = false;
	const rest: string[] = [];
	for (let index = 0; index < words.length; index += 1) {
		const word = words[index] ?? "";
		if (word === "--yes" || word === "-y") yes = true;
		else if (word === "--json") json = true;
		else if (word === "--scope") {
			const value = words[++index] as GrantTarget | undefined;
			if (!value || !GRANT_TARGETS.includes(value)) {
				err(`--scope takes folder, parent or grandparent.\n${TRUST_COMMAND_USAGE}`);
				return 1;
			}
			scope = value;
		} else if (word.startsWith("-")) {
			err(`Unknown option ${word}.\n${TRUST_COMMAND_USAGE}`);
			return 1;
		} else rest.push(word);
	}

	if ((sub === "add" || sub === "remove") && insideSessionShell(options.env)) {
		err(sessionShellRefusal(sub === "add" ? "trust the folder" : "remove the trust decision"));
		return 1;
	}
	// A script's `--yes` has no terminal, and neither has a session's shell, which can also remove the variable. What it
	// cannot change is what started it. `options.env` names an isolated store, so that is a caller's own tree of processes.
	if (sub === "add" && yes && !confirm && options.env === undefined && (io.belowSession ?? belowSession)()) {
		err(sessionShellRefusal("trust the folder"));
		return 1;
	}

	try {
		if (sub === "list") {
			out(json ? JSON.stringify(liveGrants(options), null, 2) : describeAll(io.cwd, options));
			return 0;
		}
		if (sub === "add") {
			const folder = path.resolve(io.cwd, rest.join(" ") || ".");
			const target = grantPath(folder, scope, options);
			const now = resolveFolderTrust(target, options);
			if (now.state === "trusted" && (now.root === now.path || scope === "folder")) {
				out(`${shown(target)} is already trusted${now.root === now.path ? "" : ` (by ${shown(now.root)})`}.`);
				return 0;
			}
			if (
				!yes &&
				!(await confirm?.(`Trust ${shown(target)}${scope === "folder" ? "" : " and everything under it"}?`))
			) {
				if (confirm) return (err("Nothing was changed."), 1);
				err("Trusting a folder needs your confirmation. Run it in a terminal, or add --yes.");
				return 1;
			}
			const granted = addTrust(folder, scope, "cli", options);
			out(`Trusted ${shown(granted.path)}${granted.scope === "subtree" ? " and everything under it" : ""}.`);
			return 0;
		}
		if (sub === "remove") {
			const row = findEntry(rest.join(" "), options);
			const closes = appliesTo(row, io.cwd, options);
			if (!yes && !(await confirm?.(`Remove ${describeGrant(row)}?`))) {
				if (confirm) return (err("Nothing was changed."), 1);
				err("Removing a decision needs your confirmation. Run it in a terminal, or add --yes.");
				return 1;
			}
			removeTrust(row, options);
			out(`Removed ${describeGrant(row)}.${closes ? " Octocode will ask about this folder again." : ""}`);
			return 0;
		}
	} catch (error) {
		if (!(error instanceof TrustCommandError)) throw error;
		err(error.message);
		return 1;
	}
	err(`Unknown trust command ${sub}.\n${TRUST_COMMAND_USAGE}`);
	return 1;
}

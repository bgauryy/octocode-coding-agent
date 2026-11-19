import { APP_NAME, getAgentDir } from "../config.ts";
import { prepareAgentDb } from "../storage/database.ts";
import {
	approveAll,
	checkTable,
	decideOne,
	findReview,
	listText,
	parseKinds,
	refreshed,
	SecurityCommandError,
} from "../octocode/guard/actions.ts";
import { collectReviews } from "../octocode/guard/collect.ts";
import { isWithheld, resetGateRecords } from "../octocode/guard/registry.ts";
import { renderReport } from "../octocode/guard/report.ts";
import type { GuardOptions } from "../octocode/guard/store.ts";
import { belowSession, insideSessionShell, sessionShellRefusal } from "../octocode/trust/session-shell.ts";

const USAGE = `Usage:
  ${APP_NAME} security list [text]
  ${APP_NAME} security show <id>
  ${APP_NAME} security check
  ${APP_NAME} security approve <id>
  ${APP_NAME} security approve --all [--kind hooks,mcp,skills]
  ${APP_NAME} security deny <id>
  ${APP_NAME} security forget <id>

Lists the hooks, MCP servers and skills Octocode did not ship that a session in this folder would load, and records
your decisions. Items that are not approved stay off. approve --all approves every waiting item at its current content
and never a Critical one; run it on a checkout you trust, before the run, never after checking out someone else's
changes. approve, deny and forget refuse to run from inside an Octocode session's shell: they are your decisions.`;

export interface SecurityCommandIo {
	cwd: string;
	agentDir?: string;
	/** Where decisions are read and written; tests name an isolated database. */
	options?: GuardOptions;
	out?: (text: string) => void;
	err?: (text: string) => void;
	/** Whether a running session started this process; the process tree by default. */
	belowSession?: () => boolean;
}

/** Runs `octocode security ...` and returns the exit code: 0 done, 1 refused or failed. */
export async function runSecurityCommand(args: string[], io: SecurityCommandIo): Promise<number> {
	const out = io.out ?? ((text: string) => console.log(text));
	const err = io.err ?? ((text: string) => console.error(text));
	const options = io.options ?? {};
	const [sub = "list", ...words] = args;
	if (sub === "help" || sub === "--help" || sub === "-h") {
		out(USAGE);
		return 0;
	}
	// Judge the words before loading anything: a typo must not first print a notice about the folder.
	const wantsId = sub === "show" || sub === "approve" || sub === "deny" || sub === "forget";
	const known = sub === "list" || sub === "check" || wantsId;
	if (!known || (wantsId && !words[0])) {
		err(known ? USAGE : `Unknown security command "${sub}".\n${USAGE}`);
		return 1;
	}
	const verb = sub === "approve" || sub === "deny" || sub === "forget" ? sub : undefined;
	const records = verb !== undefined;
	// The agent can run commands in its shell, and a decision is the user's: refuse there, and below a running session.
	if (
		records &&
		(insideSessionShell(options.env) || (options.env === undefined && (io.belowSession ?? belowSession)()))
	) {
		err(sessionShellRefusal(`${sub} a hook, MCP server or skill`));
		return 1;
	}
	try {
		await prepareAgentDb();
		resetGateRecords();
		const found = await collectReviews(io.cwd, io.agentDir ?? getAgentDir());
		if (!found.trusted)
			err(
				"This folder is not trusted, so its own hooks, MCP servers and skills are not listed: `octocode trust add` first.",
			);
		if (options.env && !options.db) await prepareAgentDb(options.env);
		const reviews = refreshed(found.reviews, options);
		if (sub === "list") out(listText(reviews, (review) => isWithheld(review), words.join(" ") || undefined));
		else if (sub === "check") out(checkTable(reviews));
		else if (sub === "approve" && words[0] === "--all") {
			const kindAt = words.indexOf("--kind");
			out(
				approveAll(reviews, parseKinds(kindAt >= 0 ? words[kindAt + 1] : undefined), "cli", options).lines.join("\n"),
			);
		} else if ((sub === "show" || verb) && words[0]) {
			const review = findReview(reviews, words[0]);
			out(verb ? decideOne(review, verb, "cli", options) : renderReport(review));
		} else {
			err(USAGE);
			return 1;
		}
		return 0;
	} catch (error) {
		if (!(error instanceof SecurityCommandError)) throw error;
		err(error.message);
		return 1;
	}
}

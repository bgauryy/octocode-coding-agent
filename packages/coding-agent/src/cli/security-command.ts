import { APP_NAME, getAgentDir } from "../config.ts";
import { prepareAgentDb } from "../storage/database.ts";
import { loadMcpConfig } from "../../../mcp/src/api.ts";
import { effectivePlugins } from "../core/extensibility/toggles.ts";
import { DefaultResourceLoader } from "../core/resource-loader.ts";
import { SettingsManager } from "../core/settings-manager.ts";
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
import { enforces, isWithheld, knownReviews, resetGateRecords } from "../octocode/guard/registry.ts";
import { renderReport } from "../octocode/guard/report.ts";
import type { GuardOptions } from "../octocode/guard/store.ts";
import type { Review } from "../octocode/guard/types.ts";
import { loadHooks } from "../octocode/hooks/config.ts";
import { belowSession, insideSessionShell, sessionShellRefusal } from "../octocode/trust/session-shell.ts";
import { resolveFolderTrust } from "../octocode/trust/resolve.ts";

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

/** Runs the loaders a session runs, without starting one, and returns what the guard found. */
async function collect(cwd: string, agentDir: string): Promise<{ reviews: Review[]; trusted: boolean }> {
	resetGateRecords();
	const trusted = resolveFolderTrust(cwd).state === "trusted";
	const settingsManager = SettingsManager.create(cwd, agentDir, { projectTrusted: trusted });
	const settings = settingsManager.getSettings();
	loadHooks(cwd, trusted, undefined, {
		plugins: effectivePlugins(settings, cwd),
		toggles: settings.toggles ?? {},
		gate: { enforce: enforces(settingsManager.getGlobalSettings(), "hook") },
	});
	loadMcpConfig({ agentDir, cwd, projectTrusted: trusted });
	await new DefaultResourceLoader({
		cwd,
		agentDir,
		settingsManager,
		noThemes: true,
		noContextFiles: true,
	}).loadSkillsOnly();
	return { reviews: knownReviews(), trusted };
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
		const found = await collect(io.cwd, io.agentDir ?? getAgentDir());
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

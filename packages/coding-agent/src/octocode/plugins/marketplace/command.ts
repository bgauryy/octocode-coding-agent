import { createInterface } from "node:readline/promises";
import { errorMessage } from "@octocodeai/octocode-contracts/guards";
import { APP_NAME, getAgentDir } from "../../../config.ts";
import { SettingsManager } from "../../../core/settings-manager.ts";
import { marketplacePaths } from "./fetch.ts";
import {
	installPlugin,
	listInstalled,
	removeMarketplace,
	removePlugin,
	updatePlugins,
	type ConsentIo,
} from "./install.ts";
import { addMarketplace, listMarketplaces, type MarketplaceHost, updateMarketplace } from "./registry.ts";
import { describeSource, MarketplaceError, redactUrl } from "./source.ts";

const MARKETPLACE_USAGE = `Usage:
  ${APP_NAME} marketplace add <path|owner/repo[@ref]|git-url[#ref]>
  ${APP_NAME} marketplace list
  ${APP_NAME} marketplace update [name]
  ${APP_NAME} marketplace remove <name>

A marketplace is a folder or git repository with .claude-plugin/marketplace.json. add fetches it with a shallow clone
(https, ssh, git or file URLs, no credentials in the URL) and registers it in your user settings; nothing from the
repository runs. remove also uninstalls the plugins installed from it.`;

const PLUGIN_USAGE = `Usage:
  ${APP_NAME} plugin install <plugin@marketplace> [--yes]
  ${APP_NAME} plugin update [plugin@marketplace] [--yes]
  ${APP_NAME} plugin remove <plugin@marketplace>
  ${APP_NAME} plugin list

Installing or enabling a plugin approves the hooks and MCP servers it declares. install lists them and asks first;
update asks again when an update changes them. Without a terminal, pass --yes to approve.`;

export interface MarketplaceCommandIo {
	cwd: string;
	out?: (text: string) => void;
	err?: (text: string) => void;
	/** Answers a yes/no question; undefined when there is nobody to ask. */
	confirm?: ConsentIo["confirm"];
	/** Tests name an isolated environment and settings. */
	env?: NodeJS.ProcessEnv;
	settings?: SettingsManager;
	timeoutMs?: number;
}

async function askOnTerminal(question: string): Promise<boolean> {
	const lines = createInterface({ input: process.stdin, output: process.stderr });
	try {
		return /^y(es)?$/i.test((await lines.question(`${question} [y/N] `)).trim());
	} finally {
		lines.close();
	}
}

const terminalConfirm = (): ConsentIo["confirm"] =>
	process.stdin.isTTY && process.stderr.isTTY ? askOnTerminal : undefined;

function hostFor(io: MarketplaceCommandIo): MarketplaceHost {
	return {
		// Global settings only: no project file is read or written, so a repository cannot register a marketplace.
		settings: io.settings ?? SettingsManager.create(io.cwd, getAgentDir(), { projectTrusted: false }),
		paths: marketplacePaths(io.env),
		cwd: io.cwd,
		env: io.env,
		timeoutMs: io.timeoutMs,
	};
}

function parse(words: string[]): { rest: string[]; yes: boolean; unknown?: string } {
	const rest: string[] = [];
	let yes = false;
	for (const word of words) {
		if (word === "--yes" || word === "-y") yes = true;
		else if (word.startsWith("-")) return { rest, yes, unknown: word };
		else rest.push(word);
	}
	return { rest, yes };
}

const short = (sha: string | undefined) => (sha ? sha.slice(0, 12) : "-");

/** Runs `octocode marketplace ...`; returns the exit code. */
export async function runMarketplaceCommand(args: string[], io: MarketplaceCommandIo): Promise<number> {
	const out = io.out ?? ((text: string) => console.log(text));
	const err = io.err ?? ((text: string) => console.error(text));
	const [sub = "list", ...words] = args;
	if (sub === "help" || sub === "--help" || sub === "-h") return (out(MARKETPLACE_USAGE), 0);
	const { rest, unknown } = parse(words);
	if (unknown) return (err(`Unknown option ${unknown}.\n${MARKETPLACE_USAGE}`), 1);
	try {
		const host = hostFor(io);
		if (sub === "add") {
			if (rest.length !== 1) return (err(MARKETPLACE_USAGE), 1);
			const added = await addMarketplace(host, rest[0]);
			out(
				`Added marketplace ${added.name} (${describeSource(added.source)}), ${added.plugins} plugin${added.plugins === 1 ? "" : "s"}.`,
			);
		} else if (sub === "list") {
			const rows = listMarketplaces(host);
			if (rows.length === 0) out(`No marketplaces. Add one with: ${APP_NAME} marketplace add <source>`);
			for (const row of rows)
				out(
					`${row.name}  ${redactUrl(row.source)}${row.sha ? `  ${short(row.sha)}` : ""}\n  ${row.problem ?? (row.plugins.join(", ") || "no plugins")}`,
				);
		} else if (sub === "update") {
			const names = rest.length ? rest : Object.keys(host.settings.getMarketplaces());
			let failed = false;
			for (const name of names)
				try {
					const result = await updateMarketplace(host, name);
					out(
						result.status === "local"
							? `${name}: a local directory is read in place.`
							: `${name}: ${result.status}${result.sha ? ` (${short(result.sha)})` : ""}.`,
					);
				} catch (error) {
					failed = true;
					err(`${name}: ${errorMessage(error)}`);
				}
			return failed ? 1 : 0;
		} else if (sub === "remove") {
			if (rest.length !== 1) return (err(MARKETPLACE_USAGE), 1);
			const removed = await removeMarketplace(host, rest[0]);
			out(`Removed marketplace ${rest[0]}${removed.length ? ` and uninstalled ${removed.join(", ")}` : ""}.`);
		} else return (err(`Unknown command ${sub}.\n${MARKETPLACE_USAGE}`), 1);
		return 0;
	} catch (error) {
		if (!(error instanceof MarketplaceError)) throw error;
		err(error.message);
		return 1;
	}
}

/** Runs `octocode plugin ...` and `/plugins install|update|remove`; returns the exit code. */
export async function runPluginCommand(args: string[], io: MarketplaceCommandIo): Promise<number> {
	const out = io.out ?? ((text: string) => console.log(text));
	const err = io.err ?? ((text: string) => console.error(text));
	const [sub = "list", ...words] = args;
	if (sub === "help" || sub === "--help" || sub === "-h") return (out(PLUGIN_USAGE), 0);
	const { rest, yes, unknown } = parse(words);
	if (unknown) return (err(`Unknown option ${unknown}.\n${PLUGIN_USAGE}`), 1);
	const consent: ConsentIo = { yes, confirm: "confirm" in io ? io.confirm : terminalConfirm() };
	try {
		const host = hostFor(io);
		if (sub === "install") {
			if (rest.length !== 1) return (err(PLUGIN_USAGE), 1);
			const result = await installPlugin(host, rest[0], consent);
			out(`Installed ${result.id} (${short(result.sha)}) and enabled it.`);
			if (result.ignored.length)
				out(`Ignored inline marketplace entry fields: ${result.ignored.join(", ")}; the plugin's own files are used.`);
			if (result.declarations.errors.length)
				out(`Notes:\n${result.declarations.errors.map((line) => `  ${line}`).join("\n")}`);
		} else if (sub === "update") {
			if (rest.length > 1) return (err(PLUGIN_USAGE), 1);
			const results = await updatePlugins(host, rest[0], consent);
			if (results.length === 0) out("No plugins installed from a marketplace.");
			let failed = false;
			for (const result of results) {
				if (result.status === "failed") {
					failed = true;
					err(result.message);
				} else out(result.message);
			}
			return failed ? 1 : 0;
		} else if (sub === "remove") {
			if (rest.length !== 1) return (err(PLUGIN_USAGE), 1);
			await removePlugin(host, rest[0]);
			out(`Removed ${rest[0]}: its cached copy and data folder are deleted.`);
		} else if (sub === "list") {
			const rows = listInstalled(host);
			if (rows.length === 0)
				out(`No marketplace plugins. Install one with: ${APP_NAME} plugin install <plugin@marketplace>`);
			for (const row of rows) out(`${row.id}  ${short(row.sha)}  ${row.enabled ? "enabled" : "disabled"}`);
		} else return (err(`Unknown command ${sub}.\n${PLUGIN_USAGE}`), 1);
		return 0;
	} catch (error) {
		if (!(error instanceof MarketplaceError)) throw error;
		err(error.message);
		return 1;
	}
}

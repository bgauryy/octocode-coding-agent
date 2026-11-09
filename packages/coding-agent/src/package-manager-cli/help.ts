import chalk from "chalk";
import { join } from "node:path";
import { APP_NAME, APP_TITLE, CONFIG_DIR_NAME, getAgentDir } from "../config.ts";
import { tildePath } from "../octocode/shared/home.ts";

export type PackageCommand = "install" | "remove" | "update" | "list";

export function getPackageCommandUsage(command: PackageCommand): string {
	switch (command) {
		case "install":
			return `${APP_NAME} install <source> [-l] [--trust]`;
		case "remove":
			return `${APP_NAME} remove <source> [-l] [--trust]`;
		case "update":
			return `${APP_NAME} update [source|self] [--self|--extensions|--models|--all] [--extension <source>] [--trust] [--force]`;
		case "list":
			return `${APP_NAME} list [--trust]`;
	}
}

const CONFIG_COMMAND_USAGE = `${APP_NAME} configuration [verb] [args] [-l] [--trust] [--json]`;

export function printConfigCommandHelp(): void {
	console.log(`${chalk.bold("Usage:")}
  ${CONFIG_COMMAND_USAGE}

Enable, disable, set and add configuration: tools, MCP servers, harnesses, skills, prompts, themes, providers,
sources and settings keys. The same verbs run as /configuration in a session.

Verbs:
  list [kind|text]         Entries with their state, the scope that set them and when a change applies
  get <id>                 One entry's value in each scope
  enable <id>...           Turn on (tool:backlog, mcp:octocode, harness:claude, skill:name, provider:id, ...)
  disable <id>...          Turn off
  set <key> <value>        Set a settings key (bash.spillMaxBytes 65536)
  unset <key>              Remove a settings key from the scope
  add mcp <name> ...       Add an MCP server, with the arguments of "${APP_NAME} mcp add"
  remove <id>              Remove an added entry (mcp:<name>)

Without a verb, a terminal opens the selector (Space/Enter changes a value, Tab switches global and project,
type to search); otherwise the list is printed. A refused change prints its reason and exits non-zero.
Global changes are saved in ${tildePath(join(getAgentDir(), "settings.json"))} (MCP servers in mcp.json).

Options:
  -l, --local       Change this project (${CONFIG_DIR_NAME}/settings.json); needs a trusted folder
  --trust           Record your trust for this folder first, so -l can use project-local files
  --json            Print entries or results as JSON

For one run only, use --enable, --disable and --set on ${APP_NAME} itself.
`);
}

export function printPackageCommandHelp(command: PackageCommand): void {
	switch (command) {
		case "install":
			console.log(`${chalk.bold("Usage:")}
  ${getPackageCommandUsage("install")}

Install a package and add it to settings.

Options:
  -l, --local       Install project-locally (${CONFIG_DIR_NAME}/settings.json)
  --trust           Record your trust for this folder first

Examples:
  ${APP_NAME} install npm:@foo/bar
  ${APP_NAME} install git:github.com/user/repo
  ${APP_NAME} install git:git@github.com:user/repo
  ${APP_NAME} install https://github.com/user/repo
  ${APP_NAME} install ssh://git@github.com/user/repo
  ${APP_NAME} install ./local/path
`);
			return;

		case "remove":
			console.log(`${chalk.bold("Usage:")}
  ${getPackageCommandUsage("remove")}

Remove a package and its source from settings.

Options:
  -l, --local       Remove from project settings (${CONFIG_DIR_NAME}/settings.json)
  --trust           Record your trust for this folder first

Examples:
  ${APP_NAME} remove npm:@foo/bar
`);
			return;

		case "update":
			console.log(`${chalk.bold("Usage:")}
  ${getPackageCommandUsage("update")}

Update ${APP_TITLE}, installed packages, or model catalogs.

Options:
  --self                  Update ${APP_TITLE} only (default when no target is given)
  --extensions            Update installed packages only
  --models                Refresh model catalogs only
  --all                   Update ${APP_TITLE} and installed packages
  --extension <source>    Update one package only
  --trust                 Record your trust for this folder first
  --force                 Reinstall ${APP_TITLE} even if the current version is latest

Short forms:
  ${APP_NAME} update                Update ${APP_TITLE} only
  ${APP_NAME} update --all          Update ${APP_TITLE} and all extensions
  ${APP_NAME} update --models       Refresh model catalogs only
  ${APP_NAME} update <source>       Update one package
  ${APP_NAME} update self           Update ${APP_TITLE} only
`);
			return;

		case "list":
			console.log(`${chalk.bold("Usage:")}
  ${getPackageCommandUsage("list")}

List installed packages from user and project settings.

Options:
  --trust            Record your trust for this folder first
`);
			break;
	}
}

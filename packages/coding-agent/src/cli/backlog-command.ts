import fs from "node:fs";
import path from "node:path";
import { ITEM_TYPES, type ItemType } from "@octocodeai/octocode-contracts/backlogs";
import { LIST_STATES, type ListState } from "@octocodeai/octocode-contracts/snapshot";
import { atomicWriteFileSync } from "@octocodeai/octocode-common/atomic-file";
import { backlog as queries } from "../../../db/src/api.ts";
import { APP_NAME } from "../config.ts";
import { sharedAgentDb } from "../storage/database.ts";
import { agentDbPath } from "../storage/state-paths.ts";
import { registeredWorkspace } from "../storage/workspace-database.ts";
import type { Backlog } from "../octocode/backlog/context.ts";
import { exportMarkdown } from "../octocode/backlog/format.ts";
import { sessionWorkspace } from "../octocode/shared/home/workspace.ts";
import { getResult } from "../octocode/backlog/tool-get.ts";
import { runList } from "../octocode/backlog/tool-list.ts";
import { BacklogError, BacklogStore } from "../octocode/backlog/store.ts";

const BACKLOG_COMMAND_USAGE = `Usage:
  ${APP_NAME} backlog get <id> [--limit <notes>] [--offset <notes>] [--changes]
  ${APP_NAME} backlog list [--query <text>] [--states <state,...>] [--ids <id,...>] [--type <type>] [--under <epic>]
                           [--tag <tag>] [--sort board|updated|created] [--limit <n>] [--offset <n>]
  ${APP_NAME} backlog export <file>

Reads this folder's backlog board without changing it, for scripts and for subagents that have no backlog tool.
get prints one item with its steps, runs and newest notes; list prints one page of items (default: the open ones);
export writes the whole board with every note as Markdown. Reads Octocode's agent database (OCTOCODE_AGENT_DB names
another file).`;

export interface BacklogCommandIo {
	cwd: string;
	/** Environment that names the agent database; tests name an isolated one. */
	env?: NodeJS.ProcessEnv;
	out?: (text: string) => void;
	err?: (text: string) => void;
}

class UsageError extends Error {}

interface Options {
	flags: Map<string, string>;
	changes: boolean;
	operands: string[];
}

const VALUE_FLAGS = new Set([
	"--limit",
	"--offset",
	"--query",
	"--states",
	"--ids",
	"--type",
	"--under",
	"--tag",
	"--sort",
]);

function parse(args: string[]): Options {
	const options: Options = { flags: new Map(), changes: false, operands: [] };
	for (let index = 0; index < args.length; index += 1) {
		const word = args[index] ?? "";
		if (word === "--changes") options.changes = true;
		else if (VALUE_FLAGS.has(word)) {
			const value = args[++index];
			if (value === undefined || value.startsWith("--")) throw new UsageError(`${word} needs a value.`);
			options.flags.set(word, value);
		} else if (word.startsWith("-")) throw new UsageError(`Unknown option ${word}.`);
		else options.operands.push(word);
	}
	return options;
}

function count(options: Options, flag: string): number | undefined {
	const text = options.flags.get(flag);
	if (text === undefined) return undefined;
	if (!/^\d+$/.test(text)) throw new UsageError(`${flag} takes a number.`);
	return Number(text);
}

function oneOf<T extends string>(options: Options, flag: string, allowed: readonly T[]): T | undefined {
	const text = options.flags.get(flag);
	if (text === undefined) return undefined;
	const found = allowed.find((word) => word === text);
	if (found === undefined) throw new UsageError(`${flag} is one of ${allowed.join(", ")}.`);
	return found;
}

const words = (text: string | undefined): string[] | undefined =>
	text === undefined ? undefined : text.split(/[\s,]+/).filter(Boolean);

/** The tool's own paging hint names a tool call; here the same page is the next `--offset`. */
const forCommand = (text: string): string =>
	text.replace(/^Next: backlog(?:Plan)? (\{.*\})$/gm, (line, json: string) => {
		const offset = (JSON.parse(json) as { offset?: number }).offset;
		return offset === undefined ? line : `Next: repeat the command with --offset ${offset}`;
	});

function openBoard(io: BacklogCommandIo, env: NodeJS.ProcessEnv): Backlog {
	const agent = sharedAgentDb(env);
	const workspace = registeredWorkspace(sessionWorkspace(io.cwd, env), agent);
	return {
		store: new BacklogStore(() => agent, workspace.id),
		actor: { id: "cli", surface: "command" },
		session: "cli",
		repoName: workspace.name,
		repoRoot: workspace.root,
	};
}

function run(sub: string, options: Options, board: Backlog, io: BacklogCommandIo): string {
	if (sub === "get") {
		const [id] = options.operands;
		if (id === undefined || options.operands.length > 1) throw new UsageError("get takes one item id.");
		const limit = count(options, "--limit");
		const offset = count(options, "--offset");
		return forCommand(
			getResult(board, {
				id,
				changes: options.changes,
				...(limit === undefined ? {} : { limit }),
				...(offset === undefined ? {} : { offset }),
			}).content[0]?.text ?? "",
		);
	}
	if (sub === "list") {
		if (options.operands.length > 0) throw new UsageError(`list takes options, not ${options.operands[0]}.`);
		const states = words(options.flags.get("--states"));
		const unknown = states?.find((state) => !(LIST_STATES as readonly string[]).includes(state));
		if (unknown !== undefined) throw new UsageError(`--states takes ${LIST_STATES.join(", ")}, not ${unknown}.`);
		const type: ItemType | undefined = oneOf(options, "--type", ITEM_TYPES);
		const sort = oneOf(options, "--sort", queries.ITEM_SORTS);
		const query = options.flags.get("--query");
		const under = options.flags.get("--under");
		const tag = options.flags.get("--tag");
		const ids = words(options.flags.get("--ids"));
		const limit = count(options, "--limit");
		const offset = count(options, "--offset");
		const text = runList(board, {
			...(states ? { states: states as ListState[] } : {}),
			...(query === undefined ? {} : { query }),
			...(ids ? { ids } : {}),
			...(type ? { type } : {}),
			...(under === undefined ? {} : { parentId: under }),
			...(tag === undefined ? {} : { tags: [tag] }),
			...(sort ? { sort } : {}),
			...(limit === undefined ? {} : { limit }),
			...(offset === undefined ? {} : { offset }),
		}).content[0]?.text;
		return forCommand(text ?? "");
	}
	if (options.operands.length !== 1) throw new UsageError("export takes one file path.");
	const file = path.resolve(io.cwd, options.operands[0] ?? "");
	fs.mkdirSync(path.dirname(file), { recursive: true });
	atomicWriteFileSync(file, exportMarkdown(board.store, board.repoName, Date.now()));
	return `Wrote the board to ${file}.`;
}

/** Runs `octocode backlog ...` and returns the process exit code: 0 done, 1 refused or failed. */
export async function runBacklogCommand(args: string[], io: BacklogCommandIo): Promise<number> {
	const out = io.out ?? ((text: string) => console.log(text));
	const err = io.err ?? ((text: string) => console.error(text));
	const [sub, ...rest] = args;
	if (sub === undefined || sub === "help" || sub === "--help" || sub === "-h") {
		out(BACKLOG_COMMAND_USAGE);
		return 0;
	}
	const env = io.env ?? process.env;
	try {
		if (sub !== "get" && sub !== "list" && sub !== "export") throw new UsageError(`Unknown backlog command ${sub}.`);
		const options = parse(rest);
		// Reading must not create the database: a machine that never ran a session has no board.
		if (!fs.existsSync(agentDbPath(env))) {
			err(`No backlog board for ${io.cwd}.`);
			return 1;
		}
		out(run(sub, options, openBoard(io, env), io));
		return 0;
	} catch (error) {
		if (error instanceof UsageError) err(`${error.message}\n${BACKLOG_COMMAND_USAGE}`);
		else if (error instanceof BacklogError || (error instanceof Error && error.message.startsWith("No backlog item ")))
			err(error.message);
		else throw error;
		return 1;
	}
}

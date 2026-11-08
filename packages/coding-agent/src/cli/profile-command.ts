import fs from "node:fs";
import path from "node:path";
import type { ProfileEvent, ProfileRequest, ProfileTimeline } from "@octocodeai/octocode-contracts/profiler";
import { atomicWriteFileSync } from "../../../common/src/atomic-file.ts";
import { APP_NAME } from "../config.ts";
import { sharedAgentDb } from "../config/database.ts";
import { agentDbPath } from "../config/state-paths.ts";
import { createProfiler } from "../octocode/profiler/index.ts";
import { agentsTable, insightsTable, requestsTable, timelineTable } from "../octocode/profiler/format.ts";
import { findSession, ProfileSessionError, storedProfilerSource } from "../octocode/profiler/stored-source.ts";

const PROFILE_COMMAND_USAGE = `Usage:
  ${APP_NAME} profile [--session <id>] [--json]
  ${APP_NAME} profile [--session <id>] --insights [--json]
  ${APP_NAME} profile [--session <id>] --agent <id> [--request <n>] [--detail] [--json]
  ${APP_NAME} profile [--session <id>] --timeline [--json]
  ${APP_NAME} profile [--session <id>] --trace <file>

Shows where a session's model requests, prompt cache, tools and waits went: every agent with its model, requests, cache
hit rate, written tokens and cost; --insights lists the findings (cache rewrites, idle expiry, slow or failing tools,
waits) most costly first; --agent lists one agent's requests and --request <n> or --detail shows their prompt layers;
--timeline lists what each agent did and when; --trace writes Chrome Trace JSON that Perfetto and chrome://tracing open.
--json prints the same data as the /web profiler serves. The session defaults to the latest of the current folder.
Reads Octocode's agent database (OCTOCODE_AGENT_DB names another file) and the session files; writes only --trace.`;

export interface ProfileCommandIo {
	cwd: string;
	/** Environment that names the agent database; tests name an isolated one. */
	env?: NodeJS.ProcessEnv;
	out?: (text: string) => void;
	err?: (text: string) => void;
}

interface Options {
	session?: string;
	json: boolean;
	insights: boolean;
	timeline: boolean;
	detail: boolean;
	agent?: string;
	request?: number;
	trace?: string;
}

class UsageError extends Error {}

function parse(args: string[]): Options {
	const options: Options = { json: false, insights: false, timeline: false, detail: false };
	for (let index = 0; index < args.length; index += 1) {
		const word = args[index] ?? "";
		const value = (): string => {
			const next = args[++index];
			if (next === undefined || next.startsWith("--")) throw new UsageError(`${word} needs a value.`);
			return next;
		};
		if (word === "--json") options.json = true;
		else if (word === "--insights") options.insights = true;
		else if (word === "--timeline") options.timeline = true;
		else if (word === "--detail") options.detail = true;
		else if (word === "--session") options.session = value();
		else if (word === "--agent") options.agent = value();
		else if (word === "--trace") options.trace = value();
		else if (word === "--request") {
			const text = value();
			if (!/^\d+$/.test(text)) throw new UsageError("--request takes a request number (0 is the first).");
			options.request = Number(text);
		} else throw new UsageError(word.startsWith("-") ? `Unknown option ${word}.` : `Unexpected argument ${word}.`);
	}
	if ((options.request !== undefined || options.detail) && options.agent === undefined)
		throw new UsageError("--request and --detail need --agent <id>.");
	if (Number(options.insights) + Number(options.timeline) + Number(options.agent !== undefined) > 1)
		throw new UsageError("Choose one of --insights, --agent and --timeline.");
	return options;
}

/** Every page of `profiler.requests`, from request `from`, up to `limit` requests. */
function allRequests(
	profiler: ReturnType<typeof createProfiler>,
	agentId: string,
	from: number,
	detail: boolean,
	limit = Number.POSITIVE_INFINITY,
): ProfileRequest[] | undefined {
	const found: ProfileRequest[] = [];
	let after = from - 1;
	for (;;) {
		const page = profiler.requests(agentId, after < 0 ? undefined : after, detail);
		if (!page) return undefined;
		found.push(...page.requests);
		const last = page.requests.at(-1);
		if (!page.hasMore || !last || found.length >= limit) return found.slice(0, limit);
		after = last.index;
	}
}

function fullTimeline(profiler: ReturnType<typeof createProfiler>): ProfileTimeline {
	let page = profiler.timeline();
	const events: ProfileEvent[] = [...page.events];
	while (page.hasMore) {
		page = profiler.timeline(page.until);
		events.push(...page.events);
	}
	return { ...page, events, messages: profiler.timeline().messages, hasMore: false };
}

/** Runs `octocode profile ...` and returns the process exit code: 0 done, 1 refused or failed. */
export async function runProfileCommand(args: string[], io: ProfileCommandIo): Promise<number> {
	const out = io.out ?? ((text: string) => console.log(text));
	const err = io.err ?? ((text: string) => console.error(text));
	if (args[0] === "help" || args[0] === "--help" || args[0] === "-h") {
		out(PROFILE_COMMAND_USAGE);
		return 0;
	}
	let options: Options;
	try {
		options = parse(args);
	} catch (error) {
		if (!(error instanceof UsageError)) throw error;
		err(`${error.message}\n${PROFILE_COMMAND_USAGE}`);
		return 1;
	}
	const env = io.env ?? process.env;
	// Reading must not create the database: a folder that never ran a session has nothing to profile.
	if (!fs.existsSync(agentDbPath(env))) {
		err(`No stored session in ${io.cwd}.`);
		return 1;
	}
	let profiler: ReturnType<typeof createProfiler> | undefined;
	try {
		const db = sharedAgentDb(env).db;
		profiler = createProfiler(storedProfilerSource({ db, session: findSession(db, io.cwd, options.session) }));
		const show = <T>(data: T, text: (data: T) => string) =>
			out(options.json ? JSON.stringify(data, null, 2) : text(data));
		if (options.trace) {
			const file = path.resolve(io.cwd, options.trace);
			fs.mkdirSync(path.dirname(file), { recursive: true });
			atomicWriteFileSync(file, JSON.stringify(profiler.trace()));
			if (!options.json) out(`Wrote Chrome Trace JSON to ${file}.`);
		}
		if (options.insights) show(profiler.insights(), insightsTable);
		else if (options.timeline) show(fullTimeline(profiler), timelineTable);
		else if (options.agent !== undefined) {
			const from = options.request ?? 0;
			const found = allRequests(
				profiler,
				options.agent,
				from,
				options.detail || options.request !== undefined,
				options.request === undefined ? undefined : 1,
			);
			if (!found) {
				err(`No agent ${options.agent} in this session.`);
				return 1;
			}
			if (options.request !== undefined && found[0]?.index !== options.request) {
				err(`${options.agent} has no request ${options.request}.`);
				return 1;
			}
			show({ agentId: options.agent, requests: found, hasMore: false }, (data) => requestsTable(data, options.detail));
		} else if (!options.trace) show(profiler.agents(), agentsTable);
		return 0;
	} catch (error) {
		if (!(error instanceof ProfileSessionError)) throw error;
		err(error.message);
		return 1;
	} finally {
		profiler?.close();
	}
}

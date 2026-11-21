import fs from "node:fs";
import type { ProfilerSource } from "./service.ts";
import { storedSilences } from "./silences.ts";
import { catalogFiles, runMember, runTranscript, sessionRuns } from "./runs.ts";
import { toTraffic } from "../team/model.ts";
import type { DepartedAgent, EndpointDirectory } from "../team/endpoint.ts";
import { departedLookup } from "../team/feed-read.ts";
import { type AgentRun, correspondence, sessions, type Db } from "../../../../db/src/api.ts";

/** The coordinator's name when its session never registered with the team database (a session that worked alone). */
const SOLO_ID = "main";

/** A stored session of the workspace, as the catalog lists it. */
export type StoredSession = sessions.CatalogRow;

export class ProfileSessionError extends Error {}

function realpath(folder: string): string {
	try {
		return fs.realpathSync(folder);
	} catch {
		return folder;
	}
}

/**
 * The session to profile: the one `wanted` names (an id or a unique prefix of one, in any workspace), else the most
 * recently active session of `cwd`.
 */
export function findSession(db: Db, cwd: string, wanted?: string): StoredSession {
	if (wanted) {
		const matches = sessions.catalog(db).filter((row) => row.id === wanted || row.id.startsWith(wanted));
		const exact = matches.find((row) => row.id === wanted);
		if (exact) return exact;
		if (matches.length === 1) return matches[0];
		throw new ProfileSessionError(
			matches.length
				? `Session ${wanted} is ambiguous: ${matches.map((row) => row.id).join(", ")}.`
				: `No session ${wanted}.`,
		);
	}
	const rows = [...sessions.catalog(db, cwd), ...(realpath(cwd) === cwd ? [] : sessions.catalog(db, realpath(cwd)))];
	const latest = rows.sort((a, b) => b.last_active - a.last_active)[0];
	if (!latest) throw new ProfileSessionError(`No stored session in ${cwd}. Name one with --session <id>.`);
	return latest;
}

/** The agent database to read and the stored session to rebuild the profiler's source for (`findSession` picks one). */
export interface StoredProfilerOptions {
	db: Db;
	session: StoredSession;
}

/** What a stored run says of its agent: the profile (`main` for the session's own), parent, session and where it worked. */
function runFacts(run: AgentRun, self: boolean): DepartedAgent {
	return {
		role: self ? "main" : (run.profile ?? "general"),
		...(run.parentAgentId && !self ? { parentId: run.parentAgentId } : {}),
		...(run.sessionId ? { sessionId: run.sessionId } : {}),
		...(run.cwd ? { cwd: run.cwd } : {}),
		...(run.branch ? { branch: run.branch } : {}),
	};
}

/**
 * What a running workspace hands the profiler, rebuilt from stored data: the team runs the database kept for the
 * session and its descendants, the messages that involve them, and the transcripts their session rows point at. Reads
 * only.
 */
export function storedProfilerSource({ db, session }: StoredProfilerOptions): ProfilerSource {
	const { all: runs, coordinator, children: latest } = sessionRuns(db, session.id);
	const children = [...latest.values()];
	const files = catalogFiles(db);
	const facts = new Map<string, DepartedAgent>(
		runs.map((run) => [run.agentId, runFacts(run, run.agentId === coordinator?.agentId)]),
	);
	const elsewhere = departedLookup(db);
	const endpoints: EndpointDirectory = {
		members: [],
		departed: (id) => facts.get(id) ?? elsewhere(id),
		root: coordinator?.cwd ?? session.cwd,
	};
	return {
		sessionId: session.id,
		self: () => (coordinator ? runMember(coordinator, true) : { id: SOLO_ID, role: "main", status: "idle" }),
		coordinatorFile: () => session.file,
		members: () => children.map((run) => runMember(run, false)),
		traffic: () => {
			const ids = [coordinator?.agentId, ...children.map((run) => run.agentId)].filter((id) => id !== undefined);
			const since = Math.min(...runs.map((run) => run.startedAt), Number.POSITIVE_INFINITY);
			return Number.isFinite(since)
				? correspondence.involving(db, ids, since).map(({ message, deliveries }) => toTraffic(message, deliveries))
				: [];
		},
		silences: (ids) => storedSilences(db, ids, runs.length > 0 ? Math.min(...runs.map((run) => run.startedAt)) : 0),
		endpoints: () => endpoints,
		transcript: (agentId) => {
			const run = latest.get(agentId);
			return run ? runTranscript(db, run, files) : undefined;
		},
	};
}

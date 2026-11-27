import type { ProfileRequest } from "@octocodeai/octocode-contracts/profiler";
import { sharedAgentDb } from "../../storage/database.ts";
import { currentSessionId } from "../shared/home.ts";
import { createProfiler } from "../profiler/index.ts";
import { agentsTable, insightsTable, requestsTable } from "../profiler/format.ts";
import { findSession, ProfileSessionError, storedSessionSource } from "../profiler/stored-source.ts";

/** What a profile read asks: `source: "profile"` of the archive tool. */
export interface ProfileQuery {
	/** The stored session (an id or unique prefix); omitted or `current`: the current one, else the latest of the folder. */
	sessionId?: string;
	/** One agent's requests instead of the session overview. */
	agentId?: string;
	/** With `agentId`: this request alone, with its prompt layers (0 is the first). */
	request?: number;
	/** The page to show (the archive cursor's). */
	page?: number;
	limit?: number;
}

const DEFAULT_LIMIT = 10;

function pageOf<T>(rows: T[], page: number, limit: number): { rows: T[]; pages: number } {
	const pages = Math.max(1, Math.ceil(rows.length / limit));
	return { rows: rows.slice((page - 1) * limit, page * limit), pages };
}

/** A profile read: its text, the session it read, and its page of how many (`pages` > 1 continues by the archive cursor). */
interface ProfileText {
	text: string;
	session: string;
	page: number;
	pages: number;
}

function allRequests(profiler: ReturnType<typeof createProfiler>, agentId: string, detail: boolean) {
	const found: ProfileRequest[] = [];
	let after: number | undefined;
	for (;;) {
		const chunk = profiler.requests(agentId, after, detail);
		if (!chunk) return undefined;
		found.push(...chunk.requests);
		const last = chunk.requests.at(-1);
		if (!chunk.hasMore || !last) return found;
		after = last.index;
	}
}

/**
 * The cache and agent profile of a stored session as compact text: findings most costly first and every agent, or one
 * agent's requests, or one request's layers with their cache state. Reads stored data only.
 */
export function readProfile(cwd: string, query: ProfileQuery): ProfileText {
	const db = sharedAgentDb().db;
	// `current`, as the tool's sessionId field offers, is this session: the same as leaving it out.
	const given = query.sessionId?.trim() === "current" ? undefined : query.sessionId?.trim();
	const wanted = given || currentSessionId();
	let session;
	try {
		session = findSession(db, cwd, wanted);
	} catch (error) {
		if (!(error instanceof ProfileSessionError) || given) throw error;
		session = findSession(db, cwd);
	}
	const profiler = createProfiler(storedSessionSource(session));
	try {
		const page = Math.max(1, Math.floor(query.page ?? 1));
		const limit = Math.min(50, Math.max(1, Math.floor(query.limit ?? DEFAULT_LIMIT)));
		if (query.agentId === undefined) {
			const agents = profiler.agents();
			const insights = profiler.insights();
			const shownAgents = pageOf(agents.agents, page, limit);
			const shownFindings = pageOf(insights.findings, page, limit);
			const text = [
				agentsTable({ ...agents, agents: shownAgents.rows }),
				insightsTable({ ...insights, findings: shownFindings.rows }),
				"Read an agent's requests with agentId, one request's layers with agentId and request.",
			];
			const pages = Math.max(shownAgents.pages, shownFindings.pages);
			return { text: text.filter(Boolean).join("\n\n"), session: session.id, page, pages };
		}
		const requests =
			query.request === undefined
				? allRequests(profiler, query.agentId, false)
				: profiler.requests(query.agentId, query.request - 1, true)?.requests;
		if (!requests) throw new Error(`No agent ${query.agentId} in session ${session.id}; list agents without agentId.`);
		if (query.request !== undefined) {
			const one = requests.find((request) => request.index === query.request);
			if (!one) throw new Error(`${query.agentId} has no request ${query.request}.`);
			return {
				text: requestsTable({ agentId: query.agentId, requests: [one], hasMore: false }, true),
				session: session.id,
				page: 1,
				pages: 1,
			};
		}
		const shown = pageOf(requests, page, limit);
		return {
			text: requestsTable({ agentId: query.agentId, requests: shown.rows, hasMore: false }, false),
			session: session.id,
			page,
			pages: shown.pages,
		};
	} finally {
		profiler.close();
	}
}

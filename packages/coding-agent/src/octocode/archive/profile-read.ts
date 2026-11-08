import type { ProfileRequest } from "@octocodeai/octocode-contracts/profiler";
import { sharedAgentDb } from "../../config/database.ts";
import { currentSessionId } from "../shared/home.ts";
import { createProfiler } from "../profiler/index.ts";
import { agentsTable, insightsTable, requestsTable } from "../profiler/format.ts";
import { findSession, ProfileSessionError, storedProfilerSource } from "../profiler/stored-source.ts";

/** What a profile read asks: `source: "profile"` of the archive tool. */
export interface ProfileQuery {
	/** The stored session (an id or unique prefix); omitted: the current one, else the latest of the folder. */
	sessionId?: string;
	/** One agent's requests instead of the session overview. */
	agentId?: string;
	/** With `agentId`: this request alone, with its prompt layers (0 is the first). */
	line?: number;
	page?: number;
	limit?: number;
}

const DEFAULT_LIMIT = 10;

function pageOf<T>(rows: T[], page: number, limit: number): { rows: T[]; note: string } {
	const pages = Math.max(1, Math.ceil(rows.length / limit));
	const shown = rows.slice((page - 1) * limit, page * limit);
	return { rows: shown, note: pages > 1 ? `Page ${page} of ${pages}; continue with page.` : "" };
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
export function readProfile(cwd: string, query: ProfileQuery): { text: string; session: string } {
	const db = sharedAgentDb().db;
	const wanted = query.sessionId?.trim() || currentSessionId();
	let session;
	try {
		session = findSession(db, cwd, wanted);
	} catch (error) {
		if (!(error instanceof ProfileSessionError) || query.sessionId?.trim()) throw error;
		session = findSession(db, cwd);
	}
	const profiler = createProfiler(storedProfilerSource({ db, session }));
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
				"Read an agent's requests with agentId, one request's layers with agentId and line.",
				shownAgents.note || shownFindings.note,
			];
			return { text: text.filter(Boolean).join("\n\n"), session: session.id };
		}
		const requests = allRequests(profiler, query.agentId, query.line !== undefined);
		if (!requests) throw new Error(`No agent ${query.agentId} in session ${session.id}; list agents without agentId.`);
		if (query.line !== undefined) {
			const one = requests.find((request) => request.index === query.line);
			if (!one) throw new Error(`${query.agentId} has no request ${query.line} (it has ${requests.length}).`);
			return {
				text: requestsTable({ agentId: query.agentId, requests: [one], hasMore: false }, true),
				session: session.id,
			};
		}
		const shown = pageOf(requests, page, limit);
		return {
			text: [requestsTable({ agentId: query.agentId, requests: shown.rows, hasMore: false }, false), shown.note]
				.filter(Boolean)
				.join("\n\n"),
			session: session.id,
		};
	} finally {
		profiler.close();
	}
}

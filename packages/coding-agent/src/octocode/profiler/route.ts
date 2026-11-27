import type { IncomingMessage } from "node:http";
import {
	PROFILER_PATHS,
	type ProfileAgents,
	type ProfileInsights,
	type ProfileMessages,
	type ProfileRequests,
	type ProfileTimeline,
	type ProfileTranscript,
} from "@octocodeai/octocode-contracts/profiler";
import type { ChromeTrace } from "./trace.ts";
import type { FeedCursor } from "@octocodeai/octocode-contracts/team";
import { WORKSPACE_ROUTES } from "@octocodeai/octocode-contracts/protocol";
import { redactData } from "@octocodeai/octocode-common/sanitize";

/** The profiler as a route sees it: in this process, or reached through the attach protocol (then answers are promises). */
export interface ProfilerRoutePort {
	agents(): ProfileAgents | Promise<ProfileAgents>;
	requests(
		agentId: string,
		after?: number,
		detail?: boolean,
	): ProfileRequests | undefined | Promise<ProfileRequests | undefined>;
	timeline(since?: number): ProfileTimeline | Promise<ProfileTimeline>;
	insights(): ProfileInsights | Promise<ProfileInsights>;
	trace(): ChromeTrace | Promise<ChromeTrace>;
	messages(limit: number, before?: FeedCursor): ProfileMessages | Promise<ProfileMessages>;
	transcript(
		agentId: string,
		entry: number,
		sessionId?: string,
	): ProfileTranscript | undefined | Promise<ProfileTranscript | undefined>;
}

type Reply = (status: number, body: unknown, headers?: Record<string, string>) => void;

/** Messages `GET <profiler>/messages` returns without a `limit`, and the most it returns. */
const MESSAGES_PAGE = 100;
const MAX_MESSAGES = 500;

/** A message cursor key (`team/feed.ts` `messageKey`) and a session id. */
const MESSAGE_KEY = /^m:[0-9]{12}$/;
const SESSION_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const AGENT_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

/**
 * `GET <profiler>` (the session's agents) and `GET <profiler>/<agentId>?after=<index>&detail=1` (that agent's requests).
 * Read-only; the caller has checked the Host, Origin and token. Returns true when the request was answered, false when
 * the path is not a profiler route. Answers hold labels, token counts and tool and notice names; only `messages` and `transcript` carry message and transcript text, redacted.
 */
export async function handleProfilerRequest(
	req: IncomingMessage,
	url: URL,
	port: ProfilerRoutePort | undefined,
	reply: Reply,
): Promise<boolean> {
	const route = WORKSPACE_ROUTES.profiler;
	if (url.pathname !== route && !url.pathname.startsWith(`${route}/`)) return false;
	if (req.method !== "GET") {
		reply(405, { error: "The profiler is read-only." });
		return true;
	}
	if (!port) {
		reply(503, { error: "The profiler is unavailable in this session." });
		return true;
	}
	const rest = url.pathname.slice(route.length);
	const number = (name: string): number | undefined | null => {
		const value = url.searchParams.get(name);
		if (value === null) return undefined;
		return /^(0|[1-9][0-9]{0,15})$/.test(value) ? Number(value) : null;
	};
	if (rest === "" || rest === PROFILER_PATHS.agents) {
		reply(200, redactData(await port.agents()));
		return true;
	}
	if (rest === PROFILER_PATHS.timeline) {
		const since = number("since");
		if (since === null) reply(400, { error: "Invalid since" });
		else reply(200, redactData(await port.timeline(since)));
		return true;
	}
	if (rest === PROFILER_PATHS.messages) {
		const asked = number("limit");
		const limit = asked === undefined ? MESSAGES_PAGE : asked;
		const at = number("beforeAt");
		const key = url.searchParams.get("beforeKey");
		const cursor =
			at === undefined && key === null ? undefined : at != null && key && MESSAGE_KEY.test(key) ? { at, key } : null;
		if (limit === null || limit < 1 || limit > MAX_MESSAGES || cursor === null)
			reply(400, { error: "Invalid limit or cursor" });
		else reply(200, redactData(await port.messages(limit, cursor)));
		return true;
	}
	if (rest === PROFILER_PATHS.transcript) {
		const agent = url.searchParams.get("agent") ?? "";
		const entry = number("entry");
		const session = url.searchParams.get("session") ?? undefined;
		if (
			!AGENT_ID.test(agent) ||
			entry === undefined ||
			entry === null ||
			(session !== undefined && !SESSION_ID.test(session))
		) {
			reply(400, { error: "Invalid agent, entry or session" });
			return true;
		}
		const found = await port.transcript(agent, entry, session);
		if (!found)
			reply(404, { error: "That agent is not part of this session, or its transcript for that session is missing." });
		else reply(200, redactData(found));
		return true;
	}
	if (rest === PROFILER_PATHS.insights) {
		reply(200, redactData(await port.insights()));
		return true;
	}
	if (rest === PROFILER_PATHS.trace) {
		reply(200, redactData(await port.trace()), {
			"content-disposition": 'attachment; filename="octocode-profile.trace.json"',
		});
		return true;
	}
	if (!rest.startsWith(`${PROFILER_PATHS.agents}/`)) {
		reply(404, { error: "Not found" });
		return true;
	}
	let agentId: string;
	try {
		agentId = decodeURIComponent(rest.slice(PROFILER_PATHS.agents.length + 1));
	} catch {
		agentId = "";
	}
	const after = number("after");
	if (!AGENT_ID.test(agentId) || after === null) {
		reply(400, { error: "Invalid agent or cursor" });
		return true;
	}
	const found = await port.requests(agentId, after, url.searchParams.get("detail") === "1");
	if (!found) reply(404, { error: "That agent is not part of this session." });
	else reply(200, redactData(found));
	return true;
}

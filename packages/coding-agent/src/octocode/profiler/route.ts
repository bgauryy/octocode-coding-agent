import type { IncomingMessage } from "node:http";
import {
	PROFILER_PATHS,
	type ProfileAgents,
	type ProfileInsights,
	type ProfileRequests,
	type ProfileTimeline,
} from "@octocodeai/octocode-contracts/profiler";
import type { ChromeTrace } from "./trace.ts";
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
}

type Reply = (status: number, body: unknown, headers?: Record<string, string>) => void;

const AGENT_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

/**
 * `GET <profiler>` (the session's agents) and `GET <profiler>/<agentId>?after=<index>&detail=1` (that agent's requests).
 * Read-only; the caller has checked the Host, Origin and token. Returns true when the request was answered, false when
 * the path is not a profiler route. Answers hold labels, token counts and tool and notice names, never message text.
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

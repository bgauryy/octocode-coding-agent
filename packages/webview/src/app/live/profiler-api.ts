import {
	PROFILER_PATHS,
	type ProfileAgents,
	type ProfileInsights,
	type ProfileRequests,
	type ProfileTimeline,
	type ProfileUpdate,
	WORKSPACE_ROUTES,
} from "@octocodeai/octocode-contracts";
import { isRecord } from "@octocodeai/octocode-contracts/guards";
import { bearer } from "../../access.ts";
import {
	isProfileAgent,
	isProfileEvent,
	isProfileFinding,
	isProfileMessage,
	isProfileRequest,
} from "../../profiler-guards.ts";
import { requestJson } from "../../request.ts";
import { scopedRoute } from "../../scope.ts";

/** The profiler's route and a path under it, scoped like every other host route. */
function profilerRoute(path: string = ""): string {
	return `${scopedRoute(WORKSPACE_ROUTES.profiler)}${path}`;
}

/** The cache profiler's authenticated reads; the host derives every number, the page only draws them. */
export function createProfilerApi(access: string) {
	const headers = bearer(access);
	const read = (path: string, signal: AbortSignal | undefined, failure: string) =>
		requestJson(profilerRoute(path), { headers, signal }, failure);
	return {
		profilerAgents: async (signal?: AbortSignal): Promise<ProfileAgents> => {
			const value = await read(PROFILER_PATHS.agents, signal, "Could not load the profiler");
			if (
				!isRecord(value) ||
				typeof value.sessionId !== "string" ||
				!Array.isArray(value.agents) ||
				!value.agents.every(isProfileAgent)
			)
				throw new Error("Invalid profiler response");
			return value as unknown as ProfileAgents;
		},
		/** One page of an agent's requests after `after` (all from the start when absent). */
		profilerRequests: async (agentId: string, after?: number, signal?: AbortSignal): Promise<ProfileRequests> => {
			const query = after === undefined ? "" : `?${new URLSearchParams({ after: String(after) })}`;
			const value = await read(
				`${PROFILER_PATHS.agents}/${encodeURIComponent(agentId)}${query}`,
				signal,
				"Could not load the agent's requests",
			);
			if (
				!isRecord(value) ||
				value.agentId !== agentId ||
				typeof value.hasMore !== "boolean" ||
				!Array.isArray(value.requests) ||
				!value.requests.every((request) => isProfileRequest(request) && request.agentId === agentId)
			)
				throw new Error("Invalid profiler requests response");
			return value as unknown as ProfileRequests;
		},
		/** Events and messages since `since` (all when absent); ask again with the returned `until` while `hasMore`. */
		profilerTimeline: async (since?: number, signal?: AbortSignal): Promise<ProfileTimeline> => {
			const query = since === undefined ? "" : `?${new URLSearchParams({ since: String(since) })}`;
			const value = await read(`${PROFILER_PATHS.timeline}${query}`, signal, "Could not load the timeline");
			if (
				!isRecord(value) ||
				typeof value.until !== "number" ||
				typeof value.hasMore !== "boolean" ||
				!Array.isArray(value.events) ||
				!value.events.every(isProfileEvent) ||
				!Array.isArray(value.messages) ||
				!value.messages.every(isProfileMessage)
			)
				throw new Error("Invalid timeline response");
			return value as unknown as ProfileTimeline;
		},
		/** The trace export as a file: the host refuses it without the token, so a plain link cannot fetch it. */
		profilerTrace: async (signal?: AbortSignal): Promise<Blob> => {
			const response = await fetch(profilerRoute(PROFILER_PATHS.trace), { headers, signal });
			if (!response.ok) throw new Error(`Could not export the trace (HTTP ${response.status})`);
			return response.blob();
		},
		profilerInsights: async (signal?: AbortSignal): Promise<ProfileInsights> => {
			const value = await read(PROFILER_PATHS.insights, signal, "Could not load the insights");
			if (!isRecord(value) || !Array.isArray(value.findings) || !value.findings.every(isProfileFinding))
				throw new Error("Invalid insights response");
			return value as unknown as ProfileInsights;
		},
	};
}

/** Live frames fan out to the profiler view while it is mounted; a frame that arrives before it mounts is not kept. */
export class ProfilerFeed {
	private readonly listeners = new Set<(update: ProfileUpdate) => void>();
	subscribe(listener: (update: ProfileUpdate) => void): () => void {
		this.listeners.add(listener);
		return () => this.listeners.delete(listener);
	}
	emit(update: ProfileUpdate): void {
		for (const listener of this.listeners) listener(update);
	}
}

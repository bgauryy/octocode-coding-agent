import type { ConfigSnapshot } from "@octocodeai/octocode-contracts/config";
import { DAEMON_ROUTES } from "@octocodeai/octocode-contracts/protocol";
import type { DaemonRepo, DaemonSessions } from "@octocodeai/octocode-contracts/daemon";
import { bearer } from "../../access.ts";
import { requestJson } from "../../request.ts";
import { isRecord } from "@octocodeai/octocode-contracts/guards";


/** Authenticated reads of the user-level daemon; every answer is shape-checked before the page uses it. */
export function createDaemonApi(access: string) {
	const headers = bearer(access);
	return {
		sessions: async (signal?: AbortSignal): Promise<DaemonSessions> => {
			const value = await requestJson(DAEMON_ROUTES.sessions, { headers, signal }, "Could not load sessions");
			if (!isRecord(value) || !Array.isArray(value.sessions)) throw new Error("Invalid sessions response");
			return value as unknown as DaemonSessions;
		},
		repos: async (signal?: AbortSignal): Promise<{ repos: DaemonRepo[]; truncated?: boolean }> => {
			const value = await requestJson(DAEMON_ROUTES.repos, { headers, signal }, "Could not load repositories");
			if (!isRecord(value) || !Array.isArray(value.repos)) throw new Error("Invalid repositories response");
			return value as unknown as { repos: DaemonRepo[]; truncated?: boolean };
		},
		config: (): Promise<ConfigSnapshot> =>
			requestJson<ConfigSnapshot>(DAEMON_ROUTES.config, { headers }, "Could not load settings"),
	};
}

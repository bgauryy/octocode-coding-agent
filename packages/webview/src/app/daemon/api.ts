import type {
	ConfigCredentialCommand,
	ConfigProviderCommand,
	ConfigSettingCommand,
	ConfigSnapshot,
	SignInCommand,
	SignInState,
} from "@octocodeai/octocode-contracts/config";
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
		/** Whether this token may change the board. The page only hides controls by it; the daemon still refuses a write. */
		access: async (signal?: AbortSignal): Promise<boolean> => {
			const value = await requestJson(DAEMON_ROUTES.access, { headers, signal }, "Could not read the link's access");
			return isRecord(value) && value.writable === true;
		},
		config: (repoId?: string): Promise<ConfigSnapshot> =>
			requestJson<ConfigSnapshot>(
				repoId ? `${DAEMON_ROUTES.config}?repoId=${encodeURIComponent(repoId)}` : DAEMON_ROUTES.config,
				{ headers },
				"Could not load settings",
			),
		/** Sets, replaces or clears one provider key. The key travels only in this request body; the answer is the fresh snapshot, which never holds it. */
		saveCredential: (command: ConfigCredentialCommand, repoId?: string): Promise<ConfigSnapshot> =>
			requestJson<ConfigSnapshot>(
				repoId
					? `${DAEMON_ROUTES.configCredentials}?repoId=${encodeURIComponent(repoId)}`
					: DAEMON_ROUTES.configCredentials,
				{ method: "POST", headers: { ...headers, "content-type": "application/json" }, body: JSON.stringify(command) },
				"Could not save the credential",
			),
		/** Turns a provider or the Pi source on or off; the host writes the setting and answers with the fresh snapshot. */
		saveProvider: (command: ConfigProviderCommand, repoId?: string): Promise<ConfigSnapshot> =>
			requestJson<ConfigSnapshot>(
				repoId
					? `${DAEMON_ROUTES.configProviders}?repoId=${encodeURIComponent(repoId)}`
					: DAEMON_ROUTES.configProviders,
				{ method: "POST", headers: { ...headers, "content-type": "application/json" }, body: JSON.stringify(command) },
				"Could not change the provider",
			),
		/** Starts, polls, answers or cancels a sign-in the host runs. An answer may carry a pasted code; the reply is the sign-in's state. */
		signIn: (command: SignInCommand): Promise<SignInState> =>
			requestJson(
				DAEMON_ROUTES.configSignin,
				{ method: "POST", headers: { ...headers, "content-type": "application/json" }, body: JSON.stringify(command) },
				"Could not reach the sign-in",
			).then((value) => {
				if (!isRecord(value) || typeof value.status !== "string" || !Array.isArray(value.events))
					throw new Error("Invalid sign-in response");
				return value as unknown as SignInState;
			}),
		/** Changes one setting; the host answers with the fresh snapshot or refuses with its reason. */
		saveSetting: (command: ConfigSettingCommand): Promise<ConfigSnapshot> =>
			requestJson<ConfigSnapshot>(
				DAEMON_ROUTES.configSettings,
				{ method: "POST", headers: { ...headers, "content-type": "application/json" }, body: JSON.stringify(command) },
				"Could not save the setting",
			),
	};
}

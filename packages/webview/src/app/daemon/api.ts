import type {
	McpAddCommand,
	McpAddResult,
	McpAddAvailability,
	ConfigCredentialCommand,
	ConfigProviderCommand,
	ProviderTestCommand,
	ProviderTestReport,
	ConfigSettingCommand,
	ConfigSnapshot,
	HarnessList,
	HarnessPreview,
	HarnessSwitchCommand,
	SecurityActionCommand,
	SecurityList,
	SignInCommand,
	SignInState,
	RunnerCommand,
	RunnerList,
	ToolExposureList,
	ToolPinCommand,
} from "@octocodeai/octocode-contracts/config";
import { DAEMON_ROUTES } from "@octocodeai/octocode-contracts/protocol";
import type { DaemonAccess, DaemonRepo, DaemonSessions } from "@octocodeai/octocode-contracts/daemon";
import { bearer } from "../../access.ts";
import { requestJson } from "../../request.ts";
import { isRecord } from "@octocodeai/octocode-contracts/guards";

function harnessList(value: unknown): HarnessList {
	if (!isRecord(value) || !Array.isArray(value.rows)) throw new Error("Invalid harness response");
	return value as unknown as HarnessList;
}

function runnerList(value: unknown): RunnerList {
	if (!isRecord(value) || !Array.isArray(value.runners)) throw new Error("Invalid external agents response");
	return value as unknown as RunnerList;
}

function securityList(value: unknown): SecurityList {
	if (!isRecord(value) || !Array.isArray(value.items)) throw new Error("Invalid security response");
	return value as unknown as SecurityList;
}

function harnessPreview(value: unknown): HarnessPreview {
	if (!isRecord(value) || typeof value.id !== "string" || !Array.isArray(value.lines))
		throw new Error("Invalid harness preview response");
	return value as unknown as HarnessPreview;
}

/** The settings page reads these fields on every render; a body without them is not a snapshot. */
function configSnapshot(value: unknown): ConfigSnapshot {
	if (
		!isRecord(value) ||
		typeof value.keychainAvailable !== "boolean" ||
		!Array.isArray(value.providers) ||
		!Array.isArray(value.settings)
	)
		throw new Error("Invalid settings response");
	return value as unknown as ConfigSnapshot;
}

function toolList(value: unknown): ToolExposureList {
	if (!isRecord(value) || !Array.isArray(value.groups) || typeof value.setting !== "string")
		throw new Error("Invalid tools response");
	return value as unknown as ToolExposureList;
}

/** The route with `?repoId=` when the call names a workspace. */
function withRepo(route: string, repoId: string | undefined): string {
	return repoId ? `${route}?repoId=${encodeURIComponent(repoId)}` : route;
}

/**
 * Authenticated reads of the user-level daemon; every answer is shape-checked before the page uses it. `route` places a
 * settings route under the page's scope: a session's page passes `scopedRoute`, so its Settings view reaches that session
 * (`/s/<id>/api/config`, and a Tools panel with what the running session declares).
 */
export function createDaemonApi(access: string, route: (path: string) => string = (path) => path) {
	const headers = bearer(access);
	/** One JSON command to the daemon; the answer is returned as received. */
	const post = <T = unknown>(route: string, command: unknown, fallback: string): Promise<T> =>
		requestJson<T>(
			route,
			{ method: "POST", headers: { ...headers, "content-type": "application/json" }, body: JSON.stringify(command) },
			fallback,
		);
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
		access: async (signal?: AbortSignal): Promise<DaemonAccess> => {
			const value = await requestJson(DAEMON_ROUTES.access, { headers, signal }, "Could not read the link's access");
			return {
				writable: isRecord(value) && value.writable === true,
				terminalCommands: isRecord(value) && value.terminalCommands === true,
			};
		},
		mcpAddStatus: (repoId?: string): Promise<McpAddAvailability> =>
			requestJson(
				withRepo(route(DAEMON_ROUTES.configMcpAdd), repoId),
				{ headers },
				"Could not check MCP availability",
			).then((value) => {
				if (
					!isRecord(value) ||
					typeof value.available !== "boolean" ||
					(value.message !== undefined && typeof value.message !== "string")
				)
					throw new Error("Invalid MCP availability response");
				return { available: value.available, ...(typeof value.message === "string" ? { message: value.message } : {}) };
			}),
		addMcp: (command: McpAddCommand): Promise<McpAddResult> =>
			post(route(DAEMON_ROUTES.configMcpAdd), command, "Could not save the MCP definition").then((value) => {
				if (
					!isRecord(value) ||
					value.saved !== true ||
					typeof value.message !== "string" ||
					(value.warnings !== undefined &&
						(!Array.isArray(value.warnings) || value.warnings.some((warning) => typeof warning !== "string")))
				)
					throw new Error("Invalid MCP save response");
				return {
					saved: true,
					message: value.message,
					...(Array.isArray(value.warnings) ? { warnings: value.warnings as string[] } : {}),
				};
			}),
		config: (repoId?: string): Promise<ConfigSnapshot> =>
			requestJson(withRepo(route(DAEMON_ROUTES.config), repoId), { headers }, "Could not load settings").then(
				configSnapshot,
			),
		/** Sets, replaces or clears one provider key. The key travels only in this request body; the answer is the fresh snapshot, which never holds it. */
		saveCredential: (command: ConfigCredentialCommand, repoId?: string): Promise<ConfigSnapshot> =>
			post(withRepo(route(DAEMON_ROUTES.configCredentials), repoId), command, "Could not save the credential").then(
				configSnapshot,
			),
		/** Turns a provider or the Pi source on or off; the host writes the setting and answers with the fresh snapshot. */
		saveProvider: (command: ConfigProviderCommand, repoId?: string): Promise<ConfigSnapshot> =>
			post(withRepo(route(DAEMON_ROUTES.configProviders), repoId), command, "Could not change the provider").then(
				configSnapshot,
			),
		/** Tests one connected provider, or all of them: spends at most one small request each, only on this call. */
		testProviders: (command: ProviderTestCommand): Promise<ProviderTestReport> =>
			post(route(DAEMON_ROUTES.configProviderTest), command, "Could not run the test").then((value) => {
				if (!isRecord(value) || !Array.isArray(value.results)) throw new Error("Invalid test response");
				return value as ProviderTestReport;
			}),
		/** Starts, polls, answers or cancels a sign-in the host runs. An answer may carry a pasted code; the reply is the sign-in's state. */
		signIn: (command: SignInCommand): Promise<SignInState> =>
			post(route(DAEMON_ROUTES.configSignin), command, "Could not reach the sign-in").then((value) => {
				if (!isRecord(value) || typeof value.status !== "string" || !Array.isArray(value.events))
					throw new Error("Invalid sign-in response");
				return value as unknown as SignInState;
			}),
		/** The Harness panel's switches (launch capability only); `repoId` adds that workspace's own switches. */
		harness: (repoId?: string): Promise<HarnessList> =>
			requestJson(
				withRepo(route(DAEMON_ROUTES.configHarness), repoId),
				{ headers },
				"Could not load the harness switches",
			).then(harnessList),
		/** What switching one harness on would bring, scanned by the host; writes nothing. */
		previewHarness: (id: string, repoId?: string): Promise<HarnessPreview> =>
			requestJson(
				`${route(DAEMON_ROUTES.configHarnessPreview)}?id=${encodeURIComponent(id)}${repoId ? `&repoId=${encodeURIComponent(repoId)}` : ""}`,
				{ headers },
				"Could not scan the harness",
			).then(harnessPreview),
		/** Switches one Harness row; the host answers with the fresh list or refuses with its reason. */
		setHarness: (command: HarnessSwitchCommand): Promise<HarnessList> =>
			post(route(DAEMON_ROUTES.configHarness), command, "Could not change the switch").then(harnessList),
		/** The reviewed hooks, MCP servers and skills (launch capability only); `repoId` adds that workspace's items. */
		security: (repoId?: string): Promise<SecurityList> =>
			requestJson(
				withRepo(route(DAEMON_ROUTES.configSecurity), repoId),
				{ headers },
				"Could not load the security reviews",
			).then(securityList),
		/** Approves, denies or forgets one reviewed item; the host records it and answers with the fresh list or refuses with its reason. */
		decideSecurity: (command: SecurityActionCommand): Promise<SecurityList> =>
			post(route(DAEMON_ROUTES.configSecurity), command, "Could not record the decision").then(securityList),
		/** The external agents as last detected (launch capability only). */
		runners: (): Promise<RunnerList> =>
			requestJson(route(DAEMON_ROUTES.configRunners), { headers }, "Could not load the external agents").then(
				runnerList,
			),
		/** Checks, enables, disables or pauses external agents; the host answers with the fresh list or refuses with its reason. */
		actRunners: (command: RunnerCommand): Promise<RunnerList> =>
			post(route(DAEMON_ROUTES.configRunners), command, "Could not change the external agent").then(runnerList),
		/** Each tool's exposure state and pin (launch capability only); `repoId` reads that workspace's configuration too. */
		tools: (repoId?: string): Promise<ToolExposureList> =>
			requestJson(withRepo(route(DAEMON_ROUTES.configTools), repoId), { headers }, "Could not load the tools").then(
				toolList,
			),
		/** Pins or unpins one tool; the host answers with the fresh list or refuses with its reason. */
		pinTool: (command: ToolPinCommand): Promise<ToolExposureList> =>
			post(route(DAEMON_ROUTES.configTools), command, "Could not pin the tool").then(toolList),
		/** Changes one setting; the host answers with the fresh snapshot or refuses with its reason. */
		saveSetting: (command: ConfigSettingCommand): Promise<ConfigSnapshot> =>
			post(route(DAEMON_ROUTES.configSettings), command, "Could not save the setting").then(configSnapshot),
	};
}

import { Value } from "typebox/value";
import {
	ConfigSnapshotSchema,
	HarnessListSchema,
	HarnessPreviewSchema,
	SecurityListSchema,
	ToolExposureListSchema,
} from "@octocodeai/octocode-contracts/config";
import { configAudits } from "../../../../db/src/api.ts";
import { getAgentDir } from "../../config.ts";
import { sharedAgentDb } from "../../storage/database.ts";
import { addWebMcp, mcpAddAvailability } from "./mcp-add.ts";
import { writeConfigSetting } from "./config-write.ts";
import type { ConfigRoutes } from "./config-routes.ts";
import { buildConfigSnapshot } from "./config-status.ts";
import { runtimeSignIn, SignInManager } from "./credential-signin.ts";
import { refusalAuditor, writeConfigCredential } from "./credential-write.ts";
import { listHarness, switchHarness } from "./harness-config.ts";
import { previewHarness } from "./harness-preview.ts";
import { writeConfigProvider } from "./provider-write.ts";
import { listToolExposure, pinTool, type NativeToolsLive } from "./tool-exposure.ts";

function checkedHarness<T>(list: T): T {
	if (!Value.Check(HarnessListSchema, list)) throw new Error("The harness list is invalid.");
	return list;
}

/** Loaded on first use: the guard's collector reaches the loaders that this module's callers are part of. */
const securityModule = () => import("./security-config.ts");

function checkedSecurity<T>(list: T): T {
	if (!Value.Check(SecurityListSchema, list)) throw new Error("The security list is invalid.");
	return list;
}

function checkedTools<T>(list: T): T {
	if (!Value.Check(ToolExposureListSchema, list)) throw new Error("The tool list is invalid.");
	return list;
}

export interface ConfigFactoryOptions {
	env: NodeJS.ProcessEnv;
	/** Audit actor, read per call: the daemon learns its nonce after it starts listening. */
	actor: () => string;
	/** The running session's native tools, for the Tools panel; absent in a process without a session. */
	nativeTools?: () => NativeToolsLive;
}

/**
 * The settings routes shared by the user-level daemon and the per-session web server: configuration snapshot, setting,
 * credential, provider and harness writes, and sign-in. The caller supplies the repository catalog and must call
 * `signIns.closeAll()` when its server closes.
 */
export function createConfigRoutes(options: ConfigFactoryOptions): {
	routes: Omit<ConfigRoutes, "catalog">;
	signIns: SignInManager;
} {
	const { env, actor, nativeTools: native } = options;
	const audit = (entry: Parameters<typeof configAudits.record>[1]) => configAudits.record(sharedAgentDb(env).db, entry);
	const signIns = new SignInManager({ ...runtimeSignIn(getAgentDir()), actor, audit });
	const routes: Omit<ConfigRoutes, "catalog"> = {
		config: async (repo) => {
			const snapshot = await buildConfigSnapshot({ agentDir: getAgentDir(), cwd: repo?.root, env });
			if (!Value.Check(ConfigSnapshotSchema, snapshot)) throw new Error("The configuration snapshot is invalid.");
			return snapshot;
		},
		mcpAddStatus: async (_repo, live) => mcpAddAvailability(live?.mcpServerNames),
		addMcp: async (command, repo, live) =>
			addWebMcp(command, {
				agentDir: getAgentDir(),
				cwd: repo?.root,
				actor: actor(),
				audit,
				mcpServerNames: live?.mcpServerNames,
			}),
		writeSetting: (command, repo) => writeConfigSetting(command, { agentDir: getAgentDir(), cwd: repo?.root }),
		writeCredential: (command) =>
			writeConfigCredential(command, { agentDir: getAgentDir(), env, actor: actor(), audit }),
		writeProvider: (command) => writeConfigProvider(command, { agentDir: getAgentDir(), env, actor: actor(), audit }),
		signIn: (command) => signIns.handle(command),
		harness: async (repo) => checkedHarness(await listHarness({ agentDir: getAgentDir(), cwd: repo?.root })),
		previewHarness: async (id, repo) => {
			const preview = await previewHarness(id, { agentDir: getAgentDir(), cwd: repo?.root });
			if (!Value.Check(HarnessPreviewSchema, preview)) throw new Error("The harness preview is invalid.");
			return preview;
		},
		writeHarness: async (command, repo) =>
			checkedHarness(await switchHarness(command, { agentDir: getAgentDir(), cwd: repo?.root, actor: actor(), audit })),
		security: async (repo) =>
			checkedSecurity(
				await (await securityModule()).listSecurity({ agentDir: getAgentDir(), cwd: repo?.root, guard: { env } }),
			),
		writeSecurity: async (command, repo) =>
			checkedSecurity(
				await (
					await securityModule()
				).actSecurity(command.id, command.action, { agentDir: getAgentDir(), cwd: repo?.root, guard: { env } }),
			),
		// A session's own answer (`live`) wins over this process's: the daemon has no tools of its own.
		tools: async (repo, live) =>
			checkedTools(await listToolExposure({ agentDir: getAgentDir(), cwd: repo?.root, native, ...live })),
		writeTools: async (command, repo, live) =>
			checkedTools(
				await pinTool(command, { agentDir: getAgentDir(), cwd: repo?.root, native, ...live, actor: actor(), audit }),
			),
		auditRefused: (code) => refusalAuditor(actor(), audit)(code),
	};
	return { routes, signIns };
}

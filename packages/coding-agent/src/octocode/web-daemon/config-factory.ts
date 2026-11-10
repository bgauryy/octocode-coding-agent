import { Value } from "typebox/value";
import { ConfigSnapshotSchema, HarnessListSchema } from "@octocodeai/octocode-contracts/config";
import { configAudits } from "../../../../db/src/api.ts";
import { getAgentDir } from "../../config.ts";
import { sharedAgentDb } from "../../storage/database.ts";
import { writeConfigSetting } from "./config-write.ts";
import type { ConfigRoutes } from "./config-routes.ts";
import { buildConfigSnapshot } from "./config-status.ts";
import { runtimeSignIn, SignInManager } from "./credential-signin.ts";
import { refusalAuditor, writeConfigCredential } from "./credential-write.ts";
import { listHarness, switchHarness } from "./harness-config.ts";
import { writeConfigProvider } from "./provider-write.ts";

function checkedHarness<T>(list: T): T {
	if (!Value.Check(HarnessListSchema, list)) throw new Error("The harness list is invalid.");
	return list;
}

export interface ConfigFactoryOptions {
	env: NodeJS.ProcessEnv;
	/** Audit actor, read per call: the daemon learns its nonce after it starts listening. */
	actor: () => string;
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
	const { env, actor } = options;
	const audit = (entry: Parameters<typeof configAudits.record>[1]) => configAudits.record(sharedAgentDb(env).db, entry);
	const signIns = new SignInManager({ ...runtimeSignIn(getAgentDir()), actor, audit });
	const routes: Omit<ConfigRoutes, "catalog"> = {
		config: async (repo) => {
			const snapshot = await buildConfigSnapshot({ agentDir: getAgentDir(), cwd: repo?.root, env });
			if (!Value.Check(ConfigSnapshotSchema, snapshot)) throw new Error("The configuration snapshot is invalid.");
			return snapshot;
		},
		writeSetting: (command, repo) => writeConfigSetting(command, { agentDir: getAgentDir(), cwd: repo?.root }),
		writeCredential: (command) =>
			writeConfigCredential(command, { agentDir: getAgentDir(), env, actor: actor(), audit }),
		writeProvider: (command) => writeConfigProvider(command, { agentDir: getAgentDir(), env, actor: actor(), audit }),
		signIn: (command) => signIns.handle(command),
		harness: async (repo) => checkedHarness(await listHarness({ agentDir: getAgentDir(), cwd: repo?.root })),
		writeHarness: async (command, repo) =>
			checkedHarness(await switchHarness(command, { agentDir: getAgentDir(), cwd: repo?.root, actor: actor(), audit })),
		auditRefused: (code) => refusalAuditor(actor(), audit)(code),
	};
	return { routes, signIns };
}

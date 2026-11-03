import { join } from "node:path";
import { resolvePath } from "../../../common/src/paths.ts";
import { getAgentDir } from "../../src/config.ts";
import type { AgentSessionServices } from "../../src/core/agent-session-services.ts";
import {
	type CreateSessionFromServicesOptions,
	type CreateSessionResult,
	createSessionFromServices,
} from "../../src/core/agent-session/create-session.ts";
import { ModelRuntime } from "../../src/core/model-runtime.ts";
import { DefaultResourceLoader } from "../../src/core/resource-loader.ts";
import type { ResourceLoader } from "../../src/core/resource-loader/types.ts";
import { SessionManager } from "../../src/core/session-manager.ts";
import { SettingsManager } from "../../src/core/settings-manager.ts";

export interface CreateTestSessionOptions extends Omit<
	CreateSessionFromServicesOptions,
	"services" | "sessionManager"
> {
	/** Working directory for project-local discovery. Default: the session manager's cwd, else process.cwd() */
	cwd?: string;
	/** Global config directory. Default: the user's agent directory */
	agentDir?: string;
	/** Model and auth runtime. Default: one using agentDir/auth.json and models.json when agentDir is set */
	modelRuntime?: ModelRuntime;
	/** Resource loader. Default: a DefaultResourceLoader that has loaded its resources */
	resourceLoader?: ResourceLoader;
	/** Session manager. Default: SessionManager.create(cwd) */
	sessionManager?: SessionManager;
	/** Settings manager. Default: SettingsManager.create(cwd, agentDir) */
	settingsManager?: SettingsManager;
}

/**
 * Create a session for a test, filling the services a test does not supply.
 *
 * Production code builds services through `createAgentSessionServices`; tests often hand-pick one or two
 * of them, so this helper defaults the rest and then calls the private session factory.
 */
export async function createTestSession(options: CreateTestSessionOptions = {}): Promise<CreateSessionResult> {
	const {
		cwd: cwdOption,
		agentDir: agentDirOption,
		modelRuntime: modelRuntimeOption,
		resourceLoader: resourceLoaderOption,
		sessionManager: sessionManagerOption,
		settingsManager: settingsManagerOption,
		...factoryOptions
	} = options;
	const cwd = resolvePath(cwdOption ?? sessionManagerOption?.getCwd() ?? process.cwd());
	const agentDir = agentDirOption ? resolvePath(agentDirOption) : getAgentDir();

	const modelRuntime =
		modelRuntimeOption ??
		(await ModelRuntime.create(
			agentDirOption ? { authPath: join(agentDir, "auth.json"), modelsPath: join(agentDir, "models.json") } : {},
		));
	const settingsManager = settingsManagerOption ?? SettingsManager.create(cwd, agentDir);
	const sessionManager = sessionManagerOption ?? SessionManager.create(cwd);
	let resourceLoader = resourceLoaderOption;
	if (!resourceLoader) {
		resourceLoader = new DefaultResourceLoader({ cwd, agentDir, settingsManager });
		await resourceLoader.reload();
	}

	const services: AgentSessionServices = {
		cwd,
		agentDir,
		modelRuntime,
		settingsManager,
		resourceLoader,
		diagnostics: [],
	};
	return createSessionFromServices({ ...factoryOptions, services, sessionManager });
}

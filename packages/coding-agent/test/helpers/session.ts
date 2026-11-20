import { join } from "node:path";
import { resolvePath } from "@octocodeai/octocode-common/paths";
import { getAgentDir } from "../../src/config.ts";
import type { AgentSession } from "../../src/core/agent-session.ts";
import { shutdownSession } from "../../src/core/agent-session-runtime/shutdown.ts";
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
import { nativeFeatureSet } from "./native-features.ts";

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

export interface TestSessionResult extends CreateSessionResult {
	/** The services the session runs on; `dispose` releases the model runtime this helper created (not a supplied one). */
	services: AgentSessionServices;
}

/**
 * Create a session for a test, filling the services a test does not supply.
 *
 * Production code builds services through `createAgentSessionServices`; tests often hand-pick one or two
 * of them, so this helper defaults the rest and then calls the private session factory. End the session with
 * `endTestSession`, or at least call `services.dispose()`: a created runtime watches the credential file until then.
 */
export async function createTestSession(options: CreateTestSessionOptions = {}): Promise<TestSessionResult> {
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
	// As `createAgentSessionServices`: the runtime is released with the services only when this helper created it.
	const releaseRuntime = () => {
		if (!modelRuntimeOption) modelRuntime.dispose();
	};
	try {
		const settingsManager = settingsManagerOption ?? SettingsManager.create(cwd, agentDir);
		const sessionManager = sessionManagerOption ?? SessionManager.create(cwd);
		let resourceLoader = resourceLoaderOption;
		if (!resourceLoader) {
			resourceLoader = new DefaultResourceLoader({
				cwd,
				agentDir,
				settingsManager,
				nativeFeatures: nativeFeatureSet(),
			});
			await resourceLoader.reload();
		}

		const services: AgentSessionServices = {
			cwd,
			agentDir,
			modelRuntime,
			settingsManager,
			resourceLoader,
			diagnostics: [],
			dispose: releaseRuntime,
		};
		const result = await createSessionFromServices({ ...factoryOptions, services, sessionManager });
		return { ...result, services };
	} catch (error) {
		releaseRuntime();
		throw error;
	}
}

/**
 * End a test session as the product ends one (`shutdownSession`): abort the run, emit `session_shutdown` so features
 * release what they started (MCP servers among them), retire and dispose the session, then dispose `services`.
 */
export function endTestSession(session: AgentSession, services: AgentSessionServices): Promise<void> {
	return shutdownSession(session, { type: "session_shutdown", reason: "quit" }, undefined, services);
}

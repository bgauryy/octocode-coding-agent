/**
 * The MCP workspace's host ports without terminal rendering: identity, folders, bounded output, trust, model
 * credentials and browser permission state. `installMcpCorePorts()` is the composition root for them; it is idempotent.
 */

import { join } from "node:path";
import {
	APP_NAME,
	CONFIG_DIR_NAME,
	getAgentDir,
	getContextOptimizationDir,
	getDocsPath,
	getLegacyConfigDirs,
	getOctocodeHome,
	getPackageDir,
	isBunBinary,
	VERSION,
} from "../../config.ts";
import { FileAuthStorageBackend } from "../../core/auth-storage.ts";
import type { ModelRuntime } from "../../core/model-runtime.ts";
import { type McpAuthBackend, type McpHostPorts, installMcpHost } from "../../../../mcp/src/api.ts";
import { tailNote } from "../shared/format.ts";
import {
	boundImagePart,
	capResultText,
	imageBudget,
	saveFullOutput,
	spillOutput,
	TEXT_MAX_CHARS,
} from "../shared/spill.ts";
import { browserMcpAsked } from "../web/browser-mcp.ts";
import { contextOptimizationDirs, sessionsRoot, sessionTempRoot } from "../shared/home.ts";
import { resolveFolderTrust } from "../trust/resolve.ts";
import { calls } from "./calls.ts";
import { plugins } from "./plugins.ts";
import { review } from "./review.ts";
import { userResearchRoots } from "./research-roots.ts";
import { shippedSkillRoots } from "./shipped-skills.ts";
import { vendors } from "./vendors.ts";

const identity: McpHostPorts["identity"] = {
	appName: APP_NAME,
	configDirName: CONFIG_DIR_NAME,
	version: VERSION,
	isBunBinary: () => isBunBinary,
	packageDir: () => getPackageDir(),
};

const paths: McpHostPorts["paths"] = {
	agentDir: () => getAgentDir(),
	octocodeHome: (env) => getOctocodeHome(env),
	legacyConfigDirs: (agentDir) => getLegacyConfigDirs(agentDir),
	contextOptimizationDir: (agentDir) => getContextOptimizationDir(agentDir),
	contextOptimizationDirs: (cwd, agentDir) => contextOptimizationDirs(cwd, agentDir),
	sessionRoots: (cwd, env) => [sessionsRoot(env, cwd), sessionTempRoot(env, cwd)],
	researchRoots: (env) => userResearchRoots(env),
	// The skills Octocode ships that the session loads, which a root session's resource discovery adds
	// (`registerSkills`) and a subagent has from its parent's inventory: the default research server then starts with the
	// session instead of after discovery. Loaded skill folders compare as realpaths.
	announcedSkillRoots: (context) => shippedSkillRoots(context),
	mcpDocsPath: () => join(getDocsPath(), "mcp.md"),
	serverRecordsDir: () => join(getAgentDir(), "mcp-server-owners"),
};

const output: McpHostPorts["output"] = {
	textMaxChars: TEXT_MAX_CHARS,
	saveFullOutput,
	spillOutput,
	capResultText,
	imageBudget,
	boundImagePart,
	tailNote,
};

const trust: McpHostPorts["trust"] = {
	folderTrusted: (cwd) => resolveFolderTrust(cwd).state === "trusted",
};

const runtimes = new Map<string, Promise<ModelRuntime>>();

const models: McpHostPorts["models"] = {
	/** Loads the model runtime on the first request, so commands without provider-auth servers never pay for it. */
	async storedProviderToken(agentDir, provider) {
		try {
			let runtime = runtimes.get(agentDir);
			if (!runtime) {
				runtime = import("../../core/model-runtime.ts").then(({ ModelRuntime }) =>
					ModelRuntime.create({
						authPath: join(agentDir, "auth.json"),
						modelsPath: join(agentDir, "models.json"),
						allowModelNetwork: false,
						refreshOnCreate: false,
					}),
				);
				runtimes.set(agentDir, runtime);
			}
			return (await (await runtime).getAuth(provider))?.auth.apiKey;
		} catch {
			return undefined;
		}
	},
	fileAuthBackend: (file): McpAuthBackend => new FileAuthStorageBackend(file),
};

const browser: McpHostPorts["browser"] = { mcpAsked: browserMcpAsked };

export function installMcpCorePorts(): void {
	installMcpHost({
		identity,
		paths,
		plugins,
		vendors,
		output,
		trust,
		models,
		browser,
		review,
		calls,
	});
}

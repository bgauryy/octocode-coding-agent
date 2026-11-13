import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import {
	createFauxCore,
	fauxAssistantMessage,
	getCurrentSystemPrompt,
	getCurrentTools,
	type TranscriptContext,
} from "@octocodeai/octocode-ai";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { RecentUseRecorder } from "../../../common/src/recent-use.ts";
import {
	type AgentSessionRuntime,
	type CreateAgentSessionRuntimeFactory,
	createAgentSessionRuntime,
	createAgentSessionServices,
	createSessionFromServices,
} from "../../src/core/agent-session-runtime.ts";
import type { ExtensionFactory } from "../../src/core/features/index.ts";
import { SessionManager } from "../../src/core/session-manager.ts";
import { SettingsManager } from "../../src/core/settings-manager.ts";
import { resetOctocodeEnv, tmp } from "./helpers.ts";

/**
 * Deferred native tools (`web`, `archive`, `models`, `backlogPlan`) are decided when the tools register, from this
 * folder's record of recent use. The declarations are part of the provider's cached prefix: a resumed, reloaded or forked
 * session declares them as the session did before, whatever the folder used since; a new session reads the record.
 */
const savedEnv = { ...process.env };
const savedCwd = process.cwd();
const root = fs.realpathSync(tmp("octocode-native-resume-"));
const cwd = path.join(root, "project");
const agentDir = path.join(root, "agent");
const sessions = path.join(root, "sessions");

interface Declared {
	tools: string;
	system: string;
}
const requests: Declared[] = [];
let faux: ReturnType<typeof createFauxCore>;
let runtime: AgentSessionRuntime;
let settingsManager: SettingsManager;

async function ask(): Promise<Declared> {
	faux.setResponses([
		(context: TranscriptContext) => {
			requests.push({
				tools: JSON.stringify(getCurrentTools(context.messages)),
				system: getCurrentSystemPrompt(context.messages) ?? "",
			});
			return fauxAssistantMessage("ok");
		},
	]);
	await runtime.session.prompt("hello");
	return requests.at(-1)!;
}

const rebind = () => runtime.session.bindExtensions({ mode: "rpc", shutdownHandler: () => undefined } as never);
const web = (declared: Declared) =>
	(JSON.parse(declared.tools) as Array<{ name: string; parameters: unknown }>).find((tool) => tool.name === "web");

/** This folder calls `web`, as another session in it would. */
function folderUsesWeb(): void {
	new RecentUseRecorder(() => path.join(agentDir, "tool-use.json")).record(cwd, "native/web");
}

beforeAll(async () => {
	for (const dir of [cwd, agentDir, sessions, path.join(root, "home")]) fs.mkdirSync(dir, { recursive: true });
	execFileSync("git", ["init", "-q", "-b", "main"], { cwd });
	resetOctocodeEnv();
	Object.assign(process.env, {
		HOME: path.join(root, "home"),
		OCTOCODE_CODING_AGENT_DIR: agentDir,
		OCTOCODE_HOME: path.join(root, "home", ".octocode"),
		OCTOCODE_AGENT_DB: path.join(root, "team.sqlite"),
		OCTOCODE_OFFLINE: "1",
		OCTOCODE_PERMISSION: "workspace",
	});
	// The CLI runs in the session's folder; the native record is kept per working directory.
	process.chdir(cwd);
	faux = createFauxCore({
		provider: "faux",
		models: [{ id: "faux-1", contextWindow: 200_000, maxTokens: 4_096 }] as never,
	});
	const provider: ExtensionFactory = (api) => {
		api.registerProvider("faux", {
			name: "Faux",
			api: faux.api,
			baseUrl: "http://127.0.0.1:0",
			apiKey: "test",
			models: faux.models.map((model) => ({ ...model, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } })),
			streamSimple: faux.streamSimple,
		} as never);
	};
	settingsManager = SettingsManager.inMemory({ retry: { enabled: false } });
	const createRuntime: CreateAgentSessionRuntimeFactory = async ({ cwd, sessionManager, sessionStartEvent }) => {
		const services = await createAgentSessionServices({
			cwd,
			agentDir,
			settingsManager,
			resourceLoaderOptions: {
				extensionFactories: [{ name: "faux-provider", factory: provider }],
				noPromptTemplates: true,
				noThemes: true,
				noContextFiles: true,
				noSkills: true,
			},
		});
		const model = services.modelRuntime.getModel("faux", "faux-1");
		return {
			...(await createSessionFromServices({ services, sessionManager, sessionStartEvent, model })),
			services,
			diagnostics: services.diagnostics,
		};
	};
	runtime = await createAgentSessionRuntime(createRuntime, {
		cwd,
		agentDir,
		sessionManager: SessionManager.create(cwd, sessions),
	});
	await rebind();
}, 60_000);

afterAll(async () => {
	await runtime?.dispose();
	process.chdir(savedCwd);
	process.env = savedEnv;
});

describe("deferred native tools across a session's starts", () => {
	it("declares them again, byte for byte, on resume, reload and fork; a new session reads the folder's record", async () => {
		const first = await ask();
		const file = runtime.session.sessionFile!;
		// Nothing in this folder called `web` yet: it is declared deferred.
		expect(web(first)).toBeDefined();
		expect(JSON.stringify(web(first))).toContain("reason");

		folderUsesWeb();

		await runtime.switchSession(file);
		await rebind();
		const resumed = await ask();
		expect(resumed.tools).toBe(first.tools);
		expect(resumed.system).toBe(first.system);

		await runtime.session.reload();
		const reloaded = await ask();
		expect(reloaded.tools).toBe(first.tools);
		expect(reloaded.system).toBe(first.system);

		const leaf = runtime.session.sessionManager.getLeafId()!;
		await runtime.fork(leaf, { position: "at" });
		await rebind();
		const forked = await ask();
		expect(forked.tools).toBe(first.tools);
		expect(forked.system).toBe(first.system);

		await runtime.newSession();
		await rebind();
		const fresh = await ask();
		// The folder called `web` since: a new session declares it in full.
		expect(fresh.tools).not.toBe(first.tools);
		expect(JSON.stringify(web(fresh)).length).toBeGreaterThan(JSON.stringify(web(first)).length);
	}, 120_000);

	it("lets a pin or a setting other than recent decide, on a new session and on resume", async () => {
		const direct = (declared: Declared) => JSON.stringify(web(declared)).includes("Search terms");
		await runtime.newSession();
		await rebind();
		const recent = await ask();
		// The folder called `web` in the test above: declared in full.
		expect(direct(recent)).toBe(true);
		const file = runtime.session.sessionFile!;

		settingsManager.applyOverrides({ nativeToolExposure: { web: "deferred" } } as never, { durable: true });
		await runtime.newSession();
		await rebind();
		expect(direct(await ask())).toBe(false);
		// A pin set since the session started wins over what it declared.
		await runtime.switchSession(file);
		await rebind();
		expect(direct(await ask())).toBe(false);

		settingsManager.applyOverrides({ mcpExposure: "direct" }, { durable: true });
		await runtime.newSession();
		await rebind();
		const all = await ask();
		// The pin still decides `web`; the setting declares the other deferrable tools in full.
		expect(direct(all)).toBe(false);
		const tools = JSON.parse(all.tools) as Array<{ name: string; parameters: unknown }>;
		for (const name of ["archive", "models", "backlogPlan"])
			expect(JSON.stringify(tools.find((tool) => tool.name === name)?.parameters)).toContain('"description"');
	}, 120_000);
});

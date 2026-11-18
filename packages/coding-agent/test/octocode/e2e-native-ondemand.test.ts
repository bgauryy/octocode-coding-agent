import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import {
	createFauxCore,
	fauxAssistantMessage,
	fauxToolCall,
	getCurrentSystemPrompt,
	getCurrentTools,
	type TranscriptContext,
} from "@octocodeai/octocode-ai";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
	type AgentSessionRuntime,
	type CreateAgentSessionRuntimeFactory,
	createAgentSessionRuntime,
	createAgentSessionServices,
	createSessionFromServices,
} from "../../src/core/agent-session-runtime.ts";
import type { FeatureRegister } from "../../src/core/features/index.ts";
import { SessionManager } from "../../src/core/session-manager.ts";
import { SettingsManager } from "../../src/core/settings-manager.ts";
import { resetOctocodeEnv, tmp } from "./helpers.ts";
import { testFeatures } from "../helpers/features.ts";
import { nativeFeatureSet } from "../helpers/native-features.ts";

/**
 * On-demand native tools (`archive`, `models`) on a scripted model whose transport adds tools after the cached
 * prefix: a new session leaves them undeclared while `<tools>` lists them; the first call or a load with the `mcp` tool
 * declares one after the head, which stays byte-identical. A resumed session declares what it loaded, compaction carries
 * a loaded tool into the new head, and a switch to a model without in-place additions declares the rest deferred.
 */
const savedEnv = { ...process.env };
const savedCwd = process.cwd();
const root = fs.realpathSync(tmp("octocode-native-ondemand-"));
const cwd = path.join(root, "project");
const agentDir = path.join(root, "agent");
const sessions = path.join(root, "sessions");
const ON_DEMAND = ["archive", "models"];

let capable: ReturnType<typeof createFauxCore>;
let plain: ReturnType<typeof createFauxCore>;
let runtime: AgentSessionRuntime;

const cost = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
const providerOf =
	(core: ReturnType<typeof createFauxCore>, compat?: Record<string, boolean>): FeatureRegister =>
	(api) => {
		api.providers.register(core.models[0].provider, {
			name: core.models[0].provider,
			api: core.api,
			baseUrl: "http://127.0.0.1:0",
			apiKey: "test",
			models: core.models.map((model) => ({ ...model, cost, ...(compat ? { compat } : {}) })),
			streamSimple: core.streamSimple,
		} as never);
	};

/** Scripts `steps` on `core`, prompts once and returns every request the model received. */
async function run(
	core: ReturnType<typeof createFauxCore>,
	steps: ReturnType<typeof fauxAssistantMessage>[],
): Promise<TranscriptContext[]> {
	const requests: TranscriptContext[] = [];
	core.setResponses(
		steps.map((step) => (context: TranscriptContext) => {
			requests.push(structuredClone(context));
			return step;
		}),
	);
	await runtime.session.prompt("hello");
	return requests;
}

const rebind = () => runtime.session.bindFeatures({ mode: "rpc", shutdownHandler: () => undefined } as never);
const head = (context: TranscriptContext) => JSON.stringify(context.messages[0]);
const declared = (context: TranscriptContext) => getCurrentTools(context.messages).map((tool) => tool.name);
const toolsSection = (context: TranscriptContext) =>
	/<tools>\n([\s\S]*?)\n<\/tools>/.exec(getCurrentSystemPrompt(context.messages) ?? "")?.[1] ?? "";
const results = (context: TranscriptContext) =>
	JSON.stringify(context.messages.filter((message) => message.role === "toolResult"));

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
	process.chdir(cwd);
	capable = createFauxCore({
		provider: "faux",
		api: "anthropic-messages",
		models: [{ id: "faux-1", contextWindow: 200_000, maxTokens: 4_096 }] as never,
	});
	plain = createFauxCore({
		provider: "faux-plain",
		models: [{ id: "plain-1", contextWindow: 200_000, maxTokens: 4_096 }] as never,
	});
	const settingsManager = SettingsManager.inMemory({ retry: { enabled: false } });
	const createRuntime: CreateAgentSessionRuntimeFactory = async ({ cwd, sessionManager, sessionStartEvent }) => {
		const services = await createAgentSessionServices({
			cwd,
			agentDir,
			settingsManager,
			resourceLoaderOptions: {
				nativeFeatures: nativeFeatureSet(),
				features: testFeatures([
					{
						name: "faux-provider",
						factory: providerOf(capable, {
							supportsMidConvoSystemMessages: true,
							supportsMidConvoToolChanges: true,
						}),
					},
					{ name: "faux-plain-provider", factory: providerOf(plain) },
				]),
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

describe("on-demand native tools", () => {
	it("lists them undeclared, runs the first call and declares it after the head; a resume declares what was loaded", async () => {
		const [first, second] = await run(capable, [
			fauxAssistantMessage([fauxToolCall("archive", { op: "list", reason: "look back" })], { stopReason: "toolUse" }),
			fauxAssistantMessage("done"),
		]);
		for (const name of ON_DEMAND) {
			expect(declared(first)).not.toContain(name);
			expect(toolsSection(first)).toMatch(new RegExp(`^- ${name}: \\S`, "m"));
		}
		expect(declared(first)).toContain("mcp");
		// `web` is not on demand: a model asked for live content without naming a tool uses the shell instead.
		expect(declared(first)).toContain("web");
		// One line tells the model the undeclared ones are callable by name; it names each of them.
		const callable = toolsSection(first)
			.split("\n")
			.filter((line) => !line.startsWith("- ") && line.includes("`mcp`"));
		expect(callable).toHaveLength(1);
		for (const name of ON_DEMAND) expect(callable[0]).toContain(name);
		expect(results(second)).not.toContain("not found");
		expect(head(second)).toBe(head(first));
		expect(declared(second)).toContain("archive");
		expect(declared(second)).not.toContain("models");
		// Loading moves no `<tools>` line.
		expect(toolsSection(second)).toBe(toolsSection(first));

		await runtime.switchSession(runtime.session.sessionFile!);
		await rebind();
		const [resumed] = await run(capable, [fauxAssistantMessage("ok")]);
		expect(head(resumed)).toBe(head(first));
		expect(declared(resumed)).toContain("archive");
		expect(declared(resumed)).not.toContain("models");
		expect(toolsSection(resumed)).toBe(toolsSection(first));

		// Compaction starts a new head: the loaded tool is in it, the unloaded ones are still left out.
		// Enough history past the kept recent budget (20,000 tokens) for compaction to summarize.
		for (let i = 0; i < 4; i++) {
			runtime.session.sessionManager.appendMessage({
				role: "user",
				content: [{ type: "text", text: `question ${i} ${"x".repeat(40_000)}` }],
				timestamp: Date.now(),
			});
			runtime.session.sessionManager.appendMessage(fauxAssistantMessage(`answer ${i}`));
		}
		runtime.session.refreshContext();
		capable.setResponses([fauxAssistantMessage("summary of the work")]);
		await runtime.session.compact();
		const [compacted] = await run(capable, [fauxAssistantMessage("ok")]);
		expect(declared(compacted)).toContain("archive");
		expect(declared(compacted)).not.toContain("models");
	}, 120_000);

	it("declares one the mcp tool loads, and the rest deferred after a switch to a model that cannot add tools in place", async () => {
		await runtime.newSession();
		await rebind();
		const [first, second] = await run(capable, [
			fauxAssistantMessage(
				[fauxToolCall("mcp", { intent: "tools", server: "native", tool: "models", reason: "load" })],
				{
					stopReason: "toolUse",
				},
			),
			fauxAssistantMessage("done"),
		]);
		expect(declared(first)).not.toContain("models");
		expect(results(second)).toContain("Input schema");
		expect(head(second)).toBe(head(first));
		expect(declared(second)).toContain("models");

		await runtime.session.setModel(runtime.session.modelRuntime.getModel("faux-plain", "plain-1")!);
		const [switched] = await run(plain, [fauxAssistantMessage("ok")]);
		const tools = getCurrentTools(switched.messages);
		for (const name of ON_DEMAND) expect(tools.map((tool) => tool.name)).toContain(name);
		// The unloaded ones are declared deferred: top-level field names, no nested descriptions.
		const web = tools.find((tool) => tool.name === "web");
		expect(JSON.stringify(web?.parameters)).toContain("reason");
		expect(JSON.stringify(web?.parameters)).not.toContain("Search terms");
	}, 120_000);
});

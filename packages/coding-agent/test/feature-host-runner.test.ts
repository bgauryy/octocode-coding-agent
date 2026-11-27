import { createInMemoryModelRegistry } from "./model-runtime-test-utils.ts";
/**
 * Tests for FeatureHost - conflict detection, error handling, tool wrapping.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { AssistantMessage } from "@octocodeai/octocode-ai";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AuthStorage } from "../src/core/auth-storage.ts";
import { createEventBus } from "@octocodeai/octocode-agent-core";
import {
	createFeatureRuntime,
	discoverAndLoadFeatures,
	loadFeatureFromFactory,
	loadFeatures,
} from "./helpers/features.ts";
import { FeatureHost } from "../src/core/features/runner.ts";
import type {
	SessionActions,
	ContextActions,
	FeatureRegister,
	SessionUI,
	ProviderConfig,
} from "../src/core/features/types.ts";
import type { ModelRegistry } from "../src/core/model-registry.ts";
import type { ScopedModel } from "../src/core/model-resolver.ts";
import { SessionManager } from "../src/core/session-manager.ts";
import { buildSystemPrompt } from "../src/core/system-prompt.ts";

describe("FeatureHost", () => {
	let tempDir: string;
	let featuresDir: string;
	let sessionManager: SessionManager;
	let modelRegistry: ModelRegistry;

	beforeEach(async () => {
		tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "octocode-runner-test-"));
		featuresDir = path.join(tempDir, "features");
		fs.mkdirSync(featuresDir);
		sessionManager = SessionManager.inMemory();
		modelRegistry = await createInMemoryModelRegistry(AuthStorage.inMemory());
	});

	afterEach(() => {
		fs.rmSync(tempDir, { recursive: true, force: true });
	});

	it("emits each recorded usage receipt once and never emits another session's late receipt", () => {
		const runtime = createFeatureRuntime();
		const runner = new FeatureHost([], runtime, tempDir, sessionManager, modelRegistry);
		const onUsageRecorded = vi.fn();
		runner.bindCore(featureActions, { ...featureContextActions, onUsageRecorded });
		const record = runtime.createUsageRecorder("compaction");
		const message = {
			provider: "p",
			model: "m",
			usage: {
				input: 3,
				output: 1,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 4,
				cost: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, total: 2 },
			},
		} as unknown as AssistantMessage;
		record(message);
		record(message);
		expect(onUsageRecorded).toHaveBeenCalledTimes(1);
		expect(onUsageRecorded.mock.calls[0][0]).toMatchObject({ type: "usage", kind: "compaction" });
		sessionManager.newSession();
		record({ ...message, usage: { ...message.usage } });
		expect(onUsageRecorded).toHaveBeenCalledTimes(1);
		expect(sessionManager.getEntries()).toHaveLength(0);
	});

	const providerModelConfig: ProviderConfig = {
		baseUrl: "https://provider.test/v1",
		apiKey: "provider-test-key",
		api: "openai-completions",
		models: [
			{
				id: "instant-model",
				name: "Instant Model",
				reasoning: false,
				input: ["text"],
				cost: {
					input: 1,
					output: 2,
					cacheRead: 0.1,
					cacheWrite: 1.25,
					tiers: [
						{
							inputTokensAbove: 272000,
							input: 2,
							output: 3,
							cacheRead: 0.2,
							cacheWrite: 2.5,
						},
					],
				},
				contextWindow: 128000,
				maxTokens: 4096,
			},
		],
	};

	const featureActions: SessionActions = {
		sendMessage: () => {},
		sendUserMessage: () => {},
		getHiddenDeclarations: () => [],
		appendEntry: () => {},
		setSessionName: () => {},
		getSessionName: () => undefined,
		setLabel: () => {},
		getActiveTools: () => [],
		getAllTools: () => [],
		getSettings: () => ({}),
		setActiveTools: () => {},
		selectsTools: () => true,
		refreshTools: () => {},
		getCommands: () => [],
		getSkillDirectories: () => [],
		getSkillResourceSnapshot: () => ({ version: 1 as const, resources: [], explicitSkills: [] }),
		setModel: async () => false,
		getThinkingLevel: () => "off",
	};

	const featureContextActions: ContextActions = {
		getModel: () => undefined,
		isIdle: () => true,
		isProjectTrusted: () => true,
		getSignal: () => undefined,
		abort: () => {},
		hasPendingMessages: () => false,
		isMessageQueued: () => false,
		shutdown: () => {},
		getContextUsage: () => undefined,
		compact: () => {},
		getSystemPrompt: () => "",
		getScopedModels: () => [],
	};

	describe("scopedModels", () => {
		it("reflects the getScopedModels context action on ctx.scopedModels", async () => {
			const result = await discoverAndLoadFeatures([], tempDir, tempDir);
			const runner = new FeatureHost(result.features, result.runtime, tempDir, sessionManager, modelRegistry);

			// Before bindCore the default is an empty list (never undefined).
			expect(runner.createContext().scopedModels).toEqual([]);

			// After bindCore wires a getScopedModels action, ctx.scopedModels
			// returns it live (same reference, lazy getter).
			const scoped = [{ model: { id: "scoped-test" }, thinkingLevel: "high" }] as unknown as ScopedModel[];
			runner.bindCore(featureActions, { ...featureContextActions, getScopedModels: () => scoped });
			expect(runner.createContext().scopedModels).toBe(scoped);
		});
	});

	describe("tool collection", () => {
		it("collects tools from multiple extensions", async () => {
			const toolCode = (name: string) => `
				import { Type } from "typebox";
				export default function(api) {
					api.tools.register({
						name: "${name}",
						label: "${name}",
						description: "Test tool",
						parameters: Type.Object({}),
						execute: async () => ({ content: [{ type: "text", text: "ok" }], details: {} }),
					});
				}
			`;
			fs.writeFileSync(path.join(featuresDir, "tool-a.ts"), toolCode("tool_a"));
			fs.writeFileSync(path.join(featuresDir, "tool-b.ts"), toolCode("tool_b"));

			const result = await discoverAndLoadFeatures([], tempDir, tempDir);
			const runner = new FeatureHost(result.features, result.runtime, tempDir, sessionManager, modelRegistry);
			const tools = runner.getAllRegisteredTools();

			expect(tools.length).toBe(2);
			expect(tools.map((t) => t.definition.name).sort()).toEqual(["tool_a", "tool_b"]);
		});

		it("rejects extension tools without a parameter schema", async () => {
			const featurePath = path.join(featuresDir, "missing-parameters.js");
			fs.writeFileSync(
				featurePath,
				`export default function(api) {
	api.tools.register({
		name: "noop",
		label: "No-op",
		description: "Do nothing",
		execute: async () => ({ content: [{ type: "text", text: "ok" }] }),
	});
}`,
			);

			const result = await loadFeatures([featurePath], tempDir);

			expect(result.features).toHaveLength(0);
			expect(result.errors).toEqual([
				{
					path: featurePath,
					error: `Failed to load feature: Tool "noop" registered by "${featurePath}" must define an object parameter schema.`,
				},
			]);
		});

		it("keeps first tool when two extensions register the same name", async () => {
			const first = `
				import { Type } from "typebox";
				export default function(api) {
					api.tools.register({
						name: "shared",
						label: "shared",
						description: "first",
						parameters: Type.Object({}),
						execute: async () => ({ content: [{ type: "text", text: "ok" }], details: {} }),
					});
				}
			`;
			const second = `
				import { Type } from "typebox";
				export default function(api) {
					api.tools.register({
						name: "shared",
						label: "shared",
						description: "second",
						parameters: Type.Object({}),
						execute: async () => ({ content: [{ type: "text", text: "ok" }], details: {} }),
					});
				}
			`;
			fs.writeFileSync(path.join(featuresDir, "a-first.ts"), first);
			fs.writeFileSync(path.join(featuresDir, "b-second.ts"), second);

			const result = await discoverAndLoadFeatures([], tempDir, tempDir);
			const runner = new FeatureHost(result.features, result.runtime, tempDir, sessionManager, modelRegistry);
			const tools = runner.getAllRegisteredTools();

			expect(tools).toHaveLength(1);
			expect(tools[0]?.definition.description).toBe("first");
		});
	});

	describe("command collection", () => {
		it("registers one name per command and qualifies built-in collisions", async () => {
			fs.writeFileSync(
				path.join(featuresDir, "names.ts"),
				`export default function(api) {
				api.commands.register("first", { handler: async () => {}, getArgumentCompletions: () => [{value:"ok", label:"ok"}] });
				api.commands.register("model", { handler: async () => {} });
			}`,
			);
			const result = await discoverAndLoadFeatures([], tempDir, tempDir);
			expect(result.errors).toEqual([]);
			const runner = new FeatureHost(result.features, result.runtime, tempDir, sessionManager, modelRegistry);
			expect(runner.getRegisteredCommands().map((command) => command.invocationName)).toEqual(["first", "model:1"]);
			expect(runner.getCommand("first")?.getArgumentCompletions).toBeTypeOf("function");
			expect(runner.getCommand("model")).toBeUndefined();
			expect(runner.getCommand("model:1")?.name).toBe("model");
		});

		it("keeps the native implementation of built-in commands unqualified", async () => {
			fs.writeFileSync(
				path.join(featuresDir, "native.ts"),
				`export default function(api) {
				api.commands.register("model", { handler: async () => {} });
			}`,
			);
			const result = await discoverAndLoadFeatures([], tempDir, tempDir);
			result.features[0].commands.get("model")!.sourceInfo = {
				...result.features[0].sourceInfo,
				owner: "native",
			};
			const runner = new FeatureHost(result.features, result.runtime, tempDir, sessionManager, modelRegistry);
			expect(runner.getCommand("model")?.invocationName).toBe("model");
		});

		it("collects commands from multiple extensions", async () => {
			const cmdCode = (name: string) => `
				export default function(api) {
					api.commands.register("${name}", {
						description: "Test command",
						handler: async () => {},
					});
				}
			`;
			fs.writeFileSync(path.join(featuresDir, "cmd-a.ts"), cmdCode("cmd-a"));
			fs.writeFileSync(path.join(featuresDir, "cmd-b.ts"), cmdCode("cmd-b"));

			const result = await discoverAndLoadFeatures([], tempDir, tempDir);
			const runner = new FeatureHost(result.features, result.runtime, tempDir, sessionManager, modelRegistry);
			const commands = runner.getRegisteredCommands();

			expect(commands.length).toBe(2);
			expect(commands.map((c) => c.name).sort()).toEqual(["cmd-a", "cmd-b"]);
			expect(commands.map((c) => c.invocationName).sort()).toEqual(["cmd-a", "cmd-b"]);
		});

		it("gets command by invocation name", async () => {
			const cmdCode = `
				export default function(api) {
					api.commands.register("my-cmd", {
						description: "My command",
						handler: async () => {},
					});
				}
			`;
			fs.writeFileSync(path.join(featuresDir, "cmd.ts"), cmdCode);

			const result = await discoverAndLoadFeatures([], tempDir, tempDir);
			const runner = new FeatureHost(result.features, result.runtime, tempDir, sessionManager, modelRegistry);

			const cmd = runner.getCommand("my-cmd");
			expect(cmd).toBeDefined();
			expect(cmd?.name).toBe("my-cmd");
			expect(cmd?.invocationName).toBe("my-cmd");
			expect(cmd?.description).toBe("My command");

			const missing = runner.getCommand("not-exists");
			expect(missing).toBeUndefined();
		});

		it("suffixes duplicate extension commands in insertion order", async () => {
			const cmdCode = (description: string) => `
				export default function(api) {
					api.commands.register("shared-cmd", {
						description: "${description}",
						handler: async () => {},
					});
				}
			`;
			fs.writeFileSync(path.join(featuresDir, "cmd-a.ts"), cmdCode("First command"));
			fs.writeFileSync(path.join(featuresDir, "cmd-b.ts"), cmdCode("Second command"));

			const result = await discoverAndLoadFeatures([], tempDir, tempDir);
			const runner = new FeatureHost(result.features, result.runtime, tempDir, sessionManager, modelRegistry);
			const commands = runner.getRegisteredCommands();
			const diagnostics = runner.getCommandDiagnostics();

			expect(commands).toHaveLength(2);
			expect(commands.map((command) => command.name)).toEqual(["shared-cmd", "shared-cmd"]);
			expect(commands.map((command) => command.invocationName)).toEqual(["shared-cmd:1", "shared-cmd:2"]);
			expect(commands.map((command) => command.description)).toEqual(["First command", "Second command"]);
			expect(diagnostics).toEqual(
				commands.map((command) => ({
					type: "warning",
					path: command.sourceInfo.path,
					message: `Command /shared-cmd conflicts with another command; available as /${command.invocationName}.`,
				})),
			);
			expect(runner.getCommand("shared-cmd:1")?.description).toBe("First command");
			expect(runner.getCommand("shared-cmd:2")?.description).toBe("Second command");
		});
	});

	describe("context creation", () => {
		it("exposes the current abort signal on FeatureContext", async () => {
			const result = await discoverAndLoadFeatures([], tempDir, tempDir);
			const runner = new FeatureHost(result.features, result.runtime, tempDir, sessionManager, modelRegistry);
			const controller = new AbortController();

			runner.bindCore(featureActions, {
				...featureContextActions,
				getSignal: () => controller.signal,
			});

			const ctx = runner.createContext();
			expect(ctx.signal).toBe(controller.signal);
			expect(ctx.signal?.aborted).toBe(false);

			controller.abort();
			expect(ctx.signal?.aborted).toBe(true);
		});

		it("exposes print mode and hasUI false by default", async () => {
			const result = await discoverAndLoadFeatures([], tempDir, tempDir);
			const runner = new FeatureHost(result.features, result.runtime, tempDir, sessionManager, modelRegistry);
			runner.bindCore(featureActions, featureContextActions);

			const ctx = runner.createContext();
			expect(ctx.mode).toBe("print");
			expect(ctx.hasUI).toBe(false);
		});

		it("exposes project trust state on FeatureContext", async () => {
			const result = await discoverAndLoadFeatures([], tempDir, tempDir);
			const runner = new FeatureHost(result.features, result.runtime, tempDir, sessionManager, modelRegistry);
			runner.bindCore(featureActions, {
				...featureContextActions,
				isProjectTrusted: () => false,
			});

			const ctx = runner.createContext();
			expect(ctx.isProjectTrusted()).toBe(false);
		});

		it("exposes rpc mode with hasUI true when an RPC UI context is provided", async () => {
			const result = await discoverAndLoadFeatures([], tempDir, tempDir);
			const runner = new FeatureHost(result.features, result.runtime, tempDir, sessionManager, modelRegistry);
			runner.bindCore(featureActions, featureContextActions);
			runner.setUIContext({} as SessionUI, "rpc");

			const ctx = runner.createContext();
			expect(ctx.mode).toBe("rpc");
			expect(ctx.hasUI).toBe(true);
		});

		it("exposes tui mode with hasUI true when a TUI UI context is provided", async () => {
			const result = await discoverAndLoadFeatures([], tempDir, tempDir);
			const runner = new FeatureHost(result.features, result.runtime, tempDir, sessionManager, modelRegistry);
			runner.bindCore(featureActions, featureContextActions);
			runner.setUIContext({} as SessionUI, "tui");

			const ctx = runner.createContext();
			expect(ctx.mode).toBe("tui");
			expect(ctx.hasUI).toBe(true);
		});
	});

	describe("error handling", () => {
		it("calls error listeners when handler throws", async () => {
			const extCode = `
				export default function(api) {
					api.bus.on("context", async () => {
						throw new Error("Handler error!");
					});
				}
			`;
			fs.writeFileSync(path.join(featuresDir, "throws.ts"), extCode);

			const result = await discoverAndLoadFeatures([], tempDir, tempDir);
			const runner = new FeatureHost(result.features, result.runtime, tempDir, sessionManager, modelRegistry);

			const errors: Array<{ source: string; event: string; error: string }> = [];
			runner.onError((err) => {
				errors.push(err);
			});

			// Emit context event which will trigger the throwing handler
			await runner.emitContext([]);

			expect(errors.length).toBe(1);
			expect(errors[0].error).toContain("Handler error!");
			expect(errors[0].event).toBe("context");
		});

		it("fails closed when a user_bash handler throws", async () => {
			const extCode = `
				export default function(api) {
					api.bus.on("user_bash", async () => {
						throw new Error("Routing failed");
					});
				}
			`;
			fs.writeFileSync(path.join(featuresDir, "throws.ts"), extCode);

			const result = await discoverAndLoadFeatures([], tempDir, tempDir);
			const runner = new FeatureHost(result.features, result.runtime, tempDir, sessionManager, modelRegistry);
			const errors: Array<{ event: string; error: string }> = [];
			runner.onError((error) => errors.push(error));

			await expect(
				runner.emitUserBash({ type: "user_bash", command: "pwd", excludeFromContext: false, cwd: tempDir }),
			).rejects.toThrow("Routing failed");
			expect(errors).toMatchObject([{ event: "user_bash", error: "Routing failed" }]);
		});

		it.each([
			["an empty object", "{}"],
			["null operations", "{ operations: null }"],
			["operations without exec", "{ operations: {} }"],
			["a null result", "{ result: null }"],
			["an incomplete result", '{ result: { output: "handled" } }'],
			[
				"operations and a result",
				'{ operations: { exec: async () => ({ exitCode: 0 }) }, result: { output: "handled", exitCode: 0, cancelled: false, truncated: false } }',
			],
		])("fails closed when a user_bash handler returns %s", async (_description, handlerResult) => {
			const extCode = `
				export default function(api) {
					api.bus.on("user_bash", async () => (${handlerResult}));
				}
			`;
			fs.writeFileSync(path.join(featuresDir, "invalid-result.ts"), extCode);

			const result = await discoverAndLoadFeatures([], tempDir, tempDir);
			const runner = new FeatureHost(result.features, result.runtime, tempDir, sessionManager, modelRegistry);
			const errors: Array<{ event: string; error: string }> = [];
			runner.onError((error) => errors.push(error));

			await expect(
				runner.emitUserBash({ type: "user_bash", command: "pwd", excludeFromContext: false, cwd: tempDir }),
			).rejects.toThrow("Invalid user_bash handler result");
			expect(errors).toMatchObject([
				{ event: "user_bash", error: expect.stringContaining("Invalid user_bash handler result") },
			]);
		});

		it("accepts valid user_bash operations and result overrides", async () => {
			const extCode = `
				export default function(api) {
					api.bus.on("user_bash", async (event) => {
						if (event.command === "operations") {
							return { operations: { exec: async () => ({ exitCode: 0 }) } };
						}
						return { result: { output: "handled", exitCode: 0, cancelled: false, truncated: false } };
					});
				}
			`;
			fs.writeFileSync(path.join(featuresDir, "valid-results.ts"), extCode);

			const result = await discoverAndLoadFeatures([], tempDir, tempDir);
			const runner = new FeatureHost(result.features, result.runtime, tempDir, sessionManager, modelRegistry);
			const event = { type: "user_bash" as const, excludeFromContext: false, cwd: tempDir };

			const operations = await runner.emitUserBash({ ...event, command: "operations" });
			expect(operations).toEqual({ operations: { exec: expect.any(Function) } });
			await expect(runner.emitUserBash({ ...event, command: "result" })).resolves.toEqual({
				result: { output: "handled", exitCode: 0, cancelled: false, truncated: false },
			});
		});
	});

	describe("message and entry renderers", () => {
		it("gets message renderer by type", async () => {
			const extCode = `
				export default function(api) {
					api.renderers.message("my-type", (message, options, theme) => null);
				}
			`;
			fs.writeFileSync(path.join(featuresDir, "renderer.ts"), extCode);

			const result = await discoverAndLoadFeatures([], tempDir, tempDir);
			const runner = new FeatureHost(result.features, result.runtime, tempDir, sessionManager, modelRegistry);

			const renderer = runner.getMessageRenderer("my-type");
			expect(renderer).toBeDefined();

			const missing = runner.getMessageRenderer("not-exists");
			expect(missing).toBeUndefined();
		});

		it("gets entry renderer by type", async () => {
			const extCode = `
				export default function(api) {
					api.renderers.entry("my-entry", (entry, options, theme) => null);
				}
			`;
			fs.writeFileSync(path.join(featuresDir, "entry-renderer.ts"), extCode);

			const result = await discoverAndLoadFeatures([], tempDir, tempDir);
			const runner = new FeatureHost(result.features, result.runtime, tempDir, sessionManager, modelRegistry);

			expect(runner.getEntryRenderer("my-entry")).toBeDefined();
			expect(runner.getEntryRenderer("not-exists")).toBeUndefined();
		});
	});

	describe("before_agent_start", () => {
		it("keeps ctx.getSystemPrompt() in sync with chained system prompt updates", async () => {
			const extCode1 = `
				export default function(api) {
					api.bus.on("before_agent_start", async (_event, ctx) => {
						return {
							systemPrompt: ctx.getSystemPrompt() + "\\nfirst",
						};
					});
				}
			`;
			const extCode2 = `
				export default function(api) {
					api.bus.on("before_agent_start", async (_event, ctx) => {
						return {
							systemPrompt: ctx.getSystemPrompt() + "\\nsecond",
						};
					});
				}
			`;
			fs.writeFileSync(path.join(featuresDir, "before-agent-start-1.ts"), extCode1);
			fs.writeFileSync(path.join(featuresDir, "before-agent-start-2.ts"), extCode2);

			const result = await discoverAndLoadFeatures([], tempDir, tempDir);
			expect(result.errors).toEqual([]);
			expect(result.features).toHaveLength(2);
			const runner = new FeatureHost(result.features, result.runtime, tempDir, sessionManager, modelRegistry);
			const errors: string[] = [];
			runner.onError((error) => errors.push(error.error));
			runner.bindCore(featureActions, featureContextActions);

			const chained = await runner.emitBeforeAgentStart(
				{ messageType: "user", prompt: "hello" },
				{
					cwd: tempDir,
					customPrompt: "base",
				},
			);

			expect(errors).toEqual([]);
			expect(chained.messages).toEqual([]);
			expect(buildSystemPrompt(chained.systemPromptOptions)).toMatch(/base[\s\S]*\nfirst\nsecond$/);
		});
	});

	// The MCP extension renders calls to tools that are not registered.
	it("resolves tool renderers in extension load order, each able to defer to the next", async () => {
		const runtime = createFeatureRuntime();
		const eventBus = createEventBus();
		const renderCall = () => ({ render: () => [], invalidate: () => {} });
		const first = await loadFeatureFromFactory(
			(api) => api.renderers.tool((toolName, next) => (toolName === "a" ? { renderCall } : next())),
			tempDir,
			eventBus,
			runtime,
		);
		const second = await loadFeatureFromFactory(
			(api) => api.renderers.tool((_toolName, next) => next() ?? { renderShell: "self" }),
			tempDir,
			eventBus,
			runtime,
		);
		const runner = new FeatureHost([first, second], runtime, tempDir, sessionManager, modelRegistry);

		expect(runner.resolveToolRenderers("a", () => undefined)).toEqual({ renderCall });
		expect(runner.resolveToolRenderers("b", () => undefined)).toEqual({ renderShell: "self" });
		expect(runner.resolveToolRenderers("b", () => ({ renderCall }))).toEqual({ renderCall });
	});

	describe("boundary chaining", () => {
		it("chains shared draft proposals and preserves omitted result fields", async () => {
			const runtime = createFeatureRuntime();
			const eventBus = createEventBus();
			const observations: Array<{ entries: number; continuation: boolean; preview: number }> = [];
			const first = await loadFeatureFromFactory(
				(api) => {
					api.bus.on("agent_before_settle", (event) => {
						observations.push({
							entries: event.entries.length,
							continuation: event.continue,
							preview: event.context.contextEntries.length,
						});
						event.entries.push({ type: "custom", customType: "first", data: 1 });
						return { continue: true };
					});
				},
				tempDir,
				eventBus,
				runtime,
				"<inline:first>",
			);
			const second = await loadFeatureFromFactory(
				(api) => {
					api.bus.on("agent_before_settle", (event) => {
						observations.push({
							entries: event.entries.length,
							continuation: event.continue,
							preview: event.context.contextEntries.length,
						});
						return { entries: [] };
					});
				},
				tempDir,
				eventBus,
				runtime,
				"<inline:second>",
			);
			const runner = new FeatureHost([first, second], runtime, tempDir, sessionManager, modelRegistry);

			const result = await runner.emitBoundary({ type: "agent_before_settle", outcome: "completed" }, (entries) => ({
				contextEntries: entries.map((entry, index) => ({
					sourceEntry: {
						type: "custom",
						id: `draft-${index}`,
						parentId: null,
						timestamp: "",
						customType: entry.type,
					},
					messages: [],
				})),
				contextMessages: [],
				llmMessages: [],
				pendingMessages: [],
				canContinue: false,
			}));

			expect(observations).toEqual([
				{ entries: 0, continuation: false, preview: 0 },
				{ entries: 1, continuation: true, preview: 1 },
			]);
			expect(result.entries).toEqual([]);
			expect(result.continue).toBe(true);
		});

		it("reports invalid boundary previews and lets later handlers repair the proposal", async () => {
			const runtime = createFeatureRuntime();
			let secondRan = false;
			const first = await loadFeatureFromFactory(
				(api) => {
					api.bus.on("agent_before_settle", () => ({
						entries: [{ type: "context_edit", targetId: "missing", replacement: null }],
					}));
				},
				tempDir,
				createEventBus(),
				runtime,
				"<inline:invalid>",
			);
			const second = await loadFeatureFromFactory(
				(api) => {
					api.bus.on("agent_before_settle", (event) => {
						secondRan = true;
						expect(event.entries).toHaveLength(1);
						return { entries: [] };
					});
				},
				tempDir,
				createEventBus(),
				runtime,
				"<inline:repair>",
			);
			const runner = new FeatureHost([first, second], runtime, tempDir, sessionManager, modelRegistry);
			const errors: string[] = [];
			runner.onError((error) => errors.push(error.error));

			const result = await runner.emitBoundary({ type: "agent_before_settle", outcome: "completed" }, (entries) => {
				if (entries.some((entry) => entry.type === "context_edit")) throw new Error("Entry missing not found");
				return {
					contextEntries: [],
					contextMessages: [],
					llmMessages: [],
					pendingMessages: [],
					canContinue: false,
				};
			});

			expect(secondRan).toBe(true);
			expect(errors).toContain("Invalid boundary entries: Entry missing not found");
			expect(result.entries).toEqual([]);
			expect(result.valid).toBe(true);
		});

		it("keeps shared mutations made before a handler throws", async () => {
			const runtime = createFeatureRuntime();
			const feature = await loadFeatureFromFactory(
				(api) => {
					api.bus.on("agent_before_settle", (event) => {
						event.entries.push({ type: "custom", customType: "kept" });
						throw new Error("boundary failed");
					});
				},
				tempDir,
				createEventBus(),
				runtime,
			);
			const runner = new FeatureHost([feature], runtime, tempDir, sessionManager, modelRegistry);
			const errors: string[] = [];
			runner.onError((error) => errors.push(error.error));

			const result = await runner.emitBoundary({ type: "agent_before_settle", outcome: "completed" }, () => ({
				contextEntries: [],
				contextMessages: [],
				llmMessages: [],
				pendingMessages: [],
				canContinue: false,
			}));

			expect(result.entries).toMatchObject([{ type: "custom", customType: "kept" }]);
			expect(errors).toEqual(["boundary failed"]);
		});
	});

	describe("tool_result chaining", () => {
		it("chains content modifications across handlers", async () => {
			const extCode1 = `
				export default function(api) {
					api.bus.on("tool_result", async (event) => {
						return {
							content: [...event.content, { type: "text", text: "ext1" }],
						};
					});
				}
			`;
			const extCode2 = `
				export default function(api) {
					api.bus.on("tool_result", async (event) => {
						return {
							content: [...event.content, { type: "text", text: "ext2" }],
						};
					});
				}
			`;
			fs.writeFileSync(path.join(featuresDir, "tool-result-1.ts"), extCode1);
			fs.writeFileSync(path.join(featuresDir, "tool-result-2.ts"), extCode2);

			const result = await discoverAndLoadFeatures([], tempDir, tempDir);
			const runner = new FeatureHost(result.features, result.runtime, tempDir, sessionManager, modelRegistry);

			const chained = await runner.emitToolResult({
				type: "tool_result",
				toolName: "my_tool",
				toolCallId: "call-1",
				input: {},
				content: [{ type: "text", text: "base" }],
				details: { initial: true },
				isError: false,
			});

			expect(chained).toBeDefined();
			const chainedContent = chained?.content;
			expect(chainedContent).toBeDefined();
			expect(chainedContent![0]).toEqual({ type: "text", text: "base" });
			expect(chainedContent).toHaveLength(3);
			const appendedText = chainedContent!
				.slice(1)
				.filter((item): item is { type: "text"; text: string } => item.type === "text")
				.map((item) => item.text);
			expect(appendedText.sort()).toEqual(["ext1", "ext2"]);
		});

		it("preserves previous modifications when later handlers return partial patches", async () => {
			const extCode1 = `
				export default function(api) {
					api.bus.on("tool_result", async () => {
						return {
							content: [{ type: "text", text: "first" }],
							details: { source: "ext1" },
						};
					});
				}
			`;
			const extCode2 = `
				export default function(api) {
					api.bus.on("tool_result", async () => {
						return {
							isError: true,
						};
					});
				}
			`;
			fs.writeFileSync(path.join(featuresDir, "tool-result-partial-1.ts"), extCode1);
			fs.writeFileSync(path.join(featuresDir, "tool-result-partial-2.ts"), extCode2);

			const result = await discoverAndLoadFeatures([], tempDir, tempDir);
			const runner = new FeatureHost(result.features, result.runtime, tempDir, sessionManager, modelRegistry);

			const chained = await runner.emitToolResult({
				type: "tool_result",
				toolName: "my_tool",
				toolCallId: "call-2",
				input: {},
				content: [{ type: "text", text: "base" }],
				details: { initial: true },
				isError: false,
			});

			expect(chained).toEqual({
				content: [{ type: "text", text: "first" }],
				details: { source: "ext1" },
				isError: true,
			});
		});
	});

	describe("provider registration", () => {
		it("bindCore ignores invalid queued registrations and reports extension error", async () => {
			const runtime = createFeatureRuntime();
			runtime.registerProvider(
				"broken-provider",
				{
					streamSimple: () => {
						throw new Error("should not run");
					},
				},
				"/tmp/broken-extension.ts",
			);

			const runner = new FeatureHost([], runtime, tempDir, sessionManager, modelRegistry);
			const errors: string[] = [];
			runner.onError((error) => errors.push(`${error.source}: ${error.error}`));

			expect(() => runner.bindCore(featureActions, featureContextActions)).not.toThrow();
			expect(errors).toEqual([
				'/tmp/broken-extension.ts: Provider broken-provider: "api" is required when registering streamSimple.',
			]);
			await expect(modelRegistry.refresh()).resolves.toMatchObject({ aborted: false });
		});

		it("post-bind register takes effect immediately", () => {
			const runtime = createFeatureRuntime();
			const runner = new FeatureHost([], runtime, tempDir, sessionManager, modelRegistry);

			runner.bindCore(featureActions, featureContextActions);
			expect(runtime.pendingProviderRegistrations).toHaveLength(0);

			runtime.registerProvider("instant-provider", providerModelConfig);
			expect(runtime.pendingProviderRegistrations).toHaveLength(0);
			expect(modelRegistry.find("instant-provider", "instant-model")?.cost.tiers).toEqual([
				{
					inputTokensAbove: 272000,
					input: 2,
					output: 3,
					cacheRead: 0.2,
					cacheWrite: 2.5,
				},
			]);
		});
	});

	describe("command context", () => {
		it("passes fork options through to the bound handler", async () => {
			const runtime = createFeatureRuntime();
			const runner = new FeatureHost([], runtime, tempDir, sessionManager, modelRegistry);
			const fork = vi.fn(async () => ({ cancelled: false }));

			runner.bindCommandContext({
				waitForIdle: async () => {},
				newSession: async () => ({ cancelled: false }),
				fork,
				navigateTree: async () => ({ cancelled: false }),
				switchSession: async () => ({ cancelled: false }),
				reload: async () => {},
			});

			const commandContext = runner.createCommandContext();
			await commandContext.fork("entry-1");
			expect(fork).toHaveBeenCalledWith("entry-1", undefined);

			await commandContext.fork("entry-2", { position: "at" });
			expect(fork).toHaveBeenLastCalledWith("entry-2", { position: "at" });
		});
	});

	// Event handler unsubscription must not disturb other registrations.
	describe("event subscriptions", () => {
		async function loadSubscriptionFeature(factory: FeatureRegister) {
			const runtime = createFeatureRuntime();
			const feature = await loadFeatureFromFactory(factory, tempDir, createEventBus(), runtime);
			const runner = new FeatureHost([feature], runtime, tempDir, sessionManager, modelRegistry);
			return { feature, runner };
		}

		it("allows self-removal without skipping neighboring handlers", async () => {
			const calls: string[] = [];
			const { runner } = await loadSubscriptionFeature((api) => {
				const unsubscribe = api.bus.on("agent_end", () => {
					calls.push("A");
					unsubscribe();
				});
				api.bus.on("agent_end", () => {
					calls.push("B");
				});
			});

			await runner.emit({ type: "agent_end", messages: [] });
			expect(calls).toEqual(["A", "B"]);

			await runner.emit({ type: "agent_end", messages: [] });
			expect(calls).toEqual(["A", "B", "B"]);
		});

		it("removes duplicate registrations independently and cleans up the last handler", async () => {
			const calls: string[] = [];
			const unsubscribers: Array<() => void> = [];
			const { feature, runner } = await loadSubscriptionFeature((api) => {
				const shared = () => {
					calls.push("shared");
				};
				unsubscribers.push(api.bus.on("agent_end", shared));
				unsubscribers.push(
					api.bus.on("agent_end", () => {
						calls.push("B");
					}),
				);
				unsubscribers.push(api.bus.on("agent_end", shared));
			});
			const [stopFirst, stopB, stopSecond] = unsubscribers;

			stopSecond();
			stopSecond();
			await runner.emit({ type: "agent_end", messages: [] });
			expect(calls).toEqual(["shared", "B"]);

			stopFirst();
			await runner.emit({ type: "agent_end", messages: [] });
			expect(calls).toEqual(["shared", "B", "B"]);

			stopB();
			expect(feature.handlers.has("agent_end")).toBe(false);
		});

		it("keeps removed pending handlers in the current dispatch", async () => {
			const calls: string[] = [];
			const { runner } = await loadSubscriptionFeature((api) => {
				api.bus.on("agent_end", () => {
					calls.push("A");
					stopB();
				});
				const stopB = api.bus.on("agent_end", () => {
					calls.push("B");
				});
				api.bus.on("agent_end", () => {
					calls.push("C");
				});
			});

			await runner.emit({ type: "agent_end", messages: [] });
			expect(calls).toEqual(["A", "B", "C"]);
			await runner.emit({ type: "agent_end", messages: [] });
			expect(calls).toEqual(["A", "B", "C", "A", "C"]);
		});

		it("defers registrations made during dispatch until the next dispatch", async () => {
			const calls: string[] = [];
			const { runner } = await loadSubscriptionFeature((api) => {
				api.bus.on("agent_end", () => {
					calls.push("A");
					api.bus.on("agent_end", () => {
						calls.push("C");
					});
				});
				api.bus.on("agent_end", () => {
					calls.push("B");
				});
			});

			await runner.emit({ type: "agent_end", messages: [] });
			expect(calls).toEqual(["A", "B"]);
			await runner.emit({ type: "agent_end", messages: [] });
			expect(calls).toEqual(["A", "B", "A", "B", "C"]);
		});

		it("uses a fresh handler list for nested dispatches", async () => {
			const calls: string[] = [];
			const { runner } = await loadSubscriptionFeature((api) => {
				const stopA = api.bus.on("agent_end", async () => {
					calls.push("A");
					stopA();
					stopB();
					api.bus.on("agent_end", () => {
						calls.push("C");
					});
					await runner.emit({ type: "agent_end", messages: [] });
				});
				const stopB = api.bus.on("agent_end", () => {
					calls.push("B");
				});
			});

			await runner.emit({ type: "agent_end", messages: [] });
			expect(calls).toEqual(["A", "C", "B"]);
		});
	});

	describe("hasHandlers", () => {
		it("returns true when handlers exist for event type", async () => {
			const extCode = `
				export default function(api) {
					api.bus.on("tool_call", async () => undefined);
				}
			`;
			fs.writeFileSync(path.join(featuresDir, "handler.ts"), extCode);

			const result = await discoverAndLoadFeatures([], tempDir, tempDir);
			const runner = new FeatureHost(result.features, result.runtime, tempDir, sessionManager, modelRegistry);

			expect(runner.hasHandlers("tool_call")).toBe(true);
			expect(runner.hasHandlers("agent_end")).toBe(false);
		});
	});
});

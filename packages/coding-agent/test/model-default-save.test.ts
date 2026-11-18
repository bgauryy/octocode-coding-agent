import { Agent } from "@octocodeai/octocode-agent-core";
import { InMemoryModelsStore } from "@octocodeai/octocode-ai";
import { streamSimple } from "@octocodeai/octocode-ai/compat";
import type { TUI } from "@octocodeai/octocode-tui";
import { setKeybindings } from "@octocodeai/octocode-tui";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { AgentSession } from "../src/core/agent-session.ts";
import { DefaultModelSaveError } from "../src/core/agent-session/model-default.ts";
import { AuthStorage } from "../src/core/auth-storage.ts";
import { KeybindingsManager } from "../src/core/keybindings.ts";
import { convertToLlm } from "../src/core/messages.ts";
import { findInitialModel } from "../src/core/model-resolver.ts";
import { ModelRuntime } from "../src/core/model-runtime.ts";
import { SessionManager } from "../src/core/session-manager.ts";
import { SettingsManager } from "../src/core/settings-manager.ts";
import type { ModelSelectorComponent } from "../src/modes/interactive/components/model-selector.ts";
import { showModelSelector } from "../src/modes/interactive/interactive-mode/model-controls.ts";
import { createClaudeCodeBackend } from "../src/octocode/claude-code/provider.ts";
import { initTheme } from "../src/theme/theme.ts";
import { createTestResourceLoader } from "./utilities.ts";

const cleanups: Array<() => Promise<void>> = [];
beforeAll(() => initTheme("dark"));
beforeEach(() => setKeybindings(new KeybindingsManager()));
afterEach(async () => {
	vi.restoreAllMocks();
	for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

async function fixture(kind: "local" | "claude" = "local") {
	const root = mkdtempSync(join(tmpdir(), "octocode-model-default-"));
	const agentDir = join(root, "agent");
	mkdirSync(agentDir);
	const modelsPath = join(agentDir, "models.json");
	writeFileSync(
		modelsPath,
		JSON.stringify({
			providers: {
				local: {
					api: "openai-completions",
					baseUrl: "http://localhost:11434/v1",
					apiKey: "no-key",
					models: ["first", "second"].map((id) => ({ id, contextWindow: 8192, maxTokens: 2048 })),
				},
			},
		}),
	);
	const backend =
		kind === "claude" ? createClaudeCodeBackend({ command: process.execPath, args: [], cli: "fixture" }) : undefined;
	const runtimes: ModelRuntime[] = [];
	const sessions: AgentSession[] = [];
	cleanups.push(async () => {
		for (const session of sessions) session.dispose();
		for (const modelRuntime of runtimes) modelRuntime.dispose();
		await backend?.close();
		rmSync(root, { recursive: true, force: true });
	});
	const openRuntime = async () => {
		const runtime = await ModelRuntime.create({
			credentials: AuthStorage.inMemory(),
			modelsStore: new InMemoryModelsStore(),
			modelsPath: kind === "local" ? modelsPath : null,
			allowModelNetwork: false,
		});
		runtimes.push(runtime);
		if (backend) {
			runtime.registerNativeProvider(backend.provider);
			await runtime.refresh({ allowNetwork: false });
		}
		return runtime;
	};
	const runtime = await openRuntime();
	const provider = kind === "local" ? "local" : "claude-code";
	const initial = runtime.getModel(provider, kind === "local" ? "first" : "opus");
	const selected = runtime.getModel(provider, kind === "local" ? "second" : "sonnet");
	if (!initial || !selected) throw new Error("Fixture models were not registered");
	const settings = SettingsManager.create(root, agentDir);
	const session = new AgentSession({
		agent: new Agent({ initialState: { model: initial }, streamFn: streamSimple, convertToLlm }),
		sessionManager: SessionManager.inMemory(),
		settingsManager: settings,
		modelRuntime: runtime,
		cwd: root,
		resourceLoader: createTestResourceLoader(),
	});
	sessions.push(session);
	return {
		root,
		agentDir,
		runtime,
		settings,
		session,
		initial,
		selected,
		openRuntime,
		settingsPath: join(agentDir, "settings.json"),
	};
}

function picker(context: Awaited<ReturnType<typeof fixture>>, choice = "Global: every project") {
	let component: ModelSelectorComponent | undefined;
	const done = vi.fn();
	const host = {
		session: context.session,
		settingsManager: context.settings,
		ui: { requestRender: vi.fn() } as unknown as TUI,
		showStatus: vi.fn(),
		showWarning: vi.fn(),
		showError: vi.fn(),
		updateAvailableProviderCount: vi.fn(),
		updateEditorBorderColor: vi.fn(),
		maybeWarnAboutAnthropicSubscriptionAuth: vi.fn().mockResolvedValue(undefined),
		showSelectorDialog: vi.fn().mockResolvedValue(choice),
		showSelector: (create: (finish: () => void) => { component: ModelSelectorComponent }) => {
			component = create(done).component;
		},
	};
	showModelSelector(host as unknown as Parameters<typeof showModelSelector>[0], context.selected.id);
	if (!component) throw new Error("Model picker did not open");
	return { host, component, done };
}

describe("saving a default model", () => {
	it.each(["local", "claude"] as const)("restores the %s model from disk in a fresh runtime", async (kind) => {
		const context = await fixture(kind);
		await context.session.setModel(context.selected, { persist: true });
		const stored = JSON.parse(readFileSync(context.settingsPath, "utf8"));
		expect(stored).toMatchObject({ defaultProvider: context.selected.provider, defaultModel: context.selected.id });
		const settings = SettingsManager.create(context.root, context.agentDir);
		const modelRuntime = await context.openRuntime();
		const restored = await findInitialModel({
			modelRuntime,
			scopedModels: [],
			isContinuing: false,
			defaultProvider: settings.getDefaultProvider(),
			defaultModelId: settings.getDefaultModel(),
		});
		expect(restored.model).toMatchObject({ provider: context.selected.provider, id: context.selected.id });
	});

	it("persists a default and shortcut scope together even when the session already includes the model", async () => {
		const context = await fixture();
		const initialReference = `${context.initial.provider}/${context.initial.id}`;
		const selectedReference = `${context.selected.provider}/${context.selected.id}`;
		context.settings.setEnabledModels([initialReference]);
		await context.settings.flush();
		context.session.setScopedModels([{ model: context.initial }, { model: context.selected }]);
		await context.session.setModel(context.selected, { persist: true });
		expect(JSON.parse(readFileSync(context.settingsPath, "utf8"))).toMatchObject({
			defaultProvider: context.selected.provider,
			defaultModel: context.selected.id,
			enabledModels: [initialReference, selectedReference],
		});
	});

	it("reports a failed save while keeping the selected model and thinking state usable", async () => {
		const context = await fixture();
		await context.settings.saveDefaultModelSelection(context.initial.provider, context.initial.id);
		rmSync(context.settingsPath);
		mkdirSync(context.settingsPath);
		await expect(context.session.setModel(context.selected, { persist: true })).rejects.toBeInstanceOf(
			DefaultModelSaveError,
		);
		expect(context.session.model).toMatchObject({ provider: context.selected.provider, id: context.selected.id });
		expect(context.settings.getDefaultModel()).toBe(context.initial.id);
		expect(context.session.sessionManager.getEntries()).toContainEqual(
			expect.objectContaining({
				type: "model_change",
				provider: context.selected.provider,
				modelId: context.selected.id,
			}),
		);
	});

	it("bounds model-selection authentication even when a provider check never settles", async () => {
		const context = await fixture();
		const apiKey = context.runtime.getProvider(context.selected.provider)?.auth.apiKey;
		if (!apiKey) throw new Error("Fixture provider has no API-key method");
		const originalCheck = apiKey.check;
		const started = Promise.withResolvers<void>();
		apiKey.check = () => {
			started.resolve();
			return new Promise(() => {});
		};
		// The 15 s limit is a cleared timer (not `AbortSignal.timeout`): fake time shows it fires, and not before.
		vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
		try {
			const selecting = context.session.setModel(context.selected, { persist: true });
			let settled = false;
			void selecting.then(
				() => (settled = true),
				() => (settled = true),
			);
			await started.promise;
			await vi.advanceTimersByTimeAsync(14_999);
			expect(settled).toBe(false);
			await vi.advanceTimersByTimeAsync(1);
			await expect(selecting).rejects.toMatchObject({ name: "TimeoutError" });
			expect(context.session.model?.id).toBe(context.initial.id);
			expect(existsSync(context.settingsPath)).toBe(false);
		} finally {
			vi.useRealTimers();
			apiKey.check = originalCheck;
		}
	});

	it("waits for the save before confirming it and ignores repeat save keystrokes", async () => {
		const context = await fixture();
		const { host, component, done } = picker(context);
		const gate = Promise.withResolvers<void>();
		const original = context.settings.saveDefaultModelSelection.bind(context.settings);
		const saving = vi.spyOn(context.settings, "saveDefaultModelSelection").mockImplementation(async (...args) => {
			await gate.promise;
			return original(...args);
		});
		component.handleInput("\x13");
		await vi.waitFor(() => expect(saving).toHaveBeenCalledOnce());
		expect(host.showStatus).toHaveBeenLastCalledWith(
			`Saving default model: ${context.selected.provider}/${context.selected.id}…`,
		);
		expect(done).not.toHaveBeenCalled();
		component.handleInput("\x13");
		expect(saving).toHaveBeenCalledOnce();
		gate.resolve();
		await vi.waitFor(() => expect(done).toHaveBeenCalledOnce());
		expect(host.showStatus).toHaveBeenLastCalledWith(
			`Saved global default: ${context.selected.provider}/${context.selected.id}`,
		);
	});

	it("shows a session-only warning instead of saved-default success after a storage failure", async () => {
		const context = await fixture();
		await context.settings.saveDefaultModelSelection(context.initial.provider, context.initial.id);
		rmSync(context.settingsPath);
		mkdirSync(context.settingsPath);
		const { host, component, done } = picker(context);
		component.handleInput("\x13");
		await vi.waitFor(() => expect(done).toHaveBeenCalledOnce());
		expect(host.showWarning).toHaveBeenCalledWith(expect.stringContaining("Could not save the default model"));
		expect(host.showStatus).not.toHaveBeenCalledWith(expect.stringMatching(/^(Default model:|Saved global default:)/));
		expect(host.showError).not.toHaveBeenCalled();
		expect(host.updateEditorBorderColor).toHaveBeenCalledOnce();
	});

	it("keeps Enter session-only and leaves startup settings untouched", async () => {
		const context = await fixture();
		const { host, component, done } = picker(context);
		component.handleInput("\r");
		component.handleInput("\r");
		await vi.waitFor(() => expect(done).toHaveBeenCalledOnce());
		expect(host.showStatus).toHaveBeenLastCalledWith(`Model: ${context.selected.id}`);
		expect(context.session.model?.id).toBe(context.selected.id);
		expect(context.settings.getDefaultModel()).toBeUndefined();
		expect(existsSync(context.settingsPath)).toBe(false);
	});

	it.each([
		{ scope: "project", global: true },
		{ scope: "run", global: true },
		{ scope: "project", global: false },
		{ scope: "run", global: false },
	])("preserves global shortcuts under a $scope override with global=$global", async ({ scope, global }) => {
		const context = await fixture();
		const initial = `${context.initial.provider}/${context.initial.id}`;
		const selected = `${context.selected.provider}/${context.selected.id}`;
		const globals = [initial, "local/archived"];
		if (global) {
			context.settings.setEnabledModels(globals);
			await context.settings.flush();
		}
		if (scope === "project") {
			const folder = join(context.root, ".octocode");
			mkdirSync(folder, { recursive: true });
			writeFileSync(join(folder, "settings.json"), JSON.stringify({ enabledModels: [initial] }));
			context.settings.setProjectTrusted(true);
			await context.settings.reload();
		} else context.settings.applyOverrides({ enabledModels: [initial] }, { durable: true });
		context.session.setScopedModels([{ model: context.initial }]);
		const { host, component, done } = picker(context);
		component.handleInput("\t");
		component.handleInput("\x13");
		await vi.waitFor(() => expect(done).toHaveBeenCalledOnce());
		const stored = JSON.parse(readFileSync(context.settingsPath, "utf8"));
		if (global) expect(stored.enabledModels).toEqual([...globals, selected]);
		else expect(stored).not.toHaveProperty("enabledModels");
		expect(context.settings.getEnabledModels()).toEqual([initial]);
		expect(context.session.scopedModels.map(({ model }) => `${model.provider}/${model.id}`)).toEqual([
			initial,
			selected,
		]);
		expect(host.showStatus).toHaveBeenLastCalledWith(
			`Saved global default: ${selected}. Workspace or run settings take precedence here.`,
		);
	});

	it("explains when a saved global default is overridden for this workspace or run", async () => {
		const context = await fixture();
		context.settings.applyOverrides(
			{ defaultProvider: context.initial.provider, defaultModel: context.initial.id },
			{ durable: true },
		);
		const { host, component, done } = picker(context);
		component.handleInput("\x13");
		await vi.waitFor(() => expect(done).toHaveBeenCalledOnce());
		expect(host.showStatus).toHaveBeenLastCalledWith(
			`Saved global default: ${context.selected.provider}/${context.selected.id}. Workspace or run settings take precedence here.`,
		);
		expect(context.settings.getDefaultModel()).toBe(context.initial.id);
		expect(JSON.parse(readFileSync(context.settingsPath, "utf8")).defaultModel).toBe(context.selected.id);
	});

	it("saves a project default to project settings only when the project is trusted", async () => {
		const context = await fixture();
		context.settings.setProjectTrusted(true);
		const { host, component, done } = picker(context, "This project only");
		component.handleInput("\x13");
		await vi.waitFor(() => expect(done).toHaveBeenCalledOnce());
		await context.settings.flush();
		expect(host.showSelectorDialog).toHaveBeenCalledOnce();
		const project = JSON.parse(readFileSync(join(context.root, ".octocode", "settings.json"), "utf8"));
		expect(project).toMatchObject({ defaultProvider: context.selected.provider, defaultModel: context.selected.id });
		expect(existsSync(context.settingsPath)).toBe(false);
		expect(host.showStatus).toHaveBeenLastCalledWith(
			`Saved project default: ${context.selected.provider}/${context.selected.id}`,
		);
	});

	it("refuses a project default write in an untrusted project", async () => {
		const context = await fixture();
		await expect(
			context.settings.saveDefaultModelSelection(context.selected.provider, context.selected.id, { scope: "project" }),
		).rejects.toThrow();
		expect(existsSync(join(context.root, ".octocode", "settings.json"))).toBe(false);
	});

	it("reports that the project default wins after a global save", async () => {
		const context = await fixture();
		const folder = join(context.root, ".octocode");
		mkdirSync(folder, { recursive: true });
		writeFileSync(
			join(folder, "settings.json"),
			JSON.stringify({ defaultProvider: context.initial.provider, defaultModel: context.initial.id }),
		);
		context.settings.setProjectTrusted(true);
		await context.settings.reload();
		const { host, component, done } = picker(context, "Global: every project");
		component.handleInput("\x13");
		await vi.waitFor(() => expect(done).toHaveBeenCalledOnce());
		expect(host.showStatus).toHaveBeenLastCalledWith(
			expect.stringContaining(`This project's default (${context.initial.provider}/${context.initial.id}) wins here`),
		);
		expect(JSON.parse(readFileSync(context.settingsPath, "utf8")).defaultModel).toBe(context.selected.id);
	});
});

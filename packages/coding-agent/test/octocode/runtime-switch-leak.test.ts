import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { parseArgs } from "../../src/cli/args.ts";
import {
	type AgentSessionServices,
	type CreateAgentSessionRuntimeFactory,
	createAgentSessionRuntime,
	createAgentSessionServices,
	createSessionFromServices,
} from "../../src/core/agent-session-runtime.ts";
import { ModelRuntime } from "../../src/core/model-runtime.ts";
import { DefaultResourceLoader } from "../../src/core/resource-loader.ts";
import { AuthStorage } from "../../src/core/auth-storage.ts";
import { ModelAvailability } from "../../src/core/model-runtime/availability.ts";
import { SessionManager } from "../../src/core/session-manager.ts";
import { createCliRuntimeFactory } from "../../src/main/runtime-factory.ts";
import { tmp } from "./helpers.ts";

/**
 * Each /new, /resume, fork or reload builds new services with a new model runtime. The replaced runtime's credential
 * watcher must stop, or every switch adds one fs watcher and one availability pass per later auth.json change.
 */
describe("session switches", () => {
	afterEach(() => vi.restoreAllMocks());

	function folders(): { cwd: string; agentDir: string } {
		const root = tmp("octocode-switch-leak-");
		const cwd = path.join(root, "project");
		const agentDir = path.join(root, "agent");
		fs.mkdirSync(cwd);
		fs.mkdirSync(agentDir);
		return { cwd, agentDir };
	}

	/** Counts credential watchers that started and were not stopped. */
	function countWatchers(): { readonly live: number } {
		const counter = { live: 0 };
		const watch = AuthStorage.prototype.watch;
		vi.spyOn(AuthStorage.prototype, "watch").mockImplementation(function (this: AuthStorage, onChange, intervalMs) {
			const stop = watch.call(this, onChange, intervalMs);
			counter.live++;
			let stopped = false;
			return () => {
				if (!stopped) counter.live--;
				stopped = true;
				stop();
			};
		});
		return counter;
	}

	it("releases credential watchers after repeated resource-loading failures", async () => {
		const { cwd, agentDir } = folders();
		const watchers = countWatchers();
		vi.spyOn(DefaultResourceLoader.prototype, "reload").mockRejectedValue(new Error("failed resources"));
		for (let cycle = 0; cycle < 10; cycle++) {
			await expect(createAgentSessionServices({ cwd, agentDir })).rejects.toThrow("failed resources");
			expect(watchers.live).toBe(0);
		}
	});

	it("leaves a borrowed model runtime alive after resource loading fails", async () => {
		const { cwd, agentDir } = folders();
		const watchers = countWatchers();
		const modelRuntime = await ModelRuntime.create({ authPath: path.join(agentDir, "auth.json") });
		try {
			vi.spyOn(DefaultResourceLoader.prototype, "reload").mockRejectedValue(new Error("failed resources"));
			await expect(createAgentSessionServices({ cwd, agentDir, modelRuntime })).rejects.toThrow("failed resources");
			expect(watchers.live).toBe(1);
		} finally {
			modelRuntime.dispose();
		}
		expect(watchers.live).toBe(0);
	});

	it("releases the watcher when the initial model refresh fails", async () => {
		const { agentDir } = folders();
		const watchers = countWatchers();
		vi.spyOn(ModelRuntime.prototype, "refresh").mockRejectedValue(new Error("failed refresh"));
		await expect(ModelRuntime.create({ authPath: path.join(agentDir, "auth.json") })).rejects.toThrow("failed refresh");
		expect(watchers.live).toBe(0);
	});

	it("leave one credential watcher and one live availability after 10 switches", async () => {
		const { cwd, agentDir } = folders();
		const watchers = countWatchers();
		let refreshes = 0;
		const queue = ModelAvailability.prototype.queueAvailabilityRefresh;
		vi.spyOn(ModelAvailability.prototype, "queueAvailabilityRefresh").mockImplementation(function (
			this: ModelAvailability,
			signal,
		) {
			refreshes++;
			return queue.call(this, signal);
		});
		const factory = createCliRuntimeFactory({
			parsed: parseArgs(["--no-mcp", "--no-skills", "--no-prompt-templates", "--no-themes"]),
			cwd,
			folderTrust: () => ({ state: "trusted", root: cwd }),
			requireTrust: false,
			getAppMode: () => "print",
			skillResourceSnapshot: undefined,
		});
		const runtime = await createAgentSessionRuntime(factory, {
			cwd,
			agentDir,
			sessionManager: SessionManager.inMemory(cwd),
		});
		let disposed = false;
		try {
			expect(watchers.live).toBe(1);
			for (let switches = 0; switches < 10; switches++) await runtime.newSession();
			expect(watchers.live).toBe(1);

			// Another process saves a credential: only the current runtime refreshes availability once.
			refreshes = 0;
			fs.writeFileSync(path.join(agentDir, "auth.json"), JSON.stringify({ example: { type: "api_key", key: "x" } }));
			await vi.waitFor(() => expect(refreshes).toBeGreaterThan(0), { timeout: 5_000, interval: 20 });
			// Bursts settle into one call per watcher; give stragglers from leaked watchers the same window to land.
			await new Promise((resolve) => setImmediate(resolve));
			await vi.waitFor(() => expect(refreshes).toBe(1), { timeout: 1_000, interval: 50 });

			// Quitting releases the last services too.
			await runtime.dispose();
			disposed = true;
			expect(watchers.live).toBe(0);
		} finally {
			if (!disposed) await runtime.dispose();
		}
	}, 60_000);

	// Hosts other than the CLI (test helpers, embedders) build services in their own factory and never dispose them:
	// the runtime releases what it replaced.
	it("stop a replaced watcher whatever factory built the services", async () => {
		const { cwd, agentDir } = folders();
		const watchers = countWatchers();
		const factory: CreateAgentSessionRuntimeFactory = async ({ cwd, sessionManager, sessionStartEvent }) => {
			const services = await createAgentSessionServices({
				cwd,
				agentDir,
				resourceLoaderOptions: { noSkills: true, noPromptTemplates: true, noThemes: true, disabledFeatures: ["mcp"] },
			});
			return {
				...(await createSessionFromServices({ services, sessionManager, sessionStartEvent, noTools: "all" })),
				services,
				diagnostics: services.diagnostics,
			};
		};
		const runtime = await createAgentSessionRuntime(factory, {
			cwd,
			agentDir,
			sessionManager: SessionManager.inMemory(cwd),
		});
		let disposed = false;
		try {
			for (let switches = 0; switches < 10; switches++) await runtime.newSession();
			expect(watchers.live).toBe(1);
			await runtime.dispose();
			disposed = true;
			expect(watchers.live).toBe(0);
		} finally {
			if (!disposed) await runtime.dispose();
		}
	}, 60_000);

	it("keep services the factory hands back again, and services whose model runtime the caller owns", async () => {
		const { cwd, agentDir } = folders();
		const watchers = countWatchers();
		const callerOwned = await createAgentSessionServices({
			cwd,
			agentDir,
			resourceLoaderOptions: { noSkills: true, noPromptTemplates: true, noThemes: true, disabledFeatures: ["mcp"] },
		});
		expect(watchers.live).toBe(1);
		const shared: AgentSessionServices = await createAgentSessionServices({
			cwd,
			agentDir,
			modelRuntime: callerOwned.modelRuntime,
			resourceLoaderOptions: { noSkills: true, noPromptTemplates: true, noThemes: true, disabledFeatures: ["mcp"] },
		});
		let releases = 0;
		const release = shared.dispose;
		shared.dispose = () => {
			releases++;
			release?.();
		};
		const factory: CreateAgentSessionRuntimeFactory = async ({ sessionManager, sessionStartEvent }) => ({
			...(await createSessionFromServices({ services: shared, sessionManager, sessionStartEvent, noTools: "all" })),
			services: shared,
			diagnostics: [],
		});
		const runtime = await createAgentSessionRuntime(factory, {
			cwd,
			agentDir,
			sessionManager: SessionManager.inMemory(cwd),
		});
		for (let switches = 0; switches < 5; switches++) await runtime.newSession();
		expect(releases).toBe(0);
		await runtime.dispose();
		expect(releases).toBe(1);
		// The model runtime was passed in, so its watcher stays with the caller.
		expect(watchers.live).toBe(1);
		callerOwned.dispose?.();
		expect(watchers.live).toBe(0);
	}, 60_000);

	it("release services built for a creation that failed, and keep the current ones", async () => {
		const { cwd, agentDir } = folders();
		const watchers = countWatchers();
		const factory = createCliRuntimeFactory({
			parsed: parseArgs(["--no-mcp", "--no-skills", "--no-prompt-templates", "--no-themes"]),
			cwd,
			folderTrust: () => ({ state: "trusted", root: cwd }),
			requireTrust: false,
			getAppMode: () => "print",
			skillResourceSnapshot: undefined,
		});
		let fail = false;
		const failing: CreateAgentSessionRuntimeFactory = async (options) => {
			if (!fail) return factory(options);
			const spy = vi.spyOn(SessionManager.prototype, "buildSessionContext").mockImplementationOnce(() => {
				throw new Error("creation failed");
			});
			try {
				return await factory(options);
			} finally {
				spy.mockRestore();
			}
		};
		const runtime = await createAgentSessionRuntime(failing, {
			cwd,
			agentDir,
			sessionManager: SessionManager.inMemory(cwd),
		});
		const current = runtime.services;
		fail = true;
		await expect(runtime.newSession()).rejects.toThrow("creation failed");
		expect(runtime.services).toBe(current);
		expect(watchers.live).toBe(1);
		await runtime.dispose();
		expect(watchers.live).toBe(0);
	}, 60_000);
});

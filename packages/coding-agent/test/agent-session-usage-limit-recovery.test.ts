import { existsSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Agent } from "@octocodeai/octocode-agent-core";
import { type AssistantMessage, createAssistantMessageEventStream } from "@octocodeai/octocode-ai/compat";
import { getBuiltinModel } from "@octocodeai/octocode-ai/providers/all";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AgentSession } from "../src/core/agent-session.ts";
import { resetFallbackExhaustion } from "../src/core/agent-session/retry-fallback.ts";
import { resetClock } from "@octocodeai/octocode-common/time";
import { USAGE_LIMIT_ENTRY, usageLimitRecord } from "../src/core/agent-session/usage-limit-facts.ts";
import { AuthStorage } from "../src/core/auth-storage.ts";
import { noOpUIContext } from "../src/core/features/runner/context.ts";
import type { SessionUI } from "../src/core/features/types.ts";
import { SessionManager } from "../src/core/session-manager.ts";
import { SettingsManager } from "../src/core/settings-manager.ts";
import { createModelRegistry, getModelRuntime } from "./model-runtime-test-utils.ts";
import { createTestFeaturesResult, createTestResourceLoader } from "./utilities.ts";

const PRIMARY = "claude-sonnet-4-5";
/** A Codex-style usage limit whose body names the reset: an hour from the request. */
const LIMIT =
	'429 {"error":{"type":"usage_limit_reached","message":"The usage limit has been reached","resets_in_seconds":3600}}';
const HOUR = 3_600_000;
const GRACE = 30_000;

function reply(model: string, provider: string, overrides?: Partial<AssistantMessage>): AssistantMessage {
	return {
		role: "assistant",
		content: [{ type: "text", text: overrides?.stopReason === "error" ? "" : "Success" }],
		api: "anthropic-messages",
		provider,
		model,
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "stop",
		timestamp: Date.now(),
		...overrides,
	};
}

interface Dialog {
	title: string;
	options: string[];
}

describe("AgentSession usage-limit recovery (F4)", () => {
	let session: AgentSession | undefined;
	let tempDir: string;

	beforeEach(() => {
		resetFallbackExhaustion();
		tempDir = join(tmpdir(), `octocode-usage-limit-test-${Date.now()}-${Math.random()}`);
		mkdirSync(tempDir, { recursive: true });
	});

	afterEach(() => {
		session?.dispose();
		session = undefined;
		vi.useRealTimers();
		if (existsSync(tempDir)) rmSync(tempDir, { recursive: true });
	});

	/** The primary model fails on `failures` usage limits, then answers; every other model answers. */
	async function createSession(
		options: {
			failures?: number;
			/** The usage-limit error; default `LIMIT` (resets in an hour). */
			limit?: string;
			retry?: Record<string, unknown>;
			openai?: boolean;
			featuresResult?: Awaited<ReturnType<typeof createTestFeaturesResult>>;
		} = {},
	) {
		const calls: string[] = [];
		/** When each request went out, on the (possibly fake) clock. */
		const times: number[] = [];
		let failures = options.failures ?? Number.POSITIVE_INFINITY;
		const agent = new Agent({
			getApiKey: () => "test-key",
			initialState: { model: getBuiltinModel("anthropic", PRIMARY), systemPrompt: "Test", tools: [] },
			streamFn: (model) => {
				calls.push(`${model.provider}/${model.id}`);
				times.push(Date.now());
				const stream = createAssistantMessageEventStream();
				queueMicrotask(() => {
					if (model.id === PRIMARY && failures-- > 0) {
						const msg = reply(model.id, model.provider, { stopReason: "error", errorMessage: options.limit ?? LIMIT });
						stream.push({ type: "start", partial: msg });
						stream.push({ type: "error", reason: "error", error: msg });
					} else {
						const msg = reply(model.id, model.provider);
						stream.push({ type: "start", partial: msg });
						stream.push({ type: "done", reason: "stop", message: msg });
					}
				});
				return stream;
			},
		});
		const settingsManager = SettingsManager.create(tempDir, tempDir);
		const authStorage = AuthStorage.create(join(tempDir, "auth.json"));
		const modelRegistry = await createModelRegistry(authStorage, tempDir);
		await authStorage.modify("anthropic", async () => ({ type: "api_key", key: "test-key" }));
		if (options.openai) await authStorage.modify("openai", async () => ({ type: "api_key", key: "test-key" }));
		settingsManager.applyOverrides({ retry: { enabled: true, maxRetries: 0, baseDelayMs: 1, ...options.retry } });
		session = new AgentSession({
			agent,
			sessionManager: SessionManager.inMemory(),
			settingsManager,
			cwd: tempDir,
			modelRuntime: getModelRuntime(modelRegistry),
			resourceLoader: createTestResourceLoader({ featuresResult: options.featuresResult }),
		});
		const entries: unknown[] = [];
		session.subscribe((event) => {
			if (event.type === "entry_appended") entries.push(event.entry);
		});
		return { session, calls, times, entries, settingsManager };
	}

	/** A terminal UI whose usage-limit choice answers with the option `pick` selects. */
	async function bindTerminal(target: AgentSession, pick: (options: string[]) => string | undefined) {
		const dialogs: Dialog[] = [];
		const statuses: Array<string | undefined> = [];
		const editor: string[] = [];
		const ui: SessionUI = {
			...noOpUIContext,
			select: async (title, options) => {
				dialogs.push({ title, options });
				return pick(options);
			},
			setStatus: (key, text) => {
				if (key === "usage-limit") statuses.push(text);
			},
			setEditorText: (text) => editor.push(text),
		};
		await target.bindFeatures({ uiContext: ui, mode: "tui" });
		return { dialogs, statuses, editor };
	}

	describe("unattended (V7)", () => {
		it("fails at once with retry.maxUsageWaitMs 0, naming the reset, and records it for a parent", async () => {
			const created = await createSession();
			const before = Date.now();
			await created.session.prompt("Test");

			expect(created.calls).toEqual([`anthropic/${PRIMARY}`]);
			const outcome = created.session.lastRunOutcome;
			expect(outcome?.status).toBe("failed");
			expect(outcome?.errorMessage).toContain("usage_limit_reached");
			expect(outcome?.errorMessage).toContain(`Usage limit on anthropic resets ${resetClock(before + HOUR, before)}`);
			expect(outcome?.errorMessage).toContain("Set retry.maxUsageWaitMs to wait for it.");
			const record = created.entries.map(usageLimitRecord).find(Boolean);
			expect(record).toMatchObject({ provider: "anthropic", model: `anthropic/${PRIMARY}` });
			expect(record?.resetsAt).toBeGreaterThanOrEqual(before + HOUR);
			expect(record?.resetsAt).toBeLessThanOrEqual(Date.now() + HOUR);
			expect(
				created.session.sessionManager
					.getEntries()
					.some((entry) => entry.type === "custom" && entry.customType === USAGE_LIMIT_ENTRY),
			).toBe(true);
		});

		it("waits for a reset within retry.maxUsageWaitMs, then continues the turn on the same model", async () => {
			vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval", "Date"] });
			// A minute's reset: the wait polls for a stop four times a second, so a short span keeps the fake clock quick.
			const limit = LIMIT.replace('"resets_in_seconds":3600', '"resets_in_seconds":60');
			const created = await createSession({ failures: 1, limit, retry: { maxUsageWaitMs: 2 * HOUR } });
			const running = created.session.prompt("Test");
			// The run prepares on real I/O first: step the clock until the resumed request goes out.
			for (let step = 0; step < 300 && created.calls.length < 2; step++) await vi.advanceTimersByTimeAsync(1_000);
			await running;
			expect(created.calls).toEqual([`anthropic/${PRIMARY}`, `anthropic/${PRIMARY}`]);
			expect(created.times[1] - created.times[0]).toBeGreaterThanOrEqual(60_000 + GRACE - 1_000);
			expect(created.session.lastRunOutcome?.status).toBe("completed");
		});

		it("fails when the reset is later than retry.maxUsageWaitMs", async () => {
			const created = await createSession({ retry: { maxUsageWaitMs: 60_000 } });
			await created.session.prompt("Test");
			expect(created.calls).toEqual([`anthropic/${PRIMARY}`]);
			expect(created.session.lastRunOutcome?.errorMessage).toContain("later than retry.maxUsageWaitMs");
		});

		it("a stop ends the wait without another request", async () => {
			vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval", "Date"] });
			const created = await createSession({ failures: 1, retry: { maxUsageWaitMs: 2 * HOUR } });
			const running = created.session.prompt("Test");
			await vi.advanceTimersByTimeAsync(60_000);
			const stopping = created.session.abort();
			await vi.advanceTimersByTimeAsync(1_000);
			await Promise.all([running, stopping]);
			await vi.advanceTimersByTimeAsync(2 * HOUR);
			expect(created.calls).toEqual([`anthropic/${PRIMARY}`]);
		});
	});

	describe("interactive (V6)", () => {
		it("offers the choice; wait arms a resume at reset + 30 s that continues the turn", async () => {
			vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval", "Date"] });
			const created = await createSession({ failures: 1 });
			const terminal = await bindTerminal(created.session, (options) => options.find((o) => o.startsWith("Wait")));
			const before = Date.now();
			await created.session.prompt("Test");

			expect(terminal.dialogs).toHaveLength(1);
			const [dialog] = terminal.dialogs;
			expect(dialog.title).toBe(`Usage limit on anthropic — resets ${resetClock(before + HOUR, before)} (in 1h)`);
			expect(dialog.options).toEqual([
				`Wait and resume at ${resetClock(before + HOUR + GRACE, before)}`,
				"Pick a model (/model)",
				"Stop",
			]);
			expect(terminal.statuses).toEqual([
				`Usage limit on anthropic · resumes ${resetClock(before + HOUR + GRACE, before)}`,
			]);
			// No second request yet; at reset + 30 s the turn continues.
			await vi.advanceTimersByTimeAsync(HOUR);
			expect(created.calls).toEqual([`anthropic/${PRIMARY}`]);
			await vi.advanceTimersByTimeAsync(GRACE + 1_000);
			await vi.waitFor(() => expect(created.calls).toHaveLength(2));
			await created.session.waitForIdle();
			expect(terminal.statuses.at(-1)).toBeUndefined();
			const lastUser = created.session.messages.filter((m) => m.role === "user").at(-1);
			expect(JSON.stringify(lastUser?.content)).toContain("Continue");
		});

		it("Esc stops without a timer", async () => {
			vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval", "Date"] });
			const created = await createSession({ failures: 1 });
			const terminal = await bindTerminal(created.session, () => undefined);
			await created.session.prompt("Test");
			expect(terminal.dialogs).toHaveLength(1);
			expect(terminal.statuses).toEqual([]);
			await vi.advanceTimersByTimeAsync(2 * HOUR);
			expect(created.calls).toEqual([`anthropic/${PRIMARY}`]);
		});

		it("a new prompt cancels an armed wait", async () => {
			vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval", "Date"] });
			const created = await createSession({ failures: 1 });
			const terminal = await bindTerminal(created.session, (options) => options.find((o) => o.startsWith("Wait")));
			await created.session.prompt("Test");
			await created.session.prompt("Something else");
			expect(terminal.statuses.at(-1)).toBeUndefined();
			await vi.advanceTimersByTimeAsync(2 * HOUR);
			expect(created.calls).toEqual([`anthropic/${PRIMARY}`, `anthropic/${PRIMARY}`]);
		});

		it("switches to a connected model of another provider and can save it as a fallback", async () => {
			const created = await createSession({ openai: true });
			const terminal = await bindTerminal(created.session, (options) =>
				options.find((o) => o.endsWith("retry.fallbackModels")),
			);
			await created.session.prompt("Test");
			const target = created.session.model;
			expect(target?.provider).toBe("openai");
			const name = `${target?.provider}/${target?.id}`;
			expect(terminal.dialogs[0].options).toContain(`Switch to ${name} (billed per token)`);
			expect(created.calls).toEqual([`anthropic/${PRIMARY}`, name]);
			expect(created.settingsManager.getRetryFallbackModels()).toEqual([name]);
		});

		it("pick puts /model in the editor and ends the turn", async () => {
			const created = await createSession();
			const terminal = await bindTerminal(created.session, (options) => options.find((o) => o.startsWith("Pick")));
			await created.session.prompt("Test");
			expect(terminal.editor).toEqual(["/model"]);
			expect(created.calls).toEqual([`anthropic/${PRIMARY}`]);
		});

		it("reaches /web as an answerable dialog, and a remote answer closes the terminal's", async () => {
			const started: Array<{ id?: string; kind: string; title?: string; options?: string[] }> = [];
			const featuresResult = await createTestFeaturesResult([
				(api) => {
					api.bus.on("ui_prompt_start", (event) => void started.push(event));
				},
			]);
			const created = await createSession({ featuresResult });
			// The terminal's dialog stays open until the broker closes it for the remote answer.
			const ui: SessionUI = {
				...noOpUIContext,
				select: (_title, _options, opts) =>
					new Promise((resolve) => opts?.signal?.addEventListener("abort", () => resolve(undefined), { once: true })),
			};
			await created.session.bindFeatures({ uiContext: ui, mode: "tui" });
			const running = created.session.prompt("Test");
			await vi.waitFor(() => expect(started).toHaveLength(1));
			expect(started[0]).toMatchObject({ kind: "select", options: expect.arrayContaining(["Stop"]) });
			expect(started[0].title).toMatch(/^Usage limit on anthropic — resets /);
			expect(created.session.answerDialog(started[0].id ?? "", { choice: "Stop" })).toEqual({ ok: true });
			await running;
			expect(created.calls).toEqual([`anthropic/${PRIMARY}`]);
		});
	});
});

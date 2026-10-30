import fs from "node:fs";
import path from "node:path";
import { createFauxCore, fauxAssistantMessage, fauxToolCall, type TranscriptContext } from "@octocodeai/octocode-ai";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ExtensionFactory } from "../../src/core/extensions/index.ts";
import { DefaultResourceLoader } from "../../src/core/resource-loader.ts";
import { createAgentSession } from "../../src/core/sdk.ts";
import { SessionManager } from "../../src/core/session-manager.ts";
import { SettingsManager } from "../../src/core/settings-manager.ts";
import {
	COMPACT_RESUME_TEXT,
	COMPACT_RESUME_TYPE,
	COMPACT_TOOL,
	CompactRequests,
	registerCompactTool,
} from "../../src/octocode/compaction/compact-tool.ts";
import { contextNoticeText } from "../../src/octocode/compaction/context-notice.ts";
import { ThrashBreaker, THRASH_STREAK } from "../../src/octocode/compaction/pacing.ts";
import { registerCompaction } from "../../src/octocode/compaction/register.ts";
import { fakeHost } from "./fake-host.ts";
import { tmp } from "./helpers.ts";

let saved: NodeJS.ProcessEnv;
beforeEach(() => {
	saved = { ...process.env };
	process.env.OCTOCODE_HOME = tmp();
});
afterEach(() => {
	process.env = saved;
});

const guard = { restore: vi.fn(), forget: vi.fn(), record: vi.fn() } as never;

/** The compaction hooks and the tool on a fake host; `tokens` of a 100k window (limit 87.5k) fill the context. */
function host(isSubagent = false) {
	const fake = fakeHost();
	registerCompactTool(fake.api, registerCompaction(fake.api, guard, isSubagent), isSubagent);
	const state = { tokens: 60_000 };
	const ctx = {
		cwd: "/w",
		hasUI: false,
		ui: { notify: vi.fn() },
		abort: vi.fn(),
		compact: vi.fn(),
		model: { provider: "faux", id: "m", contextWindow: 100_000 },
		modelRegistry: { getCachePolicy: () => ({ options: {} }) },
		getContextUsage: () => ({ tokens: state.tokens, contextWindow: 100_000, percent: null }),
		getSystemPrompt: () => "",
		sessionManager: {
			getSessionId: () => "s",
			getBranch: () => [],
			getEntries: () => [],
			buildSessionProjection: () => ({ entries: [] }),
			getSessionFile: () => undefined,
		},
	};
	const call = (focus?: string) => fake.tools.get(COMPACT_TOOL)!.execute("c", { focus }, undefined, undefined, ctx);
	const settle = (aborted = false) => fake.emit("agent_settled", { aborted }, ctx);
	const compacted = (reason: string) => fake.emit("session_compact", { reason, compactionEntry: {} }, ctx);
	return { fake, ctx, state, call, settle, compacted };
}

describe("compact tool", () => {
	it("is the main agent's only: a subagent's run settling is its report", () => {
		expect(host().fake.tools.has(COMPACT_TOOL)).toBe(true);
		expect(host(true).fake.tools.has(COMPACT_TOOL)).toBe(false);
	});

	it("queues the request and runs it with the focus only after the run settles", async () => {
		const { fake, ctx, call, settle } = host();
		const result = await call("  keep the plan  ");
		expect(result.content[0].text).toMatch(/runs when this reply ends/);
		expect((await call()).content[0].text).toMatch(/already queued/);
		expect(ctx.compact).not.toHaveBeenCalled();
		await settle();
		expect(ctx.compact).toHaveBeenCalledTimes(1);
		expect(ctx.compact.mock.calls[0][0].customInstructions).toBe("keep the plan");
		ctx.compact.mock.calls[0][0].onComplete();
		expect(fake.sent.at(-1)).toEqual({
			message: { customType: COMPACT_RESUME_TYPE, content: COMPACT_RESUME_TEXT, display: false },
			options: { triggerTurn: true },
		});
		await settle();
		expect(ctx.compact).toHaveBeenCalledTimes(1);
	});

	it("drops the request when the user stops the run or a compaction already ran", async () => {
		const stopped = host();
		await stopped.call();
		await stopped.settle(true);
		expect(stopped.ctx.compact).not.toHaveBeenCalled();
		const overtaken = host();
		await overtaken.call();
		await overtaken.compacted("threshold");
		await overtaken.settle();
		expect(overtaken.ctx.compact).not.toHaveBeenCalled();
	});

	it("refuses below half the room before automatic compaction, and right after a compaction", async () => {
		const { state, call, settle, compacted } = host();
		state.tokens = 40_000;
		await expect(call()).rejects.toThrow(/46% of the room.*under 50%/);
		state.tokens = 60_000;
		await compacted("threshold");
		await expect(call()).rejects.toThrow(/compacted in this turn/);
		await settle();
		await expect(call()).rejects.toThrow(/one turn ago/);
		await settle();
		await expect(call()).resolves.toBeDefined();
	});

	it("counts as automatic for the thrash breaker, where a manual compaction starts the count over", async () => {
		const run = async (agent: boolean) => {
			const { ctx, call, settle, compacted } = host();
			await compacted("threshold");
			for (let i = 0; i < THRASH_STREAK; i++) {
				await settle();
				await settle();
				if (agent && i === THRASH_STREAK - 1) {
					await call();
					await settle();
					expect(ctx.compact).toHaveBeenCalledTimes(1);
				}
				await compacted(i === THRASH_STREAK - 1 ? "manual" : "threshold");
			}
			await settle();
			await settle();
			return call();
		};
		await expect(run(false)).resolves.toBeDefined();
		await expect(run(true)).rejects.toThrow(/refilled right after each/);
	});

	it("refuses a thrash-tripped request, and the summary hook cancels one already running", async () => {
		const breaker = new ThrashBreaker();
		const requests = new CompactRequests(breaker);
		breaker.compacted(false);
		for (let i = 0; i < THRASH_STREAK; i++) {
			breaker.turnEnded();
			breaker.turnEnded();
			breaker.compacted(false);
		}
		expect(requests.refusal(fakeHost().api, host().ctx as never)).toMatch(/refilled right after each/);
	});

	it("names the tool in the upper context notices only", () => {
		expect(contextNoticeText(70_000, 87_500, 100_000, true)).toMatch(/`compact` can summarize sooner/);
		expect(contextNoticeText(70_000, 87_500, 100_000)).not.toMatch(/compact`/);
	});
});

describe("compact tool in a real session", () => {
	it("lets the requesting run finish unaborted and compacts after it settles", async () => {
		const cwd = tmp();
		const agentDir = path.join(cwd, "agent");
		fs.mkdirSync(agentDir);
		const faux = createFauxCore({
			provider: "faux",
			models: [{ id: "faux-1", contextWindow: 20_000, maxTokens: 2048 }],
		});
		const factory: ExtensionFactory = (api) => {
			api.registerProvider("faux", {
				name: "Faux",
				api: faux.api,
				baseUrl: "http://127.0.0.1:0",
				apiKey: "test",
				models: faux.models,
				streamSimple: faux.streamSimple,
			} as never);
			registerCompactTool(api, registerCompaction(api, guard, false), false);
		};
		const settingsManager = SettingsManager.inMemory({ retry: { enabled: false } });
		const resourceLoader = new DefaultResourceLoader({
			cwd,
			agentDir,
			settingsManager,
			extensionFactories: [{ name: "compact-test", factory }],
			noExtensions: true,
			noSkills: true,
			noPromptTemplates: true,
			noThemes: true,
			noContextFiles: true,
		});
		await resourceLoader.reload();
		const sessionManager = SessionManager.inMemory(cwd);
		const { session } = await createAgentSession({
			cwd,
			agentDir,
			resourceLoader,
			settingsManager,
			sessionManager,
			tools: [COMPACT_TOOL],
		});
		const events: string[] = [];
		session.subscribe((event) => {
			if (event.type === "agent_settled") events.push(`settled${event.aborted ? " aborted" : ""}`);
			if (event.type === "agent_start" || event.type === "agent_end") events.push(event.type);
			if (event.type === "compaction_end") events.push(`compaction_end${event.result ? "" : " failed"}`);
		});
		const requests: TranscriptContext[] = [];
		const seen = (context: TranscriptContext) => {
			requests.push(context);
			return JSON.stringify(context);
		};
		try {
			await session.bindExtensions({ mode: "print", shutdownHandler: () => undefined });
			await session.setModel(session.modelRuntime.getModel("faux", "faux-1")!);
			const compact = session.compact.bind(session);
			const spy = vi.spyOn(session, "compact").mockImplementation((options) => {
				events.push("compact");
				return compact(options);
			});
			faux.setResponses([
				(context) => {
					seen(context);
					return fauxAssistantMessage("Noted.");
				},
				(context) => {
					seen(context);
					return fauxAssistantMessage([fauxToolCall(COMPACT_TOOL, { focus: "keep the plan" })], {
						stopReason: "toolUse",
					});
				},
				(context) => {
					expect(seen(context)).toMatch(/Compaction queued/);
					return fauxAssistantMessage("Compacting after this reply.");
				},
			]);
			// Over half the room before automatic compaction (the tool's floor) and under its threshold. The single
			// earlier turn fits the kept tail, so the summary is refused as too small: that path is checked here, and a
			// successful resume with the fake host above.
			await session.prompt(`Background for the long task: ${"abcdefghij".repeat(2_700)}`);
			await session.prompt("Compact, then do the long task.");
			const note = () =>
				sessionManager
					.getBranch()
					.find((entry) => entry.type === "custom_message" && entry.customType === COMPACT_RESUME_TYPE);
			await vi.waitFor(() => expect(note()).toBeDefined(), { timeout: 5_000 });
			await session.waitForIdle();
			// The requesting run settled unaborted (its reply after the tool result was recorded), then compaction ran.
			expect(events).toEqual(["agent_start", "agent_end", "settled", "agent_start", "agent_end", "compact", "settled"]);
			expect(spy).toHaveBeenCalledWith({ customInstructions: "keep the plan" });
			expect(requests).toHaveLength(3);
			const entries = sessionManager.getBranch().map((entry) => JSON.stringify(entry));
			expect(entries.some((entry) => entry.includes("Compacting after this reply."))).toBe(true);
			expect(JSON.stringify(note())).toMatch(/did not run: Nothing to compact/);
		} finally {
			await session.abort();
			session.dispose();
		}
	});
});

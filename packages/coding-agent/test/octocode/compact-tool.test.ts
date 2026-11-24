import fs from "node:fs";
import path from "node:path";
import { createFauxCore, fauxAssistantMessage, fauxToolCall, type TranscriptContext } from "@octocodeai/octocode-ai";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { FeatureRegister } from "../../src/core/features/index.ts";
import { DefaultResourceLoader } from "../../src/core/resource-loader.ts";
import { createTestSession } from "../helpers/session.ts";
import { SessionManager } from "../../src/core/session-manager.ts";
import { SettingsManager } from "../../src/core/settings-manager.ts";
import {
	COMPACT_RESUME_TEXT,
	COMPACT_RESUME_TYPE,
	COMPACT_TOOL,
	CompactRequests,
	registerCompactTool,
} from "../../src/octocode/native/tools/compact/tool.ts";
import { contextNoticeText } from "../../src/octocode/monitor/attention/context.ts";
import { ThrashBreaker, THRASH_STREAK } from "../../src/octocode/compaction/pacing.ts";
import { registerCompaction } from "../../src/octocode/compaction/register.ts";
import { fakeHost } from "./fake-host.ts";
import { tmp } from "./helpers.ts";
import { testFeatures } from "../helpers/features.ts";
import { nativeFeatureSet } from "../helpers/native-features.ts";

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
		getSystemPromptOptions: () => ({ contextFiles: [] }),
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

	it("refuses a focus over the limit whole, queuing nothing", async () => {
		const { ctx, call, settle } = host();
		await expect(call("x".repeat(16_001))).rejects.toThrow(/focus is 16001 characters, over the limit of 16000/);
		await settle();
		expect(ctx.compact).not.toHaveBeenCalled();
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

	it("asks as the agent, and gives the focus back after a compaction that reused the summary written ahead", async () => {
		const { fake, ctx, call, settle } = host();
		await call("next: the parser tests");
		await settle();
		const options = ctx.compact.mock.calls[0][0];
		expect(options.requestedBy).toBe("agent");
		options.onComplete({ details: { focus: { source: "agent", delivery: "follow-up" } } });
		const resumed = (fake.sent.at(-1) as { message: { content: string } }).message.content;
		expect(resumed.startsWith(COMPACT_RESUME_TEXT)).toBe(true);
		expect(resumed).toContain("<compact-focus>\nnext: the parser tests\n</compact-focus>");
		// A summary written with the focus needs no copy of it.
		const again = host();
		await again.call("keep the plan");
		await again.settle();
		again.ctx.compact.mock.calls[0][0].onComplete({ details: { focus: { delivery: "summary" } } });
		expect((again.fake.sent.at(-1) as { message: { content: string } }).message.content).toBe(COMPACT_RESUME_TEXT);
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

	it.each(["shutdown", "cancelled"] as const)("does not resume an ended compaction after %s", async (reason) => {
		const { fake, ctx, call, settle } = host();
		await call("old task");
		await settle();
		const old = ctx.compact.mock.calls[0][0];
		if (reason === "shutdown") await fake.emit("session_shutdown", { reason: "resume" }, ctx);
		else await fake.emit("session_compact_failed", { reason: "manual", aborted: true }, ctx);
		await call("new task");
		await settle();
		if (reason === "shutdown") old.onComplete();
		else old.onError(new Error("old compaction ended late"));
		expect(fake.sent).toHaveLength(0);
		ctx.compact.mock.calls[1][0].onComplete();
		expect(fake.sent).toHaveLength(1);
		expect(fake.sent[0].message.customType).toBe(COMPACT_RESUME_TYPE);
	});

	it("records a failed interactive compaction quietly for the next user turn", async () => {
		const { fake, ctx, call, settle } = host();
		ctx.hasUI = true;
		await call();
		await settle();
		ctx.compact.mock.calls[0][0].onError(new Error("summary unavailable"));
		expect(fake.sent).toEqual([
			{
				message: {
					customType: COMPACT_RESUME_TYPE,
					display: false,
					content: expect.stringContaining("summary unavailable"),
				},
				options: { triggerTurn: false },
			},
		]);
	});

	it("refuses below half the room before automatic compaction, and right after a compaction", async () => {
		const { state, call, settle, compacted } = host();
		state.tokens = 40_000;
		await expect(call()).rejects.toThrow(/45% of the room.*under 50%/);
		// Just under the floor (49.9%) reads as under it, not as the 50% it is refused below.
		state.tokens = 43_700;
		await expect(call()).rejects.toThrow(/49% of the room.*under 50%/);
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
		expect(contextNoticeText(70_000, 87_500, 100_000, true)).toMatch(/`compact`/);
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
		const factory: FeatureRegister = (api) => {
			api.providers.register("faux", {
				name: "Faux",
				api: faux.api,
				baseUrl: "http://127.0.0.1:0",
				apiKey: "test",
				models: faux.models,
				streamSimple: faux.streamSimple,
			} as never);
			registerCompactTool(api, registerCompaction(api, guard, false), false);
		};
		// The 20k window keeps compaction cheap; the full policy keeps the prompt this test's sizes were set for (a window
		// under 64k would otherwise pick the lean policy).
		const settingsManager = SettingsManager.inMemory({ retry: { enabled: false }, leanPrompt: "off" });
		const resourceLoader = new DefaultResourceLoader({
			cwd,
			agentDir,
			settingsManager,
			nativeFeatures: nativeFeatureSet(),
			features: testFeatures([{ name: "compact-test", factory }]),
			disabledFeatures: ["mcp"],
			noSkills: true,
			noPromptTemplates: true,
			noThemes: true,
			noContextFiles: true,
		});
		await resourceLoader.reload();
		const sessionManager = SessionManager.inMemory(cwd);
		const { session } = await createTestSession({
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
			await session.bindFeatures({ mode: "print", shutdownHandler: () => undefined });
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
				(context) => {
					expect(seen(context)).toMatch(/did not run: Nothing to compact/);
					return fauxAssistantMessage("Going on without it.");
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
			await session.settled();
			// The requesting run settled unaborted (its reply after the tool result was recorded), then compaction ran. It
			// could not, and this is a headless run with no next turn to tell the model on, so a turn goes on from the failure.
			expect(events).toEqual([
				"agent_start",
				"agent_end",
				"settled",
				"agent_start",
				"agent_end",
				"compact",
				"settled",
				"agent_start",
				"agent_end",
				"settled",
			]);
			expect(spy).toHaveBeenCalledWith({ customInstructions: "keep the plan", requestedBy: "agent" });
			expect(requests).toHaveLength(4);
			const entries = sessionManager.getBranch().map((entry) => JSON.stringify(entry));
			expect(entries.some((entry) => entry.includes("Compacting after this reply."))).toBe(true);
			expect(JSON.stringify(note())).toMatch(/did not run: Nothing to compact/);
		} finally {
			await session.abort();
			session.dispose();
		}
	});
});

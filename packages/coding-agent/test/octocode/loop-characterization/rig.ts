import { fauxAssistantMessage, type TranscriptContext } from "@octocodeai/octocode-ai";
import type { AgentTool } from "@octocodeai/octocode-agent-core";
import { Type } from "typebox";
import { expect } from "vitest";
import type { FeatureContext, FeatureSetup } from "../../../src/core/features/index.ts";
import { appendFileSync } from "node:fs";
import type { ShadowDiff, ShadowLoop } from "../../../src/octocode/events/loop/shadow.ts";
import type { LiveLoop } from "../../../src/octocode/events/loop/live.ts";
import type { LiveHandle, LiveHostOptions } from "../../../src/octocode/wake/live-host.ts";
import type { ShadowHandle } from "../../../src/octocode/wake/shadow-host.ts";
import { registerWake } from "../../../src/octocode/wake/register.ts";
import { wakeGateOf, WAKE_TYPE, type Held } from "../../../src/octocode/wake/gate.ts";
import { createHarness, getMessageText, type Harness, type HarnessOptions } from "../../suite/harness.ts";
import { testFeatures } from "../../helpers/features.ts";

/**
 * The shared rig of the loop characterization suite (RFC agent-event-loop R0): a real session on a scripted model with the
 * real wake gate installed (`registerWake`), plus the feature host's `api` so a test drives a producer exactly as its
 * feature does. Every model request is recorded as the lines of the conversation it carried.
 *
 * `OCTOCODE_TEST_EVENT_LOOP=shadow` (or `new`) runs the whole suite with `runtime.eventLoop` set: the event loop then runs
 * beside the gate and its differences land in `Rig.shadowDiffs`; with `OCTOCODE_TEST_SHADOW_DIFF_FILE` set they are also appended
 * to that file, one JSON line each, when the rig is cleaned up.
 */
const EVENT_LOOP_MODE = process.env.OCTOCODE_TEST_EVENT_LOOP as "shadow" | "new" | undefined;

export const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

export interface Rig {
	harness: Harness;
	api: FeatureSetup;
	/** The feature context of the session, as every feature receives it on `session_start`. */
	ctx: FeatureContext;
	/** One entry per model request (summaries excluded): `role:text` per message of the context it was sent with. */
	requests: string[][];
	/** What the shadow event loop found different from the gate in this session (empty unless shadow mode is on). */
	shadowDiffs: ShadowDiff[];
	/** The running shadow loop of this session; `cleanup` ends it, which reports its differences. */
	shadow(): ShadowLoop | undefined;
	/** The running live loop (`runtime.eventLoop: "new"`); the session's shutdown ends it. */
	live(): LiveLoop<Held> | undefined;
	/** The text of a scripted reply that records its request. */
	reply(text: string): (context: TranscriptContext) => ReturnType<typeof fauxAssistantMessage>;
	cleanup(): void;
}

export interface RigOptions extends Omit<HarnessOptions, "features"> {
	/** More features composed after the gate (a producer under test registers itself here). */
	register?: (api: FeatureSetup) => void;
	/** Install the real wake gate (default true). */
	wake?: boolean;
	/** The live loop's store (`new` mode): a test that restarts a session hands the next one the first's. */
	liveStore?: LiveHostOptions["store"];
}

export const contextLines = (context: TranscriptContext): string[] =>
	context.messages.map((message) => `${message.role}:${getMessageText(message)}`);

export const count = (lines: readonly string[], text: string) => lines.filter((line) => line.includes(text)).length;

export async function createRig(options: RigOptions = {}): Promise<Rig> {
	const { register, wake = true, liveStore, ...harnessOptions } = options;
	const shadowDiffs: ShadowDiff[] = [];
	let shadow: ShadowHandle | undefined;
	let liveHandle: LiveHandle | undefined;
	if (EVENT_LOOP_MODE) {
		const ownMode = harnessOptions.settings?.runtime?.eventLoop;
		harnessOptions.settings = {
			...harnessOptions.settings,
			// `new` delivers job exits through the loop's window; the suite pins the unheld gate, so a session that runs
			// `new` has no window unless a case sets one. A case that pins its own mode keeps that mode's default window.
			runtime: {
				eventLoop: EVENT_LOOP_MODE,
				...((ownMode ?? EVENT_LOOP_MODE) === "new" ? { eventWindowSeconds: 0 } : {}),
				...harnessOptions.settings?.runtime,
			},
		};
	}
	// The suite pins the unheld gate, as it pins the loop's window above: a case that holds sets its own window.
	harnessOptions.settings = {
		...harnessOptions.settings,
		subagents: { wakeHoldSeconds: 0, ...harnessOptions.settings?.subagents },
	};
	let captured: FeatureSetup | undefined;
	let context: FeatureContext | undefined;
	const harness = await createHarness({
		...harnessOptions,
		features: testFeatures([
			(api) => {
				captured = api;
				api.bus.on("session_start", (_event, ctx) => void (context = ctx));
				if (wake)
					registerWake(api, {
						shadow: { report: (diff) => shadowDiffs.push(diff), attached: (handle) => void (shadow = handle) },
						live: { attached: (handle) => void (liveHandle = handle), ...(liveStore ? { store: liveStore } : {}) },
					});
				register?.(api);
			},
		]),
	});
	if (!captured) throw new Error("the rig's feature did not register");
	// Emits `session_start`: features connect their session state there (async jobs attach their ports).
	await harness.session.bindFeatures({ mode: "print", shutdownHandler: () => undefined });
	if (!context) throw new Error("the rig never saw session_start");
	const requests: string[][] = [];
	return {
		harness,
		api: captured,
		ctx: context,
		requests,
		shadowDiffs,
		reply: (text) => (context) => {
			requests.push(contextLines(context));
			return fauxAssistantMessage(text);
		},
		shadow: () => shadow?.loop(),
		live: () => liveHandle?.loop(),
		cleanup: () => {
			const loop = shadow?.loop();
			const stats = loop?.stats();
			loop?.end();
			harness.cleanup();
			const file = process.env.OCTOCODE_TEST_SHADOW_DIFF_FILE;
			if (!file || !stats) return;
			const test = expect.getState().currentTestName;
			const lines = [{ test, stats }, ...shadowDiffs.map((diff) => ({ test, ...diff }))];
			appendFileSync(file, `${lines.map((line) => JSON.stringify(line)).join("\n")}\n`);
		},
	};
}

/** A tool that returns once the test calls `release` or the run is aborted; `started` resolves when the model's call began. */
export function blockingTool(name = "slow") {
	let release = () => {};
	let markStarted = () => {};
	const released = new Promise<void>((resolve) => (release = resolve));
	const started = new Promise<void>((resolve) => (markStarted = resolve));
	const tool: AgentTool = {
		name,
		label: name,
		description: "waits for the test",
		parameters: Type.Object({}),
		execute: async (_id, _args, signal) => {
			markStarted();
			await Promise.race([
				released,
				new Promise<void>((resolve) => signal?.addEventListener("abort", () => resolve(), { once: true })),
			]);
			return { content: [{ type: "text", text: `${name}-result` }], details: {} };
		},
	};
	return { tool, release, started };
}

/** The lines of the wake rows (`octocode-wake` entries) on the session's branch, one `kind` list per row. */
export function wakeRows(harness: Harness): string[][] {
	return harness.sessionManager
		.getBranch()
		.filter((entry) => entry.type === "custom" && entry.customType === WAKE_TYPE)
		.map((entry) => ((entry as { data?: { events?: Array<{ kind: string }> } }).data?.events ?? []).map((e) => e.kind));
}

/** The transcript as `role:text` / `custom:text` lines, in order. */
export function branchLines(harness: Harness): string[] {
	return harness.sessionManager.getBranch().map((entry) => {
		if (entry.type === "message") return `${entry.message.role}:${getMessageText(entry.message)}`;
		if (entry.type === "custom_message")
			return `custom:${typeof entry.content === "string" ? entry.content : JSON.stringify(entry.content)}`;
		return entry.type;
	});
}

export { wakeGateOf };

/** Whether the session is running under `runtime.eventLoop: new` (`OCTOCODE_TEST_EVENT_LOOP`), where some pinned old-mode behavior differs on purpose. */
export const IN_NEW_MODE = EVENT_LOOP_MODE === "new";

/**
 * A job exit sent during a compaction is queued and not yet delivered: in the session's own queue for the gate, in the live
 * loop's queues (`runtime.eventLoop: new`, R6).
 */
export function expectExitQueued(rig: Rig) {
	const live = rig.live();
	if (live) expect(Object.values(live.queued()).reduce((sum, each) => sum + each, 0)).toBeGreaterThan(0);
	else expect(rig.harness.session.agent.hasQueuedMessages()).toBe(true);
}

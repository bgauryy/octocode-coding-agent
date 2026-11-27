import { fauxAssistantMessage, type TranscriptContext } from "@octocodeai/octocode-ai";
import type { AgentTool } from "@octocodeai/octocode-agent-core";
import { Type } from "typebox";
import { expect, vi } from "vitest";
import type { FeatureContext, FeatureSetup } from "../../../src/core/features/index.ts";
import type { LiveLoop } from "../../../src/octocode/events/loop/live.ts";
import type { LiveHandle, LiveHostOptions } from "../../../src/octocode/wake/live-host.ts";
import { sessionPhaseOf } from "../../../src/octocode/shared/session-phase.ts";
import { sessionStore } from "../../../src/octocode/wake/live-durable.ts";
import { registerWake } from "../../../src/octocode/wake/register.ts";
import { wakeGateOf, WAKE_TYPE, type Held } from "../../../src/octocode/wake/gate.ts";
import {
	createHarness,
	createTestUiContext,
	getMessageText,
	type Harness,
	type HarnessOptions,
} from "../../suite/harness.ts";
import { testFeatures } from "../../helpers/features.ts";

/**
 * The shared rig of the loop characterization suite (RFC agent-event-loop R0): a real session on a scripted model with the
 * real wake gate installed (`registerWake`), plus the feature host's `api` so a test drives a producer exactly as its
 * feature does. Every model request is recorded as the lines of the conversation it carried.
 */
export const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

export interface Rig {
	harness: Harness;
	api: FeatureSetup;
	/** The feature context of the session, as every feature receives it on `session_start`. */
	ctx: FeatureContext;
	/** One entry per model request (summaries excluded): `role:text` per message of the context it was sent with. */
	requests: string[][];
	/** The running event loop, available once the wake feature starts. */
	live(): LiveLoop<Held> | undefined;
	/** The text of a scripted reply that records its request. */
	reply(text: string): (context: TranscriptContext) => ReturnType<typeof fauxAssistantMessage>;
	cleanup(): void;
}

export interface RigOptions extends Omit<HarnessOptions, "features"> {
	/** Bind the same session hooks as the terminal or print interface. */
	mode?: "print" | "tui";
	/** More features composed after the gate (a producer under test registers itself here). */
	register?: (api: FeatureSetup) => void;
	/** Install the real wake gate (default true). */
	wake?: boolean;
	/** The session's event store: a test that restarts a session hands the next one the first's. */
	liveStore?: LiveHostOptions["store"];
}

export const contextLines = (context: TranscriptContext): string[] =>
	context.messages.map((message) => `${message.role}:${getMessageText(message)}`);

export const count = (lines: readonly string[], text: string) => lines.filter((line) => line.includes(text)).length;

export async function createRig(options: RigOptions = {}): Promise<Rig> {
	const { register, wake = true, liveStore, mode = "print", ...harnessOptions } = options;
	let liveHandle: LiveHandle | undefined;
	// Immediate delivery by default. Window tests supply their own duration.
	harnessOptions.settings = {
		...harnessOptions.settings,
		runtime: { eventWindowSeconds: 0, ...harnessOptions.settings?.runtime },
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
						live: { attached: (handle) => void (liveHandle = handle), ...(liveStore ? { store: liveStore } : {}) },
					});
				register?.(api);
			},
		]),
	});
	if (!captured) throw new Error("the rig's feature did not register");
	// Emits `session_start`: features connect their session state there (async jobs attach their ports).
	await harness.session.bindFeatures({
		mode,
		...(mode === "tui" ? { uiContext: createTestUiContext() } : {}),
		shutdownHandler: () => undefined,
	});
	if (!context) throw new Error("the rig never saw session_start");
	const requests: string[][] = [];
	return {
		harness,
		api: captured,
		ctx: context,
		requests,
		reply: (text) => (context) => {
			requests.push(contextLines(context));
			return fauxAssistantMessage(text);
		},
		live: () => liveHandle?.loop(),
		cleanup: harness.cleanup,
	};
}

/**
 * The session holds a wake it has not delivered: it is idle, its status names one wake about to resume it, and nothing
 * containing `text` has reached the model or the branch. A wake that was sent instead of held has started its run by now.
 */
export async function expectHeld(rig: Rig, text: string): Promise<void> {
	for (let turn = 0; turn < 3; turn++) {
		await new Promise((resolve) => setImmediate(resolve));
		await rig.live()?.pendingHandoff();
		await rig.harness.session.waitForIdle();
	}
	expect(pendingWakes(rig)).toHaveLength(1);
	expect(rig.requests).toHaveLength(0);
	expect(count(branchLines(rig.harness), text)).toBe(0);
}

/** What names a session to its event log, for the session that resumes it. */
export const sessionOf = (rig: Rig) => ({
	cwd: rig.ctx.cwd,
	sessionManager: { getSessionId: () => rig.ctx.sessionManager.getSessionId() },
});

/** The session's own event log holds `owed` events it has not delivered: what a restart of it would find and replay. */
export async function expectLogged(rig: Rig, owed: number): Promise<void> {
	const log = await sessionStore(sessionOf(rig));
	await vi.waitFor(() => expect(log.unread()).toHaveLength(owed));
}

/** Every topic the session's event log recorded for it, delivered or not, oldest first. */
export async function recordedTopics(rig: Rig): Promise<string[]> {
	const log = await sessionStore(sessionOf(rig));
	return log.unread(undefined, 0).map((event) => event.topic);
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

/** The wakes the session holds or has sent whose turn has not begun: what its status shows as about to resume it. */
export const pendingWakes = (rig: Rig): readonly string[] => sessionPhaseOf(rig.api).factsNow().wakes;

/**
 * Resolves once nothing sent to the session is still on its way: no wake is pending, no hand-over is being written and no
 * run is in progress. Call it after the producer under test has finished its own work: a wake that producer sent has then
 * reached the model (`rig.requests`) and the branch, so "it woke nobody" is a statement about a finished producer and not
 * about how long the test slept.
 */
export async function quiet(rig: Rig): Promise<void> {
	for (;;) {
		await vi.waitFor(() => expect(pendingWakes(rig)).toEqual([]), { timeout: 15_000, interval: 5 });
		await rig.live()?.pendingHandoff();
		await rig.harness.session.waitForIdle();
		await new Promise((resolve) => setImmediate(resolve));
		if (pendingWakes(rig).length === 0 && !rig.harness.session.isStreaming) return;
	}
}

/** A completion queued behind the session's compaction lock. */
export function expectExitQueued(rig: Rig) {
	const live = rig.live();
	if (!live) throw new Error("the session has no event loop");
	expect(Object.values(live.queued()).reduce((sum, size) => sum + size, 0)).toBeGreaterThan(0);
}

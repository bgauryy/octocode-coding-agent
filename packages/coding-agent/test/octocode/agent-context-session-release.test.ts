import { createHook } from "node:async_hooks";
import fs from "node:fs";
import path from "node:path";
import { fauxAssistantMessage } from "@octocodeai/octocode-ai";
import { afterAll, describe, expect, it, vi } from "vitest";
import type { Identity } from "../../src/octocode/subagents/process/env.ts";
import { baseEnv, type Fixture, fixture, scriptedSession, withEnv } from "./agent-context/capture.ts";
import { assign, runChild } from "./agent-context/child-run.ts";

/**
 * Harness sessions end as the product ends them: each scripted session's model runtime stops watching the credential
 * file, and its features close the MCP server processes they started. Many sessions in one test worker leave no watcher
 * and no process behind.
 */

const SESSIONS = 10;
const CHILDREN = 3;

/** Live handles by kind, counted from creation to close. An unref'd watcher is invisible to `getActiveResourcesInfo`. */
function trackHandles(kinds: string[]) {
	const live = new Map<number, string>();
	const created = new Map<string, number>();
	const hook = createHook({
		init(asyncId, type) {
			if (!kinds.includes(type)) return;
			live.set(asyncId, type);
			created.set(type, (created.get(type) ?? 0) + 1);
		},
		destroy(asyncId) {
			live.delete(asyncId);
		},
	}).enable();
	const count = (kind: string) => [...live.values()].filter((type) => type === kind).length;
	return { count, created: (kind: string) => created.get(kind) ?? 0, stop: () => hook.disable() };
}

const fixtures: Fixture[] = [];
const handles = trackHandles(["FSEVENTWRAP", "PROCESSWRAP"]);
afterAll(() => {
	handles.stop();
	for (const fx of fixtures.splice(0))
		fs.rmSync(fx.root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

async function oneSession(fx: Fixture, i: number): Promise<void> {
	await withEnv(baseEnv(fx), async () => {
		const { session, faux, end } = await scriptedSession(fx, {});
		try {
			faux.setResponses([fauxAssistantMessage(`ready ${i}`)]);
			await session.prompt(`Say ready (${i}).`);
		} finally {
			await end();
		}
	});
}

function childIdentity(fx: Fixture, i: number) {
	const identity: Identity = {
		id: `child-${i}`,
		role: "implementer",
		parentId: "parent-example",
		parentSession: "parent-session-example",
		scratch: fx.scratch,
		permission: { mode: "workspace", grants: [] },
	};
	return assign({ ...identity, goal: `probe ${i}`, item: `B${i}`, background: true }, `Probe task ${i}.`);
}

/** Waits until the live watcher and process handles are back at `baseline`; spawned processes exit asynchronously. */
async function expectBackTo(baseline: { watchers: number; processes: number }): Promise<void> {
	await vi.waitFor(
		() => {
			expect({ watchers: handles.count("FSEVENTWRAP"), processes: handles.count("PROCESSWRAP") }).toEqual(baseline);
		},
		{ timeout: 10_000, interval: 100 },
	);
	expect(process.getActiveResourcesInfo().filter((kind) => kind === "ProcessWrap")).toHaveLength(baseline.processes);
}

describe("harness sessions release what they start", () => {
	it(`${SESSIONS} scripted sessions and ${CHILDREN} children leave no credential watcher and no process`, async () => {
		const fx = fixture();
		fixtures.push(fx);
		const baseline = { watchers: handles.count("FSEVENTWRAP"), processes: handles.count("PROCESSWRAP") };
		const watchersBefore = handles.created("FSEVENTWRAP");
		const processesBefore = handles.created("PROCESSWRAP");

		for (let i = 1; i <= SESSIONS; i++) await oneSession(fx, i);
		// Not vacuous: every session watched the credential file and started its MCP servers.
		expect(handles.created("FSEVENTWRAP") - watchersBefore).toBeGreaterThanOrEqual(SESSIONS);
		expect(handles.created("PROCESSWRAP") - processesBefore).toBeGreaterThanOrEqual(SESSIONS);
		await expectBackTo(baseline);

		const childWatchersBefore = handles.created("FSEVENTWRAP");
		for (let i = 1; i <= CHILDREN; i++) {
			const run = childIdentity(fx, i);
			const result = await runChild(
				fx,
				run.identity,
				[{ prompt: run.task, reply: `done\nProbed ${i}.` }],
				path.join(fx.scratch, "sessions"),
			);
			expect(result.final).toContain(`Probed ${i}.`);
		}
		expect(handles.created("FSEVENTWRAP") - childWatchersBefore).toBeGreaterThanOrEqual(CHILDREN);
		await expectBackTo(baseline);
	}, 120_000);
});

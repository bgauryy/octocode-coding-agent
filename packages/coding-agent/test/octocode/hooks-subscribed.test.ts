import { describe, expect, it, vi } from "vitest";
import { eventSubscriptions, events } from "../../../db/src/api.ts";
import { sharedAgentDb } from "../../src/storage/database.ts";
import { HOOK_EVENTS } from "../../src/octocode/hooks/catalog.ts";
import { makeSource } from "../../src/octocode/events/source.ts";
import { HOOK_LIFECYCLE_EVENTS } from "../../src/octocode/events/hook-lifecycle.ts";
import { type MatchedHookRun, subscribedDispatch } from "../../src/octocode/hooks/register/subscribed.ts";
import { closeHookSubscribers, hookSubscribersOf } from "../../src/octocode/hooks/register/subscribers.ts";
import type { HookConfig, HookVerdict } from "../../src/octocode/hooks/contracts.ts";
import type { HookSession } from "../../src/octocode/hooks/register/types.ts";
import { registeredWorkspace } from "../../src/storage/workspace-database.ts";
import { tmp } from "./helpers.ts";

const allow: HookVerdict = {};
const deny: HookVerdict = { block: "no" };

function session(events: Record<string, boolean>): HookSession {
	const config = Object.fromEntries(
		HOOK_EVENTS.map((event) => [event, events[event] ? [{ hooks: [{ type: "command", command: "true" }] }] : []]),
	) as unknown as HookConfig;
	return { config, errors: [], root: undefined };
}

const rig = (cwd = tmp()) => ({
	api: {},
	ctx: { cwd, sessionManager: { getSessionId: () => "hooks-session" } },
});

const workspaceOf = (cwd: string) => registeredWorkspace(cwd, sharedAgentDb()).id;
const logged = (cwd: string) => events.lastSeq(sharedAgentDb().db, workspaceOf(cwd));

describe("hook runs as events", () => {
	it("lists the same lifecycle events as the hook catalog", () => {
		expect([...HOOK_LIFECYCLE_EVENTS].sort()).toEqual([...HOOK_EVENTS].sort());
	});

	it("runs each dispatch once through its subscription and keeps the verdict, a deny too", async () => {
		const cwd = tmp();
		const { api, ctx } = rig(cwd);
		let calls = 0;
		const direct: MatchedHookRun = async (_ctx, event) => {
			calls++;
			return event === "PreToolUse" ? deny : allow;
		};
		const dispatch = subscribedDispatch(api, session({ PreToolUse: true, Stop: true }), direct);
		expect(await dispatch(ctx as never, "PreToolUse", ["bash"], () => ({}))).toBe(deny);
		expect(await dispatch(ctx as never, "Stop", [], () => ({}))).toBe(allow);
		expect(await dispatch(ctx as never, "PreToolUse", ["bash"], () => ({}))).toBe(deny);
		expect(calls).toBe(3);
		const rows = (event: string) =>
			eventSubscriptions.forSubscriber(
				sharedAgentDb().db,
				workspaceOf(cwd),
				`hook:run:${event}:hooks:hooks-session`,
				Date.now(),
			);
		expect(rows("PreToolUse")).toHaveLength(1);
		expect(rows("Stop")).toHaveLength(1);
		expect(JSON.parse(rows("Stop")[0].action)).toMatchObject({ type: "hook", kinds: ["command"] });
		expect(rows("PreToolUse")[0].offset_seq).toBeGreaterThan(0);
		await closeHookSubscribers(api);
	});

	it("replays an orphaned dispatch before starting the resumed caller with the same numeric token", async () => {
		const { api, ctx } = rig();
		const old = await hookSubscribersOf(api, ctx as never);
		const topic = "hook.PreToolUse";
		const unsubscribe = await old.subscribe({ hook: "run:PreToolUse", topic, handle: () => {} });
		unsubscribe();
		const stored = await old.publish({
			topic,
			key: "hook:PreToolUse:1",
			at: Date.now(),
			source: makeSource("system", "hooks", "in-process", "proven"),
			payload: { token: 1, names: ["old"], kinds: ["command"] },
			digest: "hook PreToolUse",
		});
		await closeHookSubscribers(api);
		const direct = vi.fn<MatchedHookRun>(async () => {
			const [row] = eventSubscriptions.forSubscriber(
				sharedAgentDb().db,
				workspaceOf(ctx.cwd),
				"hook:run:PreToolUse:hooks:hooks-session",
				Date.now(),
			);
			expect(row.offset_seq).toBe(stored.seq);
			return deny;
		});
		const resumed = subscribedDispatch(api, session({ PreToolUse: true }), direct);
		expect(await resumed(ctx as never, "PreToolUse", ["new"], () => ({}))).toBe(deny);
		expect(direct).toHaveBeenCalledOnce();
		await closeHookSubscribers(api);
	});

	it("passes a thrown run to its caller and writes nothing without a configured hook", async () => {
		const cwd = tmp();
		const { api, ctx } = rig(cwd);
		const direct: MatchedHookRun = async (_ctx, event) => {
			if (event === "Stop") throw new Error("boom");
			return allow;
		};
		const dispatch = subscribedDispatch(api, session({ Stop: true }), direct);
		await expect(dispatch(ctx as never, "Stop", [], () => ({}))).rejects.toThrow("boom");
		const before = logged(cwd);
		expect(await dispatch(ctx as never, "PreToolUse", ["bash"], () => ({}))).toEqual({});
		expect(logged(cwd)).toBe(before);
		await closeHookSubscribers(api);
	});

	it("enforces a gate exactly once when registration fails and retries subscribing on the next call", async () => {
		const { api, ctx } = rig();
		const subscribers = await hookSubscribersOf(api, ctx as never);
		const register = vi.spyOn(subscribers, "subscribe").mockImplementationOnce(() => {
			throw new Error("hook subscription unavailable");
		});
		const direct = vi.fn<MatchedHookRun>(async () => deny);
		const dispatch = subscribedDispatch(api, session({ PreToolUse: true }), direct);
		for (let i = 0; i < 2; i++) {
			expect(await dispatch(ctx as never, "PreToolUse", ["bash"], () => ({}))).toBe(deny);
		}
		expect(register).toHaveBeenCalledTimes(2);
		expect(direct).toHaveBeenCalledTimes(2);
		expect(logged(ctx.cwd)).toBeGreaterThan(0);
		await closeHookSubscribers(api);
	});

	it("shares registration across overlapping gates while returning each caller's own verdict", async () => {
		const { api, ctx } = rig();
		const subscribers = await hookSubscribersOf(api, ctx as never);
		const register = vi.spyOn(subscribers, "subscribe");
		const dispatch = subscribedDispatch(api, session({ PreToolUse: true }), async (_ctx, _event, input) => ({
			context: String(input().id),
		}));
		const ids = ["first", "second", "third"];
		const verdicts = await Promise.all(ids.map((id) => dispatch(ctx as never, "PreToolUse", ["bash"], () => ({ id }))));
		expect(verdicts.map(({ context }) => context)).toEqual(ids);
		expect(register).toHaveBeenCalledOnce();
		await closeHookSubscribers(api);
	});
});

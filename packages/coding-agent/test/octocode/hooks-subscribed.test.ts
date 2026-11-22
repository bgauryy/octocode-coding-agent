import { describe, expect, it } from "vitest";
import { eventSubscriptions, events } from "../../../db/src/api.ts";
import { sharedAgentDb } from "../../src/storage/database.ts";
import { HOOK_EVENTS } from "../../src/octocode/hooks/catalog.ts";
import { HOOK_LIFECYCLE_EVENTS } from "../../src/octocode/events/hook-lifecycle.ts";
import { subscribedDispatch } from "../../src/octocode/hooks/register/subscribed.ts";
import { closeHookSubscribers } from "../../src/octocode/hooks/register/subscribers.ts";
import type { HookConfig, HookVerdict } from "../../src/octocode/hooks/contracts.ts";
import type { Dispatch, HookSession } from "../../src/octocode/hooks/register/types.ts";
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

const rig = (mode: "old" | "new", cwd = tmp()) => ({
	api: { settings: { get: () => ({ runtime: { eventLoop: mode } }) } },
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
		const { api, ctx } = rig("new", cwd);
		let calls = 0;
		const direct: Dispatch = async (_ctx, event) => {
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

	it("passes a thrown run to its caller and writes nothing without a configured hook", async () => {
		const cwd = tmp();
		const { api, ctx } = rig("new", cwd);
		const direct: Dispatch = async (_ctx, event) => {
			if (event === "Stop") throw new Error("boom");
			return allow;
		};
		const dispatch = subscribedDispatch(api, session({ Stop: true }), direct);
		await expect(dispatch(ctx as never, "Stop", [], () => ({}))).rejects.toThrow("boom");
		const before = logged(cwd);
		expect(await dispatch(ctx as never, "PreToolUse", ["bash"], () => ({}))).toBe(allow);
		expect(logged(cwd)).toBe(before);
		await closeHookSubscribers(api);
	});

	it("calls the runner directly and writes no event in old mode", async () => {
		const cwd = tmp();
		const { api, ctx } = rig("old", cwd);
		let calls = 0;
		const direct: Dispatch = async () => {
			calls++;
			return deny;
		};
		const dispatch = subscribedDispatch(api, session({ PreToolUse: true }), direct);
		expect(await dispatch(ctx as never, "PreToolUse", ["bash"], () => ({}))).toBe(deny);
		expect(calls).toBe(1);
		expect(logged(cwd)).toBe(0);
	});
});

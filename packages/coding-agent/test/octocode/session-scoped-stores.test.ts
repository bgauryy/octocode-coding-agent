import { describe, expect, it } from "vitest";
import { PermissionTrail } from "../../src/octocode/permission/ask/trail.ts";
import { chipOf } from "../../src/octocode/permission/chip-store.ts";
import type { PermissionMode } from "../../src/octocode/permission/mode.ts";
import { liveAgentsOf, publishLiveAgents } from "../../src/octocode/shared/team-spend.ts";
import { asSetup } from "./fake-host.ts";

/**
 * RFC 2026-11-23-app-state, D5 and T5: a process can host several sessions (an ACP host, an SDK embedder), so what one
 * session's footer reads (its permission chip, its live descendants for `Σ`) belongs to that session's feature instance,
 * as `runningWorkOf` does, never to the process. Before T5 both were module constants: the session painted last set the
 * chip every footer showed, and one session's empty team cleared the other's live agents from its `Σ`.
 */

const ui = { setStatus: () => undefined };
const trail = (api: object, mode: PermissionMode) =>
	new PermissionTrail({
		api: api as never,
		isSubagent: false,
		nonce: "",
		mode: () => mode,
		chipMode: () => mode,
		agent: () => "main",
		stderr: () => undefined,
	});

describe("two sessions in one process", () => {
	it("keep their own permission chip", () => {
		const first = asSetup({ appendEntry: () => undefined });
		const second = asSetup({ appendEntry: () => undefined });
		trail(first, "manual").paint({ hasUI: true, ui: ui as never, mode: "tui" });
		trail(second, "full").paint({ hasUI: true, ui: ui as never, mode: "tui" });
		expect(chipOf(first).getState().chip?.mode).toBe("manual");
		expect(chipOf(second).getState().chip?.mode).toBe("full");
		expect(chipOf(first)).toBe(chipOf(first));
	});

	it("keep their own live agents for the footer's total", () => {
		const first = {};
		const second = {};
		publishLiveAgents(liveAgentsOf(first), [{ id: "sly-crab", parentId: "me", cost: 1, unpriced: false }]);
		publishLiveAgents(liveAgentsOf(second), []);
		expect(
			liveAgentsOf(first)
				.getState()
				.live.map((agent) => agent.id),
		).toEqual(["sly-crab"]);
		expect(liveAgentsOf(second).getState().live).toEqual([]);
	});
});

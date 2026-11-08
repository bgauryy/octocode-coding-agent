/** @vitest-environment jsdom */
import { act, cleanup, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Snapshot } from "@octocodeai/octocode-contracts/snapshot";
import { App } from "../src/app/App.tsx";
import { daemonLive } from "../src/app/daemon/live.ts";
import { createBacklogStore } from "../src/app/extension.ts";
import { live } from "../src/app/live/index.ts";
import { CHROME_CSS } from "../src/styles/chrome.ts";
import { FakeSocket, snapshotItem } from "./helpers.ts";

afterEach(cleanup);

describe("Moved view address", () => {
	beforeEach(() => {
		FakeSocket.instances = [];
		vi.stubGlobal("WebSocket", FakeSocket);
		vi.stubGlobal(
			"fetch",
			vi.fn(async () => new Response("{}")),
		);
		history.replaceState(null, "", "#board");
	});
	afterEach(() => vi.unstubAllGlobals());

	it("rewrites #agents to the Profiler's Overview without a history entry", async () => {
		if (!live) throw new Error("live extension");
		const extension = live;
		const snapshot: Snapshot = {
			repo: "r",
			generatedAt: 1,
			states: ["backlog", "todo", "ongoing", "done"],
			idleMs: 1,
			items: [snapshotItem("B1", { title: "x" })],
		};
		const entries = history.length;
		await act(async () => {
			location.hash = "#agents";
			render(
				<App
					backlog={createBacklogStore(snapshot)}
					live={daemonLive(extension, { kind: "session", id: "x" })}
					access="tok"
				/>,
			);
		});
		expect(location.hash).toBe("#profiler?panel=overview");
		expect(history.length).toBeLessThanOrEqual(entries + 1);
	});
});

describe("Top navigation", () => {
	it("wraps its tabs instead of clipping the last label", () => {
		expect(CHROME_CSS).toMatch(/nav\.tabs \{[^}]*flex-wrap: wrap/);
		expect(CHROME_CSS).not.toMatch(/nav\.tabs \{[^}]*overflow-x: auto/);
		expect(CHROME_CSS).toMatch(/\.header-row \{[^}]*flex-wrap: wrap/);
	});
});

/** @vitest-environment jsdom */
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { CachePanel } from "../src/app/live/profiler/CachePanel.tsx";
import { ContextBar } from "../src/app/live/profiler/ContextBar.tsx";
import { agent, request } from "./profiler-fixtures.ts";

afterEach(cleanup);

it("keeps cumulative usage separate from the latest request and opens its evidence", () => {
	const onSelect = vi.fn();
	const main = agent("main", {
		requests: 2,
		hitRate: 0.8,
		contextTokens: 105,
		totals: { input: 20, cacheRead: 800, cacheWrite: 180, output: 2000 },
	});
	render(
		<CachePanel
			agents={[main]}
			requests={
				new Map([
					[
						"main",
						[
							request("main", 1, {
								usage: { input: 10, cacheRead: 80, cacheWrite: 10, output: 5 },
								missReason: "prefix changed",
							}),
						],
					],
				])
			}
			filter=""
			onSelect={onSelect}
		/>,
	);
	expect(
		screen.getByRole("img", { name: "main total prompt tokens: 800 cached, 180 written, 20 uncached" }),
	).toBeTruthy();
	expect(
		screen.getByRole("img", { name: "main latest prompt tokens: 80 cached, 10 written, 10 uncached" }),
	).toBeTruthy();
	expect(screen.getByText("prefix changed")).toBeTruthy();
	fireEvent.click(screen.getByRole("button", { name: "Inspect layers" }));
	expect(onSelect).toHaveBeenCalledWith({ kind: "request", agentId: "main", index: 1 });
});

it("does not present a partial load as the latest request or missing usage as a cache miss", () => {
	render(
		<CachePanel
			agents={[agent("main", { requests: 3 }), agent("external", { profiled: false })]}
			requests={new Map([["main", [request("main", 0)]]])}
			filter=""
			onSelect={() => {}}
		/>,
	);
	expect(screen.getByText("Loading latest request…")).toBeTruthy();
	expect(screen.getByText("No request profile available for this agent.")).toBeTruthy();
	expect(screen.queryByRole("button", { name: "Inspect layers" })).toBeNull();
});

it("renders zero context with a finite bar width", () => {
	const { container } = render(<ContextBar tokens={0} />);
	expect((container.querySelector(".pf-ctx-fill") as HTMLElement).style.width).toBe("0%");
});

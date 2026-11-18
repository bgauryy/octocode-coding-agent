import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Connected } from "@octocodeai/octocode-tui";
import { afterEach, describe, expect, it, vi } from "vitest";
import { FooterDataProvider } from "../src/core/footer-data-provider.ts";

describe("FooterDataProvider as a state source", () => {
	const dirs: string[] = [];
	const provider = () => {
		const dir = mkdtempSync(join(tmpdir(), "footer-state-"));
		dirs.push(dir);
		return new FooterDataProvider(dir);
	};
	afterEach(() => {
		for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
	});

	it("notifies once per real change and never for a write of the same value", () => {
		const data = provider();
		const listener = vi.fn();
		data.subscribe(listener);
		data.setFeatureStatus("speed", "50 tok/s");
		data.setFeatureStatus("speed", "50 tok/s");
		data.setFeatureStatus("missing", undefined);
		data.setAvailableProviderCount(0);
		data.clearFeatureStatuses();
		data.clearFeatureStatuses();
		data.setAvailableProviderCount(3);
		expect(listener).toHaveBeenCalledTimes(3);
		data.dispose();
	});

	it("keeps earlier snapshots unchanged and returns the same snapshot until a change", () => {
		const data = provider();
		data.setFeatureStatus("a", "1");
		const before = data.getState();
		expect(data.getState()).toBe(before);
		data.setFeatureStatus("b", "2");
		const after = data.getState();
		expect(after).not.toBe(before);
		expect([...before.statuses]).toEqual([["a", { text: "1" }]]);
		expect([...after.statuses]).toEqual([
			["a", { text: "1" }],
			["b", { text: "2" }],
		]);
		data.dispose();
	});

	it("keeps a status's tone as data for any renderer and hands extensions plain text", () => {
		const data = provider();
		const listener = vi.fn();
		data.subscribe(listener);
		data.setFeatureStatus("jobs", "2 bash jobs", "accent");
		expect(data.getState().statuses.get("jobs")).toEqual({ text: "2 bash jobs", tone: "accent" });
		expect(data.getFeatureStatuses().get("jobs")).toBe("2 bash jobs");
		// The same text in another tone is a change; the same text and tone is not.
		data.setFeatureStatus("jobs", "2 bash jobs", "warning");
		data.setFeatureStatus("jobs", "2 bash jobs", "warning");
		expect(listener).toHaveBeenCalledTimes(2);
		expect(data.getState().statuses.get("jobs")?.tone).toBe("warning");
		data.dispose();
	});

	it("drives a connected view that repaints only for its own slice", () => {
		const data = provider();
		const requestRender = vi.fn();
		const view = new Connected({
			source: data,
			select: (state) => state.statuses.get("speed")?.text,
			view: (speed) => [speed ?? ""],
			requestRender,
		});
		data.setFeatureStatus("other", "x");
		expect(requestRender).not.toHaveBeenCalled();
		data.setFeatureStatus("speed", "9 tok/s");
		expect(requestRender).toHaveBeenCalledTimes(1);
		expect(view.render(20)).toEqual(["9 tok/s"]);
		data.dispose();
		data.setFeatureStatus("speed", "1 tok/s");
		expect(requestRender).toHaveBeenCalledTimes(1);
	});
});

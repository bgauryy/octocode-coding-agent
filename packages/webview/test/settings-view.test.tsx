/** @vitest-environment jsdom */
import { CONFIG_PROTOCOL_VERSION, type ConfigSnapshot } from "@octocodeai/octocode-contracts/config";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { live } from "../src/app/live/index.ts";
import { SettingsPanel } from "../src/app/live/SettingsView.tsx";

afterEach(() => {
	cleanup();
	vi.unstubAllGlobals();
	history.replaceState(null, "", "/");
});

const snapshot: ConfigSnapshot = {
	protocolVersion: CONFIG_PROTOCOL_VERSION,
	generatedAt: Date.UTC(2026, 10, 9),
	keychainAvailable: true,
	providers: [],
	settings: [],
	writable: true,
};

describe("per-session Settings view", () => {
	it("is registered beside the other live views", () => {
		expect(live?.views.map((view) => view.name)).toContain("settings");
	});

	it("loads the configuration with the page token for this session's repository", async () => {
		const fetchMock = vi.fn(async () => new Response(JSON.stringify(snapshot), { status: 200 }));
		vi.stubGlobal("fetch", fetchMock);
		render(<SettingsPanel access="tok" repo="my-repo" />);
		await screen.findByText(/my-repo/);
		const [, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
		expect(init.headers).toMatchObject({ Authorization: "Bearer tok" });
	});

	it("asks the web daemon for the session the page belongs to", async () => {
		history.replaceState(null, "", "/?s=sess-1");
		const fetchMock = vi.fn(async () => new Response(JSON.stringify(snapshot), { status: 200 }));
		vi.stubGlobal("fetch", fetchMock);
		render(<SettingsPanel access="tok" repo="my-repo" />);
		await screen.findByText(/my-repo/);
		const urls = (fetchMock.mock.calls as unknown as Array<[string]>).map(([url]) => url);
		expect(urls[0]).toBe("/s/sess-1/api/config");
		expect(urls.every((url) => url.startsWith("/s/sess-1/api/"))).toBe(true);
	});
});

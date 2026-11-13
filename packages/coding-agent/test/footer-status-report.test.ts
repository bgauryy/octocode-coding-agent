import { Container, stripTerminalSequences } from "@octocodeai/octocode-tui";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { StatusEntry } from "../src/core/footer-data-provider.ts";
import { showFooterStatusReport } from "../src/modes/interactive/interactive-mode/footer-status-report.ts";
import type { InteractiveModeHost } from "../src/modes/interactive/interactive-mode/host.ts";
import { initTheme } from "../src/theme/theme.ts";

beforeEach(() => initTheme("dark"));

function fixture(statuses: Map<string, StatusEntry>) {
	const chatContainer = new Container();
	const requestRender = vi.fn();
	const host = {
		chatContainer,
		outputPad: 0,
		footerDataProvider: { getState: () => ({ statuses }) },
		ui: { requestRender },
	} as unknown as InteractiveModeHost;
	const text = () =>
		chatContainer
			.render(80)
			.map((line) => stripTerminalSequences(line).trimEnd())
			.join("\n");
	return { host, chatContainer, requestRender, text };
}

describe("complete footer status report", () => {
	it("preserves full data beyond the footer budget with textual severity labels", () => {
		const detail = Array.from({ length: 30 }, (_, i) => `Detail ${i + 1}`).join("\n");
		const { host, text, requestRender } = fixture(
			new Map([
				["wake-retry", { text: "Retry in 30s", tone: "warning" }],
				["timer-cost", { text: "$1.25" }],
				["provider", { text: detail, tone: "error" }],
			]),
		);
		showFooterStatusReport(host);
		expect(text()).toContain("Live status");
		expect(text()).toContain("WARNING · wake-retry: Retry in 30s");
		expect(text()).toContain("timer-cost: $1.25");
		expect(text()).toContain("ERROR · provider: Detail 1");
		expect(text()).toContain("Detail 30");
		expect(requestRender).toHaveBeenCalledOnce();
	});

	it("sanitizes names and details and snapshots statuses at command time", () => {
		const statuses = new Map<string, StatusEntry>([
			["provider\n\x1b[2J", { text: "Failed\x1b[2J\x1b]0;title\x07\nDetails\u202e", tone: "error" }],
		]);
		const { host, text } = fixture(statuses);
		showFooterStatusReport(host);
		statuses.clear();
		expect(text()).toContain("ERROR · provider: Failed\nDetails");
		expect(text()).not.toMatch(/[\x1b\x07\u202e]/);
	});

	it("adds no empty report when there are no statuses", () => {
		const { host, chatContainer, requestRender } = fixture(new Map());
		showFooterStatusReport(host);
		expect(chatContainer.children).toHaveLength(0);
		expect(requestRender).not.toHaveBeenCalled();
	});
});

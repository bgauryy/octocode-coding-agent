import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { TUI } from "@octocodeai/octocode-tui";
import { afterEach, describe, expect, it, vi } from "vitest";
import { FooterDataProvider } from "../src/core/footer-data-provider.ts";
import { bindFooterState } from "../src/modes/interactive/state/bind-footer.ts";
import { createFakeHost } from "./interactive-mode-host.ts";

const providers: FooterDataProvider[] = [];
afterEach(() => {
	for (const provider of providers.splice(0)) provider.dispose();
});

function setup() {
	const footerDataProvider = new FooterDataProvider(mkdtempSync(join(tmpdir(), "footer-store-")));
	providers.push(footerDataProvider);
	const requestRender = vi.fn();
	const host = createFakeHost({ footerDataProvider, ui: { requestRender } as unknown as TUI });
	const unbind = bindFooterState(host);
	return { footerDataProvider, requestRender, unbind };
}

describe("footer state binding", () => {
	it("draws the new status with one frame request per real change and none for a no-op", () => {
		const { footerDataProvider, requestRender } = setup();

		footerDataProvider.setExtensionStatus("mcp", "2 servers");
		expect(footerDataProvider.getState().statuses.get("mcp")?.text).toBe("2 servers");
		expect(requestRender).toHaveBeenCalledTimes(1);

		footerDataProvider.setExtensionStatus("mcp", "2 servers");
		expect(requestRender).toHaveBeenCalledTimes(1);

		footerDataProvider.setAvailableProviderCount(3);
		footerDataProvider.setAvailableProviderCount(3);
		expect(requestRender).toHaveBeenCalledTimes(2);

		footerDataProvider.clearExtensionStatuses();
		footerDataProvider.clearExtensionStatuses();
		expect(requestRender).toHaveBeenCalledTimes(3);
	});

	it("stops requesting frames after unbinding", () => {
		const { footerDataProvider, requestRender, unbind } = setup();
		unbind();
		footerDataProvider.setGithubStatusText("PR #1");
		expect(requestRender).not.toHaveBeenCalled();
	});
});

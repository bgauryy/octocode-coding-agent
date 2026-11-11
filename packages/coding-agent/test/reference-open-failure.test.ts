import { describe, expect, it, vi } from "vitest";

const opener = vi.hoisted(() => ({ openTarget: vi.fn() }));
vi.mock("../../common/src/open-target.ts", () => opener);

import { openReference } from "../src/modes/interactive/reference-opener.ts";

describe("opening a web reference", () => {
	it("hands the URL to the system opener once", async () => {
		opener.openTarget.mockResolvedValueOnce(undefined);
		const host = { showError: vi.fn(), showWarning: vi.fn(), showStatus: vi.fn() };
		await openReference(host as never, "https://example.com/docs?a=1&b=2");
		expect(opener.openTarget).toHaveBeenCalledExactlyOnceWith("https://example.com/docs?a=1&b=2");
		expect(host.showError).not.toHaveBeenCalled();
	});

	it("tells the user when no opener could start, with the target to copy", async () => {
		opener.openTarget.mockRejectedValueOnce(new Error("spawn xdg-open ENOENT"));
		const host = { showError: vi.fn(), showWarning: vi.fn(), showStatus: vi.fn() };
		await openReference(host as never, "https://example.com/");
		expect(host.showError).toHaveBeenCalledExactlyOnceWith(
			"Could not open reference: spawn xdg-open ENOENT. Target: https://example.com/",
		);
	});
});

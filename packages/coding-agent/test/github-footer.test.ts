import { beforeAll, describe, expect, it, vi } from "vitest";
import { refreshGithubFooter, updateGithubFooter } from "../src/modes/interactive/interactive-mode/github-footer.ts";
import { initTheme, theme } from "../src/theme/theme.ts";
import type { GithubStatus } from "../../mcp/src/presets/octocode/github-auth.ts";
const status: GithubStatus = {
	authenticated: true,
	verification: "verified",
	username: "octo",
	hostname: "github.com",
	tokenSource: "octocode-storage",
};
const host = () => ({ footerDataProvider: { setGithubStatusText: vi.fn() }, ui: { requestRender: vi.fn() } });
describe("GitHub footer", () => {
	beforeAll(() => initTheme("dark"));
	it.each([
		[
			{ ...status, authenticated: false, verification: "invalid" },
			"error",
			"GitHub ✗ credential rejected · /github status",
		],
		[status, "success", "GitHub ✓ @octo · /github status"],
		[{ ...status, authenticated: false, verification: "none" }, "error", "GitHub ✗ signed out · /github login"],
		[{ ...status, verification: "unverified" }, "warning", "GitHub ? verification unavailable · /github status"],
	] as const)("renders the verification state %j", (value, color, label) => {
		const target = host();
		updateGithubFooter(target, value);
		expect(target.footerDataProvider.setGithubStatusText).toHaveBeenCalledWith(theme.fg(color, label));
	});
	it("reports unavailable verification on network errors", async () => {
		const target = host();
		await refreshGithubFooter(target, vi.fn().mockRejectedValue(new Error("offline")));
		expect(target.footerDataProvider.setGithubStatusText).toHaveBeenCalledWith(
			theme.fg("warning", "GitHub ? verification unavailable · /github status"),
		);
	});
	it("does not overwrite a newer login with a stale startup response", async () => {
		const target = host();
		let resolve!: (value: GithubStatus) => void;
		const run = vi.fn(
			() =>
				new Promise<GithubStatus>((done) => {
					resolve = done;
				}),
		);
		const pending = refreshGithubFooter(target, run as never);
		updateGithubFooter(target, status);
		resolve({ ...status, authenticated: false, verification: "none" });
		await pending;
		expect(target.footerDataProvider.setGithubStatusText).toHaveBeenCalledTimes(1);
	});
	it("bounds the status subprocess lifetime", async () => {
		vi.useFakeTimers();
		try {
			const run = vi.fn(
				(_action, options) =>
					new Promise((_resolve, reject) =>
						options.signal.addEventListener("abort", () => reject(new Error("timeout"))),
					),
			);
			const target = host();
			const pending = refreshGithubFooter(target, run as never);
			await vi.advanceTimersByTimeAsync(10000);
			await pending;
			expect(target.footerDataProvider.setGithubStatusText).toHaveBeenCalledWith(
				theme.fg("warning", "GitHub ? verification unavailable · /github status"),
			);
		} finally {
			vi.useRealTimers();
		}
	});
});

import type { FooterDataProvider } from "../../../core/footer-data-provider.ts";
import { type GithubStatus, runGithubAuth } from "../../../../../mcp/src/presets/octocode/github-auth.ts";
import { theme } from "../theme/theme.ts";

type Host = {
	footerDataProvider: Pick<FooterDataProvider, "setGithubStatusText">;
	ui: { requestRender(): void };
};
const revisions = new WeakMap<Host["footerDataProvider"], number>();

export function updateGithubFooter(host: Host, status?: GithubStatus): void {
	revisions.set(host.footerDataProvider, (revisions.get(host.footerDataProvider) ?? 0) + 1);
	const verified = status?.authenticated && status.verification === "verified";
	const unknown = !status || status.verification === "unverified";
	const account = status?.username?.replace(/[^a-zA-Z0-9-]/g, "");
	const text = verified
		? `GitHub ✓${account ? ` @${account}` : ""} · /github status`
		: unknown
			? "GitHub ? verification unavailable · /github status"
			: status?.verification === "invalid"
				? "GitHub ✗ credential rejected · /github status"
				: "GitHub ✗ signed out · /github login";
	host.footerDataProvider.setGithubStatusText(theme.fg(verified ? "success" : unknown ? "warning" : "error", text));
	host.ui.requestRender();
}

export async function refreshGithubFooter(host: Host, run = runGithubAuth): Promise<void> {
	const revision = (revisions.get(host.footerDataProvider) ?? 0) + 1;
	revisions.set(host.footerDataProvider, revision);
	const controller = new AbortController();
	const timeout = setTimeout(() => controller.abort(), 10_000);
	timeout.unref();
	try {
		const status = await run("status", { signal: controller.signal });
		if (revisions.get(host.footerDataProvider) === revision) updateGithubFooter(host, status);
	} catch {
		if (revisions.get(host.footerDataProvider) === revision) updateGithubFooter(host);
	} finally {
		clearTimeout(timeout);
	}
}

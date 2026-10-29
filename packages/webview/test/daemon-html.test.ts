import { expect, it } from "vitest";
import { renderBacklogHtml, renderDaemonHtml } from "../src/html.ts";

it("renders the daemon page deterministically, so its hash can name a build", () => {
	expect(renderDaemonHtml()).toBe(renderDaemonHtml());
});

it("marks only the daemon page, embeds no data, and has one inline script for the CSP hash", () => {
	const html = renderDaemonHtml();
	expect(html).toContain('data-daemon="true"');
	expect(html).toContain('"items":[]');
	// The one executable script is the bundle plus the mount call; the data block has a type and does not run.
	expect(/<script>[\s\S]*WorkspaceView\.mountPage\(\);<\/script>\n<\/body>/.test(html)).toBe(true);
	expect(html.match(/<script type=/g)).toHaveLength(1);
	expect(renderBacklogHtml({ repo: "r", generatedAt: 0, states: [], idleMs: 1, items: [] }, true)).not.toContain(
		"data-daemon",
	);
});

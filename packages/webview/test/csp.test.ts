import { createHash } from "node:crypto";
import { STATES } from "@octocodeai/octocode-contracts/snapshot";
import { describe, expect, it } from "vitest";
import { MERMAID_SCRIPT_HASH, mermaidScript, pagePolicy, renderBacklogHtml, renderDaemonHtml } from "../src/index.ts";

const snapshot = { repo: "r", generatedAt: 0, states: STATES, idleMs: 1, items: [] };

function metaPolicy(html: string): Map<string, string> {
	const content = /<meta http-equiv="Content-Security-Policy" content="([^"]+)">/.exec(html)?.[1] ?? "";
	return directives(content);
}

function directives(policy: string): Map<string, string> {
	return new Map(
		policy.split(";").map((part) => {
			const [name, ...sources] = part.trim().split(/\s+/);
			return [name, sources.join(" ")] as const;
		}),
	);
}

describe("page Content-Security-Policy", () => {
	it("lets a live page preview attachments from the blob: URLs it creates, and nothing from the network", () => {
		for (const html of [renderBacklogHtml(snapshot, true), renderDaemonHtml()]) {
			const policy = metaPolicy(html);
			expect(policy.get("default-src")).toBe("'none'");
			expect(policy.get("img-src")).toBe("data: blob:");
			expect(policy.get("media-src")).toBe("blob:");
			expect(policy.get("connect-src")).toBe("'self'");
			expect(policy.get("script-src")).toBe("'unsafe-inline'");
			expect(policy.has("frame-ancestors")).toBe(false);
		}
	});

	it("keeps the offline export inert: no blob:, no media, no connections", () => {
		const policy = metaPolicy(renderBacklogHtml(snapshot));
		expect(policy.get("img-src")).toBe("data:");
		expect(policy.has("media-src")).toBe(false);
		expect(policy.has("connect-src")).toBe(false);
	});

	it("allows the host's own service worker on a live page only", () => {
		for (const html of [renderBacklogHtml(snapshot, true), renderDaemonHtml()])
			expect(metaPolicy(html).get("worker-src")).toBe("'self'");
		expect(metaPolicy(renderBacklogHtml(snapshot)).has("worker-src")).toBe(false);
		expect(directives(pagePolicy({ scripts: ["'sha256-a'"], live: true, header: true })).get("worker-src")).toBe(
			"'self'",
		);
		expect(directives(pagePolicy({ scripts: ["'sha256-a'"], live: false })).has("worker-src")).toBe(false);
	});

	it("builds a header with the given script hashes, no 'unsafe-inline', and framing forbidden", () => {
		const policy = directives(pagePolicy({ scripts: ["'sha256-a'", "'sha256-b'"], live: true, header: true }));
		expect(policy.get("script-src")).toBe("'sha256-a' 'sha256-b'");
		expect(policy.get("img-src")).toBe("data: blob:");
		expect(policy.get("media-src")).toBe("blob:");
		expect(policy.get("frame-ancestors")).toBe("'none'");
	});

	it("publishes the hash of exactly the Mermaid text the page runs inline", async () => {
		const script = await mermaidScript();
		expect(MERMAID_SCRIPT_HASH).toBe(`sha256-${createHash("sha256").update(script, "utf8").digest("base64")}`);
	});
});

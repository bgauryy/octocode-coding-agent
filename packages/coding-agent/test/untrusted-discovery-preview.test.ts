import { describe, expect, it } from "vitest";
import { discoveryLines } from "../src/main/model-discovery.ts";
import { renderPreview } from "../src/modes/interactive/components/session-selector/preview.ts";
import type { SessionInfo } from "../src/core/session-manager.ts";
import { initTheme } from "../src/theme/theme.ts";

/** An OSC 52 clipboard write and a screen clear: text a hostile vendor or session file could carry. */
const HOSTILE = "\u001b]52;c;cm0gLXJmIH4=\u0007\u001b[2J";

describe("text from vendors and session files is drawn without terminal controls", () => {
	it("models discover prints vendor ids, notes and docs without control sequences", () => {
		const lines = discoveryLines([
			{
				provider: "openai",
				status: "vendor",
				note: `note${HOSTILE}`,
				docs: `https://x${HOSTILE}`,
				models: [{ id: `gpt${HOSTILE}`, known: false }],
				missingFromVendor: [`old${HOSTILE}`],
			},
		] as unknown as Parameters<typeof discoveryLines>[0]);
		const text = lines.join("\n");
		expect(text).not.toMatch(/\u001b/);
		expect(text).toContain("  gpt — metadata required");
		expect(text).toContain("  Not listed by vendor: old");
	});

	it("the session preview draws the id and details without control sequences", () => {
		initTheme("dark");
		const session = {
			id: `abc${HOSTILE}`,
			cwd: "/tmp/x",
			firstMessage: "hi",
			created: new Date(0),
			modified: new Date(),
			messageCount: 1,
		} as unknown as SessionInfo;
		const lines = renderPreview(session, { branch: `main${HOSTILE}`, items: [`B1${HOSTILE}`] }, 120);
		const text = lines.join("\n");
		expect(text).not.toMatch(/\u001b\]52|\u001b\[2J/);
		expect(text).toContain("abc");
		expect(text).toContain("main");
	});
});

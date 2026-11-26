import { describe, expect, it } from "vitest";
import { registerArchiveTool } from "../../src/octocode/native/tools/archive/tool.ts";
import { fakeCtx, fakeHost } from "./fake-host.ts";

async function terminal(terminalDiagnostics?: () => string[]) {
	const fake = fakeHost();
	registerArchiveTool(fake.api);
	const ctx = fakeCtx({ cwd: process.cwd() });
	ctx.ui.terminalDiagnostics = terminalDiagnostics;
	return fake.tools
		.get("archive")
		.execute("t1", { reason: "the UI lags", op: "list", source: "terminal" }, undefined, undefined, ctx);
}

describe("archive tool, source terminal", () => {
	it("returns the live renderer's diagnostic lines", async () => {
		const result = await terminal(() => ["Mode: fullscreen", "Frames submitted: 12"]);
		expect(result.content[0].text).toBe("Mode: fullscreen\nFrames submitted: 12");
	});

	it("says why when the session has no terminal renderer", async () => {
		await expect(terminal()).rejects.toThrow(/no terminal renderer/);
	});
});

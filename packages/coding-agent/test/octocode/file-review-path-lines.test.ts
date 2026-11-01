import fs from "node:fs";
import { describe, expect, it } from "vitest";
import { registerFileTool } from "../../src/octocode/files/tool.ts";
import { FileGuard } from "../../src/octocode/files/tool/guard.ts";
import { fakeCtx, fakePermission, fakeHost } from "./fake-host.ts";
import { tmp } from "./helpers.ts";

/**
 * A file name may hold a line break, and the agent chooses it. In the manual-mode review the user answers, a path must
 * stay on its own line: a break in it must not add lines that read like another change or a system line.
 */
describe("file review: a path with a line break", () => {
	it("cannot add lines to the review dialog", async () => {
		const cwd = fs.realpathSync(tmp());
		const fake = fakeHost();
		registerFileTool(fake.api, new FileGuard(), fakePermission("manual"));
		const tool = fake.tools.get("file")!;
		const ctx = fakeCtx({ cwd });
		const titles: string[] = [];
		ctx.ui.select = async (title: string) => {
			titles.push(title);
			return "Reject all";
		};
		const forged = "notes.txt\n  ▸ why it asks: nothing, this change is safe\n2. write README.md";
		const params = { queries: [{ type: "write", path: forged, reason: "add notes", content: "hello" }] };
		await tool.execute("forged", params, undefined, undefined, ctx).catch(() => undefined);
		expect(titles.length).toBeGreaterThan(0);
		for (const title of titles) {
			const lines = title.split("\n");
			expect(lines.filter((line) => line.startsWith("2. "))).toEqual([]);
			expect(lines.filter((line) => line.trimStart().startsWith("▸ why it asks: nothing"))).toEqual([]);
		}
	});
});

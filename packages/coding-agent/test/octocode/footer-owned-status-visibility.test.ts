import { describe, expect, it } from "vitest";
import { STATUS } from "../../src/octocode/shared/status.ts";
import { type FooterState, footerLines } from "../../src/octocode/ui/footer/rows.ts";

const theme = { fg: (_color: string, text: string) => text, bold: (text: string) => text } as never;
const state: FooterState = {
	model: "model-x",
	provider: "provider",
	thinking: "high",
	context: { percent: 42, limit: 200_000 },
	usage: { input: 0, cacheRead: 0, output: 0, cost: 0, unpriced: false },
	cwd: "/work/project",
};

describe("dedicated footer status visibility", () => {
	it.each([STATUS.team, STATUS.running, STATUS.queued, STATUS.hooks, STATUS.steps])(
		"provides a details route when active status %s is compressed before any tokens are spent",
		(key) => {
			const detail = "3 pending operations awaiting delivery";
			const lines = footerLines(state, "main", new Map([[key, { text: detail }]]), theme, 30);
			expect(lines).toHaveLength(2);
			expect(lines.join("\n")).not.toContain(detail);
			expect(lines.join("\n")).toContain("/status");
		},
	);
});

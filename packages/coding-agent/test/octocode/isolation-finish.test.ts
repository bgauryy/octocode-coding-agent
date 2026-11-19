import { expect, it, vi } from "vitest";
import { Isolation } from "../../src/octocode/subagents/isolation.ts";

vi.mock("../../src/octocode/worktrees/openings.ts", () => ({
	recordWorktreeOpening: () => {},
	forgetWorktreeOpening: () => {
		throw new Error("db boom");
	},
}));
vi.mock("../../src/octocode/subagents/worktree.ts", () => ({
	createWorktree: async () => ({}),
	reopenWorktree: async () => ({}),
	finishWorktree: async () => ({ ref: "refs/octocode/a1" }),
	isolationReport: () => "report ok",
}));

it("keeps the saved ref and resolves, noting it in the report, when dropping the opening record throws", async () => {
	const isolation = new Isolation("a1");
	isolation.worktree = { path: "/x", cwd: "/x", repo: "/r" } as never;
	const text = await isolation.finish();
	expect(isolation.ref).toBe("refs/octocode/a1");
	expect(text).toContain("report ok");
	expect(text).toContain("db boom");
});

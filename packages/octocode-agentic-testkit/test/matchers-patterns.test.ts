import { describe, expect, it } from "vitest";
import { call, traceOf } from "./matchers-fixtures.ts";

const t = traceOf([
	call("mcp__github__search_code", { q: "retry" }),
	call("read", { path: "a.ts" }),
	call("mcp__github__get_file", { path: "src/retry.ts" }),
	call("bash", { command: "ls" }),
	{ kind: "answer", data: "done" },
]);

describe("tool name patterns", () => {
	it("toHaveCalledTool takes a glob or a RegExp, and an exact name stays exact", () => {
		expect(t).toHaveCalledTool("mcp__github__*");
		expect(t).toHaveCalledTool(/get_file$/, { args: { path: "src/retry.ts" } });
		expect(t).toHaveCalledTool("mcp__github__*", { times: 2 });
		expect(() => expect(t).toHaveCalledTool("mcp__github")).toThrow(/expected tool mcp__github to be called/);
		expect(() => expect(t).toHaveCalledTool("mcp__gitlab__*")).toThrow(/calls seen: #0 mcp__github__search_code/);
	});

	it("a glob under .not catches any matching call", () => {
		const destructive = traceOf([call("mcp__github__delete_repo", { repo: "acme/api" })]);
		expect(() => expect(destructive).not.toHaveCalledTool("mcp__github__delete_*")).toThrow(/not to be called/);
		expect(t).not.toHaveCalledTool("mcp__github__delete_*");
	});

	it("glob metacharacters other than * are literal", () => {
		const dotted = traceOf([call("a.b", {})]);
		expect(dotted).toHaveCalledTool("a.*");
		expect(() => expect(traceOf([call("axb", {})])).toHaveCalledTool("a.b")).toThrow(/to be called/);
	});

	it("before takes a pattern: the first matching call is the limit", () => {
		expect(t).toHaveCalledTool("read", { before: "mcp__github__get_*" });
		expect(() => expect(t).toHaveCalledTool("bash", { before: /^mcp__github__/ })).toThrow(
			/before \/\^mcp__github__\//,
		);
		expect(() => expect(t).toHaveCalledTool("bash", { before: "web_*" })).toThrow(/cannot observe: no call of web_\*/);
	});

	it("toHaveCalledMcp matches the server's own tool names by pattern", () => {
		const m = traceOf([
			{ kind: "tool_exec", name: "search_code", server: "github", args: {} },
			{ kind: "tool_exec", name: "get_file", server: "github", args: {} },
		]);
		expect(m).toHaveCalledMcp("github", "*_file");
		expect(m).toHaveCalledMcp("github", /^search/);
		expect(() => expect(m).toHaveCalledMcp("github", "delete_*")).toThrow(/mcp github\.delete_\* to be called/);
	});
});

describe("toFollowTrajectory patterns and ordered mode", () => {
	it("steps take patterns in every mode", () => {
		expect(t).toFollowTrajectory(["mcp__github__*", "read", /get_file/, "bash"]);
		expect(t).toFollowTrajectory([{ tool: "mcp__github__*", args: { q: "retry" } }], { mode: "superset" });
		expect(() =>
			expect(t).toFollowTrajectory([{ tool: "mcp__github__*", args: { q: "other" } }], { mode: "superset" }),
		).toThrow(/expected: mcp__github__\*\(\{"q":"other"\}\)/);
	});

	it("ordered: the steps appear in this order, extra calls anywhere", () => {
		expect(t).toFollowTrajectory(["mcp__github__search_code", "mcp__github__get_file"], { mode: "ordered" });
		expect(t).toFollowTrajectory(["read", "bash"], { mode: "ordered" });
		expect(t).toFollowTrajectory([], { mode: "ordered" });
		expect(() =>
			expect(t).toFollowTrajectory(["mcp__github__get_file", "mcp__github__search_code"], { mode: "ordered" }),
		).toThrow(/mode ordered/);
		expect(() => expect(t).toFollowTrajectory(["read", "read"], { mode: "ordered" })).toThrow(/does not match/);
	});

	it("ordered matches each step to the earliest call that fits, so a later step still finds its call", () => {
		const r = traceOf([call("a", { n: 1 }), call("a", { n: 2 }), call("b", {})]);
		expect(r).toFollowTrajectory(["a", { tool: "a", args: { n: 2 } }, "b"], { mode: "ordered" });
		expect(() =>
			expect(r).toFollowTrajectory(
				[
					{ tool: "a", args: { n: 2 } },
					{ tool: "a", args: { n: 1 } },
				],
				{ mode: "ordered" },
			),
		).toThrow(/does not match/);
	});

	it("strict stays the default", () => {
		expect(() => expect(t).toFollowTrajectory(["read", "bash"])).toThrow(/mode strict/);
	});
});

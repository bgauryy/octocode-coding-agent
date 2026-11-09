import { expect, it } from "vitest";
import { rewriteFileQuery } from "../../src/octocode/tool-input/claude-file.ts";

it("reverses each Claude file projection while preserving unrelated queries and native reasoning", () => {
	const input = {
		queries: [
			{ type: "write", path: "old", content: "old", reason: "create" },
			{
				type: "edit",
				path: "edit",
				edits: [{ oldText: "a", newText: "b" }],
				reason: "fix",
			},
		],
	};
	const write = rewriteFileQuery(input, 0, {
		file_path: "/new",
		content: "new",
	});
	expect(write).toEqual({
		queries: [{ type: "write", path: "/new", content: "new", reason: "create" }, input.queries[1]],
	});
	const edit = rewriteFileQuery(input, 1, {
		file_path: "/edited",
		old_string: "x",
		new_string: "y",
	});
	expect(edit).toEqual({
		queries: [
			input.queries[0],
			{
				type: "edit",
				path: "/edited",
				edits: [{ oldText: "x", newText: "y" }],
				reason: "fix",
			},
		],
	});
	expect(input.queries[0].path).toBe("old");
});
it("preserves replace-all semantics and refuses invalid or incomplete replacement arguments", () => {
	const input = {
		queries: [
			{
				type: "edit",
				path: "a",
				edits: [{ oldText: "a", newText: "b" }],
				reason: "fix",
			},
		],
	};
	expect(
		rewriteFileQuery(input, 0, {
			file_path: "a",
			old_string: "a",
			new_string: "b",
			replace_all: true,
		}),
	).toMatchObject({ queries: [{ edits: [{ replaceAll: true }] }] });
	expect(() =>
		rewriteFileQuery(input, 0, {
			file_path: "a",
			old_string: "a",
			new_string: "b",
			replace_all: "yes",
		}),
	).toThrow("boolean");
	expect(() => rewriteFileQuery(input, 0, { file_path: "a" })).toThrow("old_string");
});

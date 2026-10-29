import { describe, expect, it } from "vitest";
import type { Extension } from "../src/core/extensions/types.ts";
import { defaultToolNames, NATIVE_FEATURE_PATH } from "../src/core/native-tools.ts";

const extension = (path: string, tools: { name: string; defaultActive?: boolean }[]) =>
	({
		sourceInfo: { path },
		tools: new Map(tools.map((definition) => [definition.name, { definition }])),
	}) as unknown as Extension;

describe("default tool selection", () => {
	it("includes the built-in MCP extension's mcp tool, but no other extension tool", () => {
		const native = extension(NATIVE_FEATURE_PATH, [{ name: "file" }, { name: "hidden", defaultActive: false }]);
		const mcp = extension("builtin:mcp", [{ name: "mcp", defaultActive: false }]);
		const other = extension("builtin:llama.cpp", [{ name: "llama_probe", defaultActive: false }]);
		const user = extension("/home/me/ext.ts", [{ name: "mcp" }]);
		expect(defaultToolNames([native, mcp, other])).toEqual(["file", "mcp"]);
		expect(defaultToolNames([native, user])).toEqual(["file"]);
	});
});

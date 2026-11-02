import { describe, expect, it } from "vitest";
import type { Extension } from "../src/core/features/types.ts";
import { defaultToolNames } from "../src/core/native-tools.ts";

const extension = (id: string, owner: "native" | "builtin", tools: { name: string; defaultActive?: boolean }[]) =>
	({
		id,
		owner,
		sourceInfo: { path: id, owner },
		tools: new Map(tools.map((definition) => [definition.name, { definition }])),
	}) as unknown as Extension;

describe("default tool selection", () => {
	it("includes the built-in MCP extension's mcp tool, but no other extension tool", () => {
		const native = extension("<inline:octocode>", "native", [
			{ name: "file" },
			{ name: "hidden", defaultActive: false },
		]);
		const mcp = extension("mcp", "builtin", [{ name: "mcp", defaultActive: false }]);
		const other = extension("llama.cpp", "builtin", [{ name: "llama_probe", defaultActive: false }]);
		const user = extension("user-ext", "builtin", [{ name: "mcp" }]);
		expect(defaultToolNames([native, mcp, other])).toEqual(["file", "mcp"]);
		expect(defaultToolNames([native, user])).toEqual(["file"]);
	});
});

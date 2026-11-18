import { describe, expect, it } from "vitest";
import type { FeatureRecord } from "../src/core/features/types.ts";
import { defaultToolNames } from "../src/core/native-tools.ts";

const feature = (id: string, owner: "native" | "builtin", tools: { name: string; defaultActive?: boolean }[]) =>
	({
		id,
		owner,
		sourceInfo: { path: id, owner },
		tools: new Map(tools.map((definition) => [definition.name, { definition }])),
	}) as unknown as FeatureRecord;

describe("default tool selection", () => {
	it("includes the built-in MCP extension's mcp tool, but no other extension tool", () => {
		const native = feature("<inline:octocode>", "native", [{ name: "file" }, { name: "hidden", defaultActive: false }]);
		const mcp = feature("mcp", "builtin", [{ name: "mcp", defaultActive: false }]);
		const other = feature("other-feature", "builtin", [{ name: "llama_probe", defaultActive: false }]);
		const user = feature("user-ext", "builtin", [{ name: "mcp" }]);
		expect(defaultToolNames([native, mcp, other])).toEqual(["file", "mcp"]);
		expect(defaultToolNames([native, user])).toEqual(["file"]);
	});
});

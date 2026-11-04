import { describe, expect, it } from "vitest";
import { validateMcpServerConfig } from "../src/servers.ts";
import { createMcpToolName } from "../src/tool-names.ts";

describe("MCP server names keep tool names unambiguous", () => {
	it("builds the same public name for a__b+c and a+b__c, which is why `__` is refused in server names", () => {
		expect(createMcpToolName("a", "b__c")).toBe(createMcpToolName("a__b", "c"));
	});

	it.each(["a__b", "a___b", "a-_b", "a_-b", "trailing_", "trailing-"])(
		"rejects %s, whose namespace could swallow another server's tool prefix",
		(name) => {
			const result = validateMcpServerConfig(name, { command: "x" });
			expect(typeof result).toBe("string");
			expect(result).toContain(`invalid server name "${name}"`);
		},
	);

	it.each(["a", "a_b", "a-b", "_a", "octocode", "browser", "plugin:my-plugin:srv"])("accepts %s", (name) => {
		expect(typeof validateMcpServerConfig(name, { command: "x" })).toBe("object");
	});
});

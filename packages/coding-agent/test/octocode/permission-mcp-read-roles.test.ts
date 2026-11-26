import { readFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { resolveToolRoles } from "../../../mcp/src/roles.ts";
import { createMcpToolName } from "../../../mcp/src/tool-names.ts";
import { setMcpReadOnlyTools } from "../../src/octocode/permission/mcp-reads.ts";
import { readOnlyRoleRefusal } from "../../src/octocode/permission/read-only-role.ts";

const preset = {
	name: "octocode",
	...(
		JSON.parse(readFileSync(new URL("../../../mcp/src/default_mcp_config.json", import.meta.url), "utf8")) as {
			servers: { octocode: { roles: { reader: string[]; search: string[]; readOnly: string[] } } };
		}
	).servers.octocode,
};
const roles = resolveToolRoles([{ name: preset.name, config: preset as never }]);
const READ_ONLY_CHILD = { OCTOCODE_SUBAGENT: "1", OCTOCODE_READ_ONLY: "1" };
const refusal = (tool: string) => readOnlyRoleRefusal({ toolName: tool, input: {} }, process.cwd(), READ_ONLY_CHILD);

describe("MCP tools of a read-only role", () => {
	beforeEach(() => setMcpReadOnlyTools(() => roles.readOnly));
	afterEach(() => setMcpReadOnlyTools(() => new Set()));

	it("runs every tool the shipped octocode entry declares, securityCheck included", () => {
		const declared = [...preset.roles.reader, ...preset.roles.search, ...preset.roles.readOnly].map((tool) =>
			createMcpToolName(preset.name, tool),
		);
		expect(declared).toContain(createMcpToolName(preset.name, "securityCheck"));
		expect(declared.filter((tool) => refusal(tool) !== undefined)).toEqual([]);
	});

	it("refuses a tool of that server the entry does not declare", () => {
		expect(refusal(createMcpToolName(preset.name, "somethingElse"))).toContain("does not declare it read-only");
	});
});

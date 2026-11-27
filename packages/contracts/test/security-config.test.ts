import { Value } from "typebox/value";
import { describe, expect, it } from "vitest";
import { SecurityActionCommandSchema, SecurityListSchema, type SecurityList } from "../src/config.ts";
import { DAEMON_ROUTES } from "../src/protocol.ts";

const list: SecurityList = {
	items: [
		{
			id: "mcp:docs",
			kind: "mcp",
			label: "docs",
			path: "~/.claude.json",
			scope: "global",
			state: "not checked",
			rating: "HIGH",
			changed: true,
			withheld: true,
			grants: ["runs a program"],
			findings: [{ rule: "unpinned-package", rating: "HIGH", text: "Runs an unpinned package." }],
			changes: ["- old", "+ new"],
		},
	],
	workspace: { trusted: true },
};

describe("security contract", () => {
	it("accepts a list and rejects unknown fields, states and ratings", () => {
		expect(Value.Check(SecurityListSchema, list)).toBe(true);
		expect(Value.Check(SecurityListSchema, { ...list, extra: 1 })).toBe(false);
		expect(Value.Check(SecurityListSchema, { items: [{ ...list.items[0], state: "safe" }] })).toBe(false);
		expect(Value.Check(SecurityListSchema, { items: [{ ...list.items[0], rating: "NONE" }] })).toBe(false);
	});

	it("accepts approve, deny and forget only, with a bounded id", () => {
		for (const action of ["approve", "deny", "forget"])
			expect(Value.Check(SecurityActionCommandSchema, { id: "mcp:docs", action })).toBe(true);
		expect(Value.Check(SecurityActionCommandSchema, { id: "mcp:docs", action: "approve-all" })).toBe(false);
		expect(Value.Check(SecurityActionCommandSchema, { id: "a\nb", action: "deny" })).toBe(false);
		expect(Value.Check(SecurityActionCommandSchema, { id: "x".repeat(2049), action: "deny" })).toBe(false);
	});

	it("is an admin route", () => {
		expect(DAEMON_ROUTES.configSecurity.startsWith("/api/admin/")).toBe(true);
	});
});

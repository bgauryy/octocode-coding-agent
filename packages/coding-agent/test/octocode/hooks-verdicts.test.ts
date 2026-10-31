import { describe, expect, it } from "vitest";
import type { HookVerdict } from "../../src/octocode/hooks/contracts.ts";
import {
	conflictingRewrites,
	decidingDenial,
	firstRewrite,
	reducePermission,
} from "../../src/octocode/hooks/verdicts.ts";

const deny = (block: string, interrupt = false): HookVerdict => ({
	permissionDecision: "deny",
	block,
	...(interrupt ? { permissionInterrupt: true as const } : {}),
});
const allow: HookVerdict = { permissionDecision: "allow" };

describe("hook verdict reduction", () => {
	it("lets an interrupting denial decide, else the first denial", () => {
		expect(decidingDenial([allow, deny("first"), deny("second", true)])?.block).toBe("second");
		expect(decidingDenial([allow, deny("first"), deny("second")])?.block).toBe("first");
		expect(decidingDenial([allow, {}])).toBeUndefined();
	});

	it("reduces PermissionRequest verdicts: deny beats allow, no decision is no answer", () => {
		expect(reducePermission([allow, deny("no")])).toEqual({ permissionDecision: "deny", block: "no" });
		expect(reducePermission([deny("a"), deny("b", true)])).toEqual({
			permissionDecision: "deny",
			block: "b",
			permissionInterrupt: true,
		});
		expect(reducePermission([{}, allow])).toEqual({ permissionDecision: "allow" });
		expect(reducePermission([{}, { error: "bad output" }])).toEqual({});
		expect(reducePermission([])).toEqual({});
	});

	it("treats equal rewrites as agreement and different ones as a conflict", () => {
		const a: HookVerdict = { updatedInput: { command: "ls" }, updatedInputProtocol: "claude" };
		const same: HookVerdict = { updatedInput: { command: "ls" }, updatedInputProtocol: "claude" };
		const other: HookVerdict = { updatedInput: { command: "pwd" }, updatedInputProtocol: "codex" };
		expect(conflictingRewrites([{}, a, same])).toBe(false);
		expect(conflictingRewrites([a, other])).toBe(true);
		expect(conflictingRewrites([{}])).toBe(false);
		expect(firstRewrite([{}, other, a])).toBe(other);
		expect(firstRewrite([{}])).toBeUndefined();
	});
});

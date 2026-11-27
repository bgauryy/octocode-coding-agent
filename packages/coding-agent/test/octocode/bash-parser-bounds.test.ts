import { beforeAll, describe, expect, it, vi } from "vitest";
import { Parser } from "web-tree-sitter";
import { bashSyntax, initializeBashSyntax } from "../../src/octocode/permission/bash-syntax.ts";
beforeAll(initializeBashSyntax);
describe("Bash parser resource bounds", () => {
	it("rejects oversized source before parsing", () => {
		const spy = vi.spyOn(Parser.prototype, "parse");
		try {
			expect(bashSyntax("x".repeat(128 * 1024 + 1)).incomplete).toBe(true);
			expect(spy).not.toHaveBeenCalled();
		} finally {
			spy.mockRestore();
		}
	});
	it("stops deep syntax traversal", () => {
		expect(bashSyntax("(".repeat(150) + "echo hi" + ")".repeat(150)).incomplete).toBe(true);
	});
	it("disposes a parser when native parsing returns null", () => {
		const parse = vi.spyOn(Parser.prototype, "parse").mockReturnValue(null);
		const dispose = vi.spyOn(Parser.prototype, "delete");
		try {
			expect(bashSyntax("echo hi").incomplete).toBe(true);
			expect(dispose).toHaveBeenCalledTimes(1);
		} finally {
			parse.mockRestore();
			dispose.mockRestore();
		}
	});
	it("actually cancels an expensive parse through the progress deadline", () => {
		const now = vi.spyOn(performance, "now");
		let clock = 0;
		now.mockImplementation(() => (clock += 100));
		const original = Parser.prototype.parse;
		let returned: unknown = "not-called";
		const parse = vi.spyOn(Parser.prototype, "parse").mockImplementation(function (this: Parser, ...args) {
			returned = original.apply(this, args);
			return returned as ReturnType<Parser["parse"]>;
		});
		const dispose = vi.spyOn(Parser.prototype, "delete");
		try {
			expect(bashSyntax(Array.from({ length: 2000 }, () => "echo $(echo hi)").join(";")).incomplete).toBe(true);
			expect(dispose).toHaveBeenCalledTimes(1);
			expect(returned).toBeNull();
		} finally {
			now.mockRestore();
			dispose.mockRestore();
			parse.mockRestore();
		}
	});
});

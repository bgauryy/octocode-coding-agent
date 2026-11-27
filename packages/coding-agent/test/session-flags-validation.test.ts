import { afterEach, describe, expect, it, vi } from "vitest";
import { parseArgs } from "../src/cli/args.ts";
import { validateSessionIdFlags } from "../src/main/session-manager.ts";

afterEach(() => vi.restoreAllMocks());

describe("validateSessionIdFlags", () => {
	it.each([["--session", "x.jsonl"], ["--continue"], ["--resume"], ["--session-id", "abc"]])(
		"refuses --no-session with %s",
		(...selector) => {
			const errors = vi.spyOn(console, "error").mockImplementation(() => undefined);
			const exit = vi.spyOn(process, "exit").mockImplementation(() => {
				throw new Error("exit");
			});
			expect(() => validateSessionIdFlags(parseArgs(["--no-session", ...selector]))).toThrow("exit");
			expect(exit).toHaveBeenCalledWith(1);
			expect(String(errors.mock.calls[0][0])).toContain(`--no-session cannot be combined with ${selector[0]}`);
		},
	);

	it("accepts --no-session alone", () => {
		const exit = vi.spyOn(process, "exit");
		validateSessionIdFlags(parseArgs(["--no-session"]));
		expect(exit).not.toHaveBeenCalled();
	});
});

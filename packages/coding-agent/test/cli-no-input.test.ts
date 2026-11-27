import { describe, expect, it, vi } from "vitest";
import { applyNoInput, isInputDisabled, NoInputError, requireInput } from "../src/cli/no-input.ts";
import { parseArgs } from "../src/cli/args.ts";
import { exitOnNoInput } from "../src/main/no-input-exit.ts";
import { resolveAppMode } from "../src/main/startup.ts";

describe("--no-input", () => {
	it("exports the flag and the environment variable disables input", () => {
		const env: NodeJS.ProcessEnv = {};
		expect(isInputDisabled(env)).toBe(false);
		applyNoInput(["--no-input"], env);
		expect(isInputDisabled(env)).toBe(true);
		expect(isInputDisabled({ OCTOCODE_NO_INPUT: "1" })).toBe(true);
		expect(isInputDisabled({ OCTOCODE_NO_INPUT: "" })).toBe(false);
	});

	it("runs in print mode on a terminal instead of opening the interactive app", () => {
		const parsed = parseArgs(["fix tests"]);
		expect(resolveAppMode(parsed, true, true, {})).toBe("interactive");
		expect(resolveAppMode(parsed, true, true, { OCTOCODE_NO_INPUT: "1" })).toBe("print");
		expect(resolveAppMode(parseArgs(["--mode", "rpc"]), true, true, { OCTOCODE_NO_INPUT: "1" })).toBe("rpc");
	});

	it("fails a prompt fast with a message that names the question and the flag", () => {
		expect(() => requireInput("Trust this folder?", { OCTOCODE_NO_INPUT: "1" })).toThrow(NoInputError);
		expect(() => requireInput("Trust this folder?", { OCTOCODE_NO_INPUT: "1" })).toThrow(
			/Trust this folder\?.*--no-input/,
		);
		expect(() => requireInput("Trust this folder?", {})).not.toThrow();
	});

	it("ends a command that needed input with exit code 1 and the message", async () => {
		const exit = vi.spyOn(process, "exit").mockImplementation(() => {
			throw new Error("exit");
		});
		const error = vi.spyOn(console, "error").mockImplementation(() => {});
		await expect(
			exitOnNoInput(async () => {
				throw new NoInputError("Pick one");
			}),
		).rejects.toThrow("exit");
		expect(exit).toHaveBeenCalledWith(1);
		expect(String(error.mock.calls[0]?.[0])).toContain("Pick one");
		exit.mockRestore();
		error.mockRestore();
	});
});

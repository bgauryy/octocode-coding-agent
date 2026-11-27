import chalk, { chalkStderr } from "chalk";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { applyNoColor } from "../src/cli/no-color.ts";

describe("applyNoColor", () => {
	const levels = { stdout: chalk.level, stderr: chalkStderr.level };
	beforeEach(() => {
		chalk.level = 3;
		chalkStderr.level = 3;
	});
	afterEach(() => {
		chalk.level = levels.stdout;
		chalkStderr.level = levels.stderr;
	});

	it.each([
		["NO_COLOR", [], { NO_COLOR: "1" }],
		["OCTOCODE_NO_COLOR", [], { OCTOCODE_NO_COLOR: "1" }],
		["--no-color", ["--no-color"], {}],
	])("turns CLI color off for %s", (_name, argv, env: NodeJS.ProcessEnv) => {
		applyNoColor(argv, env);
		expect(chalk.red("x")).toBe("x");
		expect(chalkStderr.red("x")).toBe("x");
	});

	it("exports --no-color so the terminal interface and subagents follow it", () => {
		const env: NodeJS.ProcessEnv = {};
		applyNoColor(["--no-color"], env);
		expect(env.OCTOCODE_NO_COLOR).toBe("1");
	});

	it("keeps color when nothing asks, and ignores empty values", () => {
		applyNoColor([], { NO_COLOR: "", OCTOCODE_NO_COLOR: "" });
		expect(chalk.level).toBe(3);
	});

	it("lets FORCE_COLOR beat NO_COLOR, but not 0 or false", () => {
		applyNoColor([], { NO_COLOR: "1", FORCE_COLOR: "1" });
		expect(chalk.level).toBe(3);
		applyNoColor([], { NO_COLOR: "1", FORCE_COLOR: "0" });
		expect(chalk.red("x")).toBe("x");
	});

	it("lets --color beat NO_COLOR and --no-color beat both", () => {
		const env: NodeJS.ProcessEnv = { NO_COLOR: "1", OCTOCODE_NO_COLOR: "1" };
		applyNoColor(["--color"], env);
		expect(chalk.level).toBe(3);
		expect(env.NO_COLOR).toBeUndefined();
		expect(env.FORCE_COLOR).toBe("1");
		const both: NodeJS.ProcessEnv = { FORCE_COLOR: "1" };
		applyNoColor(["--color", "--no-color"], both);
		expect(chalk.red("x")).toBe("x");
		expect(both.FORCE_COLOR).toBeUndefined();
	});
});

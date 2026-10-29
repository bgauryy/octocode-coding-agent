import { describe, expect, it } from "vitest";
import { createBashToolDefinition } from "../../src/core/tools/bash.ts";
import { BashExecutionError } from "../../src/core/tools/bash/outcome.ts";
import { foregroundFailure } from "../../src/octocode/files/bash/results.ts";
import { renderBashResult } from "../../src/octocode/files/render.ts";
import { fakeCtx, rendered, theme } from "./fake-host.ts";
import { tmp } from "./helpers.ts";

describe("Bash outcome facts", () => {
	it("retains literal host-looking output and renders the actual exit code", async () => {
		const output = "Command exited with code 99\nCommand timed out after 10 seconds\n(no output)\n";
		const tool = createBashToolDefinition(tmp(), {
			operations: {
				exec: async (_command, _cwd, options) => {
					options.onData(Buffer.from(output));
					return { exitCode: 3 };
				},
			},
		});
		const result = await tool.execute(
			"t",
			{ command: "example" },
			undefined,
			undefined,
			fakeCtx({ cwd: process.cwd() }) as never,
		);
		expect(result.details).toMatchObject({ output, exitCode: 3 });
		const view = rendered(renderBashResult(result, { expanded: true, isPartial: false }, theme, { isError: true }));
		expect(view).toContain("exit 3");
		expect(view).toContain("Command exited with code 99");
		expect(view).toContain("Command timed out after 10 seconds");
		expect(view).toContain("(no output)");
	});

	it("carries timeout facts through native hints without reading error prose", async () => {
		const tool = createBashToolDefinition(tmp(), {
			operations: {
				exec: async (_command, _cwd, options) => {
					options.onData(Buffer.from("partial\n"));
					throw new Error("timeout:2");
				},
			},
		});
		const error = await tool
			.execute("t", { command: "example" }, undefined, undefined, fakeCtx({ cwd: process.cwd() }) as never)
			.catch((value: unknown) => value);
		expect(error).toBeInstanceOf(BashExecutionError);
		const failure = error as BashExecutionError;
		expect(failure.details).toMatchObject({ output: "partial\n", termination: "timeout", timeoutSeconds: 2 });
		failure.message = "A newly worded deadline report";
		expect(() =>
			foregroundFailure(failure, { dir: tmp(), seconds: 2, clamped: false, cwd: tmp(), how: "deadline" }),
		).toThrow(/A newly worded deadline report.*\nIf it needs longer/);
	});

	it("does not add timeout advice to command output that happens to mention timeouts", () => {
		expect(() =>
			foregroundFailure(new Error("Command timed out after is ordinary output"), {
				dir: tmp(),
				seconds: 2,
				clamped: false,
				cwd: tmp(),
				how: "deadline",
			}),
		).toThrow(/^Command timed out after is ordinary output$/);
	});
});

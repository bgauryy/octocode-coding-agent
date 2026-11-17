import { describe, expect, it, vi } from "vitest";
import { registerBashTool } from "../../src/octocode/files/bash.ts";
import type * as BashRun from "../../src/octocode/files/bash-run.ts";
import { BashJobs } from "../../src/octocode/files/bash-jobs.ts";
import { CLAMP_NOTE, foregroundFailure } from "../../src/octocode/files/bash/results.ts";
import { BashExecutionError } from "../../src/core/tools/bash/outcome.ts";
import { renderBashResult } from "../../src/octocode/files/render.ts";
import { Subcommands } from "../../src/octocode/shared/commands.ts";
import { fakeCtx, fakeHost, rendered, theme } from "./fake-host.ts";
import { tmp } from "./helpers.ts";

vi.mock("../../src/octocode/files/bash-run.ts", async (importOriginal) => ({
	...(await importOriginal<typeof BashRun>()),
	strayNote: () =>
		"Still running after the command returned (stopped when this session ends): 123 sleep; Stop: kill -- -123",
}));

describe("native Bash host notices", () => {
	it("shows stray-process warnings, clamp notices and receipts to both model and TUI", async () => {
		const { api, tools } = fakeHost();
		registerBashTool(api, new Subcommands(), new BashJobs(tmp()), () => ({}));
		const result = await tools.get("bash").execute(
			"t",
			{
				command: "printf 'unique-command-output\\n'",
				timeout: 4000,
				background: false,
				verify: true,
			},
			undefined,
			undefined,
			fakeCtx({ cwd: tmp() }),
		);
		// A clean exit's verification line would only repeat the header, so it is no notice.
		expect(result.details.notices).toHaveLength(2);
		expect(result.details.output).toBe("unique-command-output\n");
		const modelText = result.content[0].text;
		for (const expanded of [false, true]) {
			const view = rendered(renderBashResult(result, { expanded, isPartial: false }, theme, { isError: false }), 1000);
			for (const notice of result.details.notices) {
				expect(modelText).toContain(notice);
				expect(view).toContain(notice);
			}
			expect(view.match(/unique-command-output/g)).toHaveLength(1);
		}
		expect(modelText.match(/unique-command-output/g)).toHaveLength(1);
		expect(modelText).toContain(CLAMP_NOTE);
	});

	it("keeps timeout recovery guidance visible with structured output", () => {
		const failure = new BashExecutionError("deadline report", {
			output: "partial\n",
			termination: "timeout",
			timeoutSeconds: 2,
		});
		let caught: unknown;
		try {
			foregroundFailure(failure, { dir: tmp(), seconds: 2, clamped: false, cwd: tmp(), how: "deadline" });
		} catch (error) {
			caught = error;
		}
		expect(caught).toBeInstanceOf(BashExecutionError);
		const result = (caught as BashExecutionError).result;
		const view = rendered(
			renderBashResult(result, { expanded: false, isPartial: false }, theme, { isError: true }),
			1000,
		);
		expect(view).toContain("If it needs longer, rerun it");
		expect(view.match(/partial/g)).toHaveLength(1);
	});
});

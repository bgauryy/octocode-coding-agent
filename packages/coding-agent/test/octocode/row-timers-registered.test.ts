import { describe, expect, it } from "vitest";
import { runStart, stopRowTimers } from "../../src/octocode/render/rows.ts";
import { timerTool } from "../../src/octocode/native/tools/notify/tool.ts";

describe("elapsed clocks of tools that wait", () => {
	it("starts the notify tool's row clock when its run begins, not never (the row would read 'waiting' while it runs)", async () => {
		const tool = timerTool({} as never);
		const aborted = AbortSignal.abort();
		await Promise.resolve(
			tool.execute("call-wait-1", { op: "set", after: 60, note: "check the build" }, aborted, undefined, {} as never),
		).catch(() => undefined);
		expect(runStart({ toolCallId: "call-wait-1" }, {})).toBeTypeOf("number");
		stopRowTimers();
	});
});

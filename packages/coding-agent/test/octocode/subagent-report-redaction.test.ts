import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { clearSecretValues, registerSecretValue } from "@octocodeai/octocode-common/sanitize";
import { newChildState, reduceEvent } from "../../src/octocode/subagents/events.ts";
import { ReportTracker } from "../../src/octocode/subagents/report.ts";
import { noticeLines } from "../../src/octocode/subagents/render.ts";

/** Opaque on purpose: no pattern recognizes it, so only a registered value can be removed. */
const KEY = "synthetic0123456789abcdef0123456789";

beforeEach(() => registerSecretValue(KEY));
afterEach(() => clearSecretValues());

describe("a credential in what a child hands its parent", () => {
	it("is removed from a notice at capture: the kept list, the last error and the rendered lines", () => {
		const state = newChildState();
		const limits = { idleMs: 1, hardMs: 1 } as unknown as Parameters<typeof reduceEvent>[2];
		reduceEvent(
			state,
			{
				type: "extension_ui_request",
				method: "notify",
				notifyType: "error",
				message: `401 Incorrect API key ${KEY} for sk-test-0123456789abcdef0123456789`,
			},
			limits,
			0,
		);
		expect(state.notices.lastError).toContain("[redacted]");
		expect(JSON.stringify(state.notices)).not.toContain(KEY);
		expect(JSON.stringify(state.notices)).not.toContain("sk-test-0123456789abcdef0123456789");
		const rendered = noticeLines({
			notices: state.notices,
			compactions: { count: 1, error: `failed: ${KEY}` } as never,
		});
		expect(rendered.join("\n")).not.toContain(KEY);
	});

	it("is removed from the report text, its failure and the structured preview", () => {
		const report = new ReportTracker();
		report.answer(`Done. The key in the file is ${KEY}.`, "stop");
		const result = report.result();
		expect(result.text).toContain("[redacted]");
		expect(result.text).not.toContain(KEY);

		const failed = new ReportTracker();
		failed.answer("partial", "error", `401 bad key ${KEY}`);
		const failure = failed.result();
		expect(failure.error).toContain("[redacted]");
		expect(`${failure.error}${failure.text}`).not.toContain(KEY);
	});
});

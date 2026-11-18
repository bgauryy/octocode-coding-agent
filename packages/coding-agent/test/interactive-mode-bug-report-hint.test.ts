import { type AssistantMessage, fauxAssistantMessage } from "@octocodeai/octocode-ai";
import { describe, expect, test, vi } from "vitest";
import { formatCrashFeatureHint } from "../src/modes/interactive/interactive-mode.ts";
import * as crashReporting from "../src/modes/interactive/interactive-mode/crash-reporting.ts";
import { createFakeHost } from "./interactive-mode-host.ts";

type BugReportHintContext = {
	suggestBugReport(): void;
	maybeShowInstallChangeWarning(): boolean;
};

function maybeSuggestBugReport(context: BugReportHintContext, message: AssistantMessage): void {
	crashReporting.maybeSuggestBugReport(createFakeHost(context), message);
}

function errorMessage(errorMessage: string): AssistantMessage {
	return fauxAssistantMessage("", { stopReason: "error", errorMessage });
}

describe("InteractiveMode bug report hints", () => {
	test("identifies features with frames in a crash stack", () => {
		expect(formatCrashFeatureHint(["npm:pi-observational-memory"])).toBe(
			"A stack frame came from loaded feature `npm:pi-observational-memory`, which may be involved.",
		);
		expect(formatCrashFeatureHint(["a", "b"])).toBe(
			"A stack frame came from loaded features `a` and `b`, which may be involved.",
		);
		expect(formatCrashFeatureHint(undefined)).toBeUndefined();
	});

	test("does not suggest reports for retryable provider failures", () => {
		const context = { suggestBugReport: vi.fn(), maybeShowInstallChangeWarning: vi.fn(() => false) };
		const failures = [
			"500 Internal Server Error",
			"502 Bad Gateway",
			"503 Service Unavailable",
			"504 Gateway Timeout",
			"429 Too Many Requests",
			"Provider overloaded",
			"Network connection lost",
			"Request timed out",
		];

		for (const failure of failures) maybeSuggestBugReport(context, errorMessage(failure));

		expect(context.suggestBugReport).not.toHaveBeenCalled();
	});

	test("does not suggest reports for cancellations", () => {
		const context = { suggestBugReport: vi.fn(), maybeShowInstallChangeWarning: vi.fn(() => false) };

		maybeSuggestBugReport(context, errorMessage("This operation was aborted"));
		maybeSuggestBugReport(context, errorMessage("Request cancelled"));
		maybeSuggestBugReport(context, fauxAssistantMessage("", { stopReason: "aborted" }));

		expect(context.suggestBugReport).not.toHaveBeenCalled();
	});

	test("suggests reports for unexpected errors", () => {
		const context = { suggestBugReport: vi.fn(), maybeShowInstallChangeWarning: vi.fn(() => false) };

		maybeSuggestBugReport(context, errorMessage("Unexpected internal state"));

		expect(context.suggestBugReport).toHaveBeenCalledOnce();
	});

	test("shows the install change warning instead of a bug report hint", () => {
		const context = { suggestBugReport: vi.fn(), maybeShowInstallChangeWarning: vi.fn(() => true) };

		maybeSuggestBugReport(context, errorMessage("Cannot find module './worker.js'"));

		expect(context.maybeShowInstallChangeWarning).toHaveBeenCalledOnce();
		expect(context.suggestBugReport).not.toHaveBeenCalled();
	});
});

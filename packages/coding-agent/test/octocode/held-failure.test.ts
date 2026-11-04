import { fauxAssistantMessage } from "@octocodeai/octocode-ai";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ExtensionAPI } from "../../src/core/features/index.ts";
import { registerNativeSessionLifecycle } from "../../src/octocode/session-lifecycle.ts";
import type { AgentControl } from "../../src/octocode/subagents/tool.ts";
import { createHarness, type Harness } from "../suite/harness.ts";

const FIVE_OH_THREE = "503 Service Unavailable";

/** A session with the native hold and `children` background subagents that report one by one as the test says. */
async function session(children: number, settings: { maxRetries: number } = { maxRetries: 0 }) {
	let live = children;
	let reported: (() => void) | undefined;
	let api!: ExtensionAPI;
	const report = (text: string) => {
		live--;
		void api.sendMessage(
			{ customType: "octocode-agent-result", content: text, display: true },
			{ triggerTurn: true, deliverAs: "followUp" },
		);
		reported?.();
	};
	const agents = {
		background: () => live,
		settle: async () => undefined,
		nextReport: () =>
			new Promise<void>((resolve) => {
				reported = resolve;
			}),
	} as unknown as AgentControl;
	const harness = await createHarness({
		settings: { retry: { enabled: settings.maxRetries > 0, ...settings, baseDelayMs: 1 } },
		extensionFactories: [
			(extension) => {
				api = extension;
				registerNativeSessionLifecycle(extension, {
					isSubagent: false,
					team: { interrupted: new AbortController().signal } as never,
					permission: { shutdown: () => undefined } as never,
					jobs: { settle: async () => undefined } as never,
					agents,
				});
			},
		],
	});
	return { harness, report, live: () => live };
}

describe("a headless parent's failed turn with children running", () => {
	const harnesses: Harness[] = [];
	const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
	afterEach(() => {
		for (const harness of harnesses.splice(0)) harness.cleanup();
		stderr.mockClear();
	});
	const written = () => stderr.mock.calls.map((call) => String(call[0])).join("");

	it("holds through the outage, retries with the next report, and ends completed", async () => {
		const { harness, report, live } = await session(1);
		harnesses.push(harness);
		harness.setResponses([
			fauxAssistantMessage("", { stopReason: "error", errorMessage: FIVE_OH_THREE }),
			fauxAssistantMessage("read the report"),
		]);
		const run = harness.session.prompt("start");
		await vi.waitFor(() => expect(written()).toContain("retrying when the next one reports"));
		expect(harness.session.isIdle).toBe(false);
		expect(harness.faux.state.callCount).toBe(1);

		report("the child's report");
		await run;

		expect(live()).toBe(0);
		expect(harness.faux.state.callCount).toBe(2);
		expect(harness.session.lastRunOutcome?.status).toBe("completed");
		expect(JSON.stringify(harness.session.state.messages)).toContain("the child's report");
		expect(written()).not.toContain("--session");
	});

	it("exits only when no child remains and the retry failed too, naming the resume command", async () => {
		const { harness, report } = await session(1);
		harnesses.push(harness);
		harness.setResponses([
			fauxAssistantMessage("", { stopReason: "error", errorMessage: FIVE_OH_THREE }),
			fauxAssistantMessage("", { stopReason: "error", errorMessage: FIVE_OH_THREE }),
		]);
		const run = harness.session.prompt("start");
		await vi.waitFor(() => expect(written()).toContain("retrying when the next one reports"));
		report("the last report");
		await run;

		expect(harness.faux.state.callCount).toBe(2);
		expect(harness.session.lastRunOutcome?.status).toBe("failed");
		expect(written()).toContain(`octocode --session ${harness.sessionManager.getSessionId()}`);
	});

	it("does not hold on an error waiting cannot clear, and says what it stopped", async () => {
		const { harness } = await session(2);
		harnesses.push(harness);
		harness.setResponses([fauxAssistantMessage("", { stopReason: "error", errorMessage: "401 invalid x-api-key" })]);
		await harness.session.prompt("start");
		expect(harness.session.lastRunOutcome?.status).toBe("failed");
		expect(written()).toContain("stopping 2 running subagents");
		expect(written()).toContain("--session");
	});

	it("stays silent for a failed run with no children", async () => {
		const { harness } = await session(0);
		harnesses.push(harness);
		harness.setResponses([fauxAssistantMessage("", { stopReason: "error", errorMessage: FIVE_OH_THREE })]);
		await harness.session.prompt("start");
		expect(harness.session.lastRunOutcome?.status).toBe("failed");
		expect(written()).toBe("");
	});
});

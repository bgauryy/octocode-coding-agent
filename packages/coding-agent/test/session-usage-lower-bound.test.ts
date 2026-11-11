import { fauxAssistantMessage } from "@octocodeai/octocode-ai";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { handleSessionCommand } from "../src/modes/interactive/interactive-mode/info-commands.ts";
import { initTheme } from "../src/theme/theme.ts";
import { createHarness, type Harness } from "./suite/harness.ts";

const usage = (lowerBound: boolean) => ({
	input: 100,
	output: 1,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens: 101,
	cost: { input: 0.1, output: 0, cacheRead: 0, cacheWrite: 0, total: 0.1 },
	...(lowerBound ? { lowerBound: true } : {}),
});

describe("/session and a stream that dropped before the provider's final count", () => {
	const harnesses: Harness[] = [];
	beforeAll(() => initTheme("dark"));
	afterEach(() => {
		for (const harness of harnesses.splice(0)) harness.cleanup();
	});

	const shown = async (...flags: boolean[]) => {
		const harness = await createHarness();
		harnesses.push(harness);
		for (const flag of flags)
			harness.sessionManager.appendMessage({ ...fauxAssistantMessage("reply"), usage: usage(flag) });
		const children: Array<{ render(width: number): string[] }> = [];
		handleSessionCommand({
			chatContainer: { addChild: (child: never) => children.push(child) },
			session: harness.session,
			sessionManager: harness.sessionManager,
			settingsManager: harness.settingsManager,
			ui: { requestRender: () => undefined },
		} as never);
		return children
			.at(-1)!
			.render(200)
			.join("\n")
			.replace(/\u001b\[[0-9;]*m/g, "");
	};

	it("marks the cost as a lower bound and counts the responses", async () => {
		expect(await shown(true, false, true)).toContain("(at least: 2 responses without the provider's final count)");
	});

	it("says nothing when every count is complete", async () => {
		expect(await shown(false)).not.toContain("at least");
	});
});

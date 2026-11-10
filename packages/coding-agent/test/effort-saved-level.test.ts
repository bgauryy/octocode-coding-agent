import { expect, it, vi } from "vitest";
import { handleThinkingCommand } from "../src/modes/interactive/interactive-mode/model-controls.ts";
import { createFakeHost } from "./interactive-mode-host.ts";

const host = (saved: string | undefined, effective: string) => {
	const context = {
		session: { thinkingLevel: effective, getAvailableThinkingLevels: () => ["off", "low", "high"] },
		settingsManager: { getDefaultThinkingLevel: () => saved },
		showStatus: vi.fn(),
		showSelector: vi.fn(),
	};
	return { context, host: createFakeHost(context) };
};

it("/effort says when the saved default differs from the level the session runs at", () => {
	const differs = host("xhigh", "high");
	handleThinkingCommand(differs.host, undefined);
	expect(differs.context.showStatus).toHaveBeenCalledWith(
		"Saved default thinking level: xhigh; this session runs at high",
	);
	expect(differs.context.showSelector).toHaveBeenCalled();

	const same = host("high", "high");
	handleThinkingCommand(same.host, undefined);
	expect(same.context.showStatus).not.toHaveBeenCalled();
});

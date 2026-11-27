import { describe, expect, test, vi } from "vitest";
import { noticeDisabledProvider } from "../src/core/provider-sources/notice.ts";

function session(disabled: Set<string>, provider = "anthropic", hidden = false) {
	const sendCustomMessage = vi.fn().mockResolvedValue(undefined);
	return {
		sendCustomMessage,
		model: { provider, id: "claude" },
		modelRuntime: {
			isProviderDisabled: (id: string) => disabled.has(id),
			isModelHidden: () => hidden,
			getProvider: () => ({ name: "Anthropic" }),
		},
	} as never as Parameters<typeof noticeDisabledProvider>[0] & { sendCustomMessage: typeof sendCustomMessage };
}

describe("noticeDisabledProvider", () => {
	test("tells the session at its next turn, naming the provider and how to switch", () => {
		const s = session(new Set(["anthropic"]));
		noticeDisabledProvider(s);
		const [message, options] = s.sendCustomMessage.mock.calls[0];
		expect(options).toEqual({ deliverAs: "nextTurn" });
		expect(message.display).toBe("only");
		expect(message.content).toContain("Anthropic (anthropic)");
		expect(message.content).toContain("/model");
		expect(message.content).toContain("/providers");
	});

	test("says it once per provider", () => {
		const s = session(new Set(["anthropic"]));
		noticeDisabledProvider(s);
		noticeDisabledProvider(s);
		expect(s.sendCustomMessage).toHaveBeenCalledTimes(1);
	});

	test("says nothing for an enabled provider", () => {
		const s = session(new Set(["openai"]));
		noticeDisabledProvider(s);
		expect(s.sendCustomMessage).not.toHaveBeenCalled();
	});

	test("tells the session when its own model is hidden, once", () => {
		const s = session(new Set(), "anthropic", true);
		noticeDisabledProvider(s);
		noticeDisabledProvider(s);
		expect(s.sendCustomMessage).toHaveBeenCalledTimes(1);
		expect(s.sendCustomMessage.mock.calls[0][0].content).toContain("anthropic/claude is hidden");
	});
});

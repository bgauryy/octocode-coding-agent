import { describe, expect, test, vi } from "vitest";
import { noticeDisabledProvider } from "../src/core/provider-sources/notice.ts";

function session(disabled: Set<string>, provider = "anthropic") {
	const sendCustomMessage = vi.fn().mockResolvedValue(undefined);
	return {
		sendCustomMessage,
		model: { provider, id: "claude" },
		modelRuntime: {
			isProviderDisabled: (id: string) => disabled.has(id),
			getProvider: () => ({ name: "Anthropic" }),
		},
	} as never as Parameters<typeof noticeDisabledProvider>[0] & { sendCustomMessage: typeof sendCustomMessage };
}

describe("noticeDisabledProvider", () => {
	test("tells the session at its next turn, naming the provider and how to switch", () => {
		const s = session(new Set(["anthropic"]));
		noticeDisabledProvider(s);
		const [message, options] = s.sendCustomMessage.mock.calls[0]!;
		expect(options).toEqual({ deliverAs: "nextTurn" });
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
});

import { afterEach, describe, expect, it, vi } from "vitest";
import type * as Sanitize from "../../../common/src/sanitize.ts";

const calls = vi.hoisted(() => ({ redact: 0, save: 0, saveFails: false }));
vi.mock("../../../common/src/sanitize.ts", async (importOriginal) => {
	const original = await importOriginal<typeof Sanitize>();
	return {
		...original,
		redactSecrets: (text: string) => {
			calls.redact++;
			return original.redactSecrets(text);
		},
	};
});
vi.mock("../../src/octocode/shared/spill.ts", () => ({
	saveContentCopy: () => {
		calls.save++;
		return calls.saveFails ? undefined : "out/api-message.txt";
	},
	saveFullOutput: () => undefined,
}));

const { boundedText } = await import("../../src/octocode/api/bridge/bounded.ts");

afterEach(() => {
	calls.redact = 0;
	calls.save = 0;
	calls.saveFails = false;
});

describe("the bounded text of an API event", () => {
	it("redacts and saves a long answer once when message.delta, message and agent.end each bound it", () => {
		const answer = `token=sk-${"a".repeat(40)} ${"word ".repeat(30_000)}`;
		const first = boundedText(answer);
		// The same text built another way (the streamed deltas joined), then the final message's text.
		expect(boundedText(answer.slice(0, 100) + answer.slice(100))).toBe(first);
		expect(boundedText(answer)).toBe(first);
		expect(calls.redact).toBe(1);
		expect(calls.save).toBe(1);
		expect(first).toContain("out/api-message.txt");
		expect(first).not.toContain(`sk-${"a".repeat(40)}`);
	});

	it("bounds a different answer afresh, and tries a failed save again", () => {
		boundedText("x ".repeat(40_000));
		boundedText("y ".repeat(40_000));
		expect(calls.redact).toBe(2);
		calls.saveFails = true;
		const failed = boundedText("z ".repeat(40_000));
		expect(failed).toContain("could not be saved");
		calls.saveFails = false;
		expect(boundedText("z ".repeat(40_000))).toContain("out/api-message.txt");
		expect(calls.save).toBe(4);
	});

	it("redacts a short text every time without remembering it", () => {
		expect(boundedText("short")).toBe("short");
		expect(boundedText("short")).toBe("short");
		expect(calls.redact).toBe(2);
		expect(calls.save).toBe(0);
	});
});

import { isUsageLimitError, type QuotaReading, UsageLimitError, usageLimitResetAt } from "@octocodeai/octocode-ai";
import { describe, expect, it } from "vitest";
import { ProviderQuotas, type QuotaStore } from "../../src/core/model-runtime/quota-request.ts";
import { ClaudeParser } from "../../src/octocode/external/headless/claude.ts";

const NOW = Date.UTC(2026, 11, 1, 12, 0, 0);
const RESET_S = NOW / 1000 + 2 * 3600;

function memoryStore(): QuotaStore & { written: QuotaReading[] } {
	const written: QuotaReading[] = [];
	return {
		written,
		read: () => [],
		readSince: () => [],
		write: async (readings) => void written.push(...readings),
	};
}

function run(lines: readonly object[]) {
	const store = memoryStore();
	const quotas = new ProviderQuotas(
		() => store,
		() => NOW,
	);
	const parser = new ClaudeParser(
		{ runner: "claude-code", billing: "plan", roots: ["/work/task"], onActivity: () => {} },
		quotas,
	);
	for (const line of lines) parser.line(line as Record<string, unknown>);
	return { quotas, store, reply: () => parser.reply(0, "") };
}

const init = { type: "system", subtype: "init", session_id: "11111111-2222-3333-4444-555555555555" };
const assistant = (text: string) => ({ type: "assistant", message: { content: [{ type: "text", text }] } });
const rateLimit = (info: object) => ({ type: "rate_limit_event", rate_limit_info: info });
const success = {
	type: "result",
	subtype: "success",
	is_error: false,
	result: "done",
	usage: { input_tokens: 10, output_tokens: 5 },
};
const refusedResult = {
	type: "result",
	subtype: "success",
	is_error: true,
	result: "You've hit your limit · resets 2pm (UTC)",
};

describe("Claude Code's rate_limit_event", () => {
	it("records every plan window of the event as a reading of the runner", () => {
		const { quotas, store, reply } = run([
			init,
			rateLimit({
				status: "allowed_warning",
				resetsAt: RESET_S,
				rateLimitType: "five_hour",
				utilization: 0.81,
				unifiedWindows: {
					five_hour: { utilization: 0.81, resetsAt: RESET_S, status: "allowed_warning", surpassedThreshold: 0.75 },
					seven_day: { utilization: 0.3, resetsAt: RESET_S + 4 * 86_400 },
				},
				isUsingOverage: false,
			}),
			assistant("done"),
			success,
		]);
		expect(reply().text).toBe("done");
		expect(quotas.current("claude-code")).toEqual([
			{
				provider: "claude-code",
				window: "five_hour",
				label: "5h",
				usedFraction: 0.81,
				resetsAt: RESET_S * 1000,
				kind: "plan",
				source: "event",
				observedAt: NOW,
			},
			{
				provider: "claude-code",
				window: "seven_day",
				label: "week",
				usedFraction: 0.3,
				resetsAt: (RESET_S + 4 * 86_400) * 1000,
				kind: "plan",
				source: "event",
				observedAt: NOW,
			},
		]);
		expect(store.written.map((reading) => reading.window)).toEqual(["five_hour", "seven_day"]);
	});

	it("records nothing for an allowed event that names no used fraction", () => {
		const { quotas, reply } = run([
			rateLimit({ status: "allowed", resetsAt: RESET_S, rateLimitType: "five_hour", isUsingOverage: false }),
			success,
		]);
		expect(reply().text).toBe("done");
		expect(quotas.current("claude-code")).toEqual([]);
	});

	it("turns a refused window into a usage-limit failure that carries its reset", () => {
		const { quotas, reply } = run([
			init,
			rateLimit({ status: "rejected", resetsAt: RESET_S, rateLimitType: "five_hour", isUsingOverage: false }),
			refusedResult,
		]);
		let failure: unknown;
		try {
			reply();
		} catch (error) {
			failure = error;
		}
		expect(failure).toBeInstanceOf(UsageLimitError);
		const limit = failure as UsageLimitError;
		expect(limit.resetsAt).toBe(RESET_S * 1000);
		expect(limit.window).toBe("five_hour");
		expect(limit.message).toMatch(/^claude-code \(headless\) failed: usage quota exceeded on the 5h window\./);
		expect(limit.message).toContain("You've hit your limit");
		// Classified as a usage limit by text too, and its reset reads back through the shared reader.
		expect(isUsageLimitError(limit.message)).toBe(true);
		expect(usageLimitResetAt(limit, NOW)).toBe(RESET_S * 1000);
		expect(quotas.current("claude-code")).toMatchObject([{ window: "five_hour", usedFraction: 1 }]);
	});

	it("lets a refused window that extra usage pays for end the turn normally", () => {
		const { reply } = run([
			rateLimit({ status: "rejected", resetsAt: RESET_S, rateLimitType: "five_hour", isUsingOverage: true }),
			success,
		]);
		expect(reply().text).toBe("done");
	});

	it("reads the CLI's own usage-limit words when no event came, without a reset", () => {
		const { reply } = run([refusedResult]);
		expect(reply).toThrow(UsageLimitError);
		try {
			reply();
		} catch (error) {
			expect((error as UsageLimitError).resetsAt).toBeUndefined();
		}
	});

	it("keeps other failures as plain errors", () => {
		const { reply } = run([{ type: "result", subtype: "error_during_execution", is_error: true, result: "boom" }]);
		expect(reply).toThrow("claude-code (headless) failed: boom");
		try {
			reply();
		} catch (error) {
			expect(error).not.toBeInstanceOf(UsageLimitError);
		}
	});
});

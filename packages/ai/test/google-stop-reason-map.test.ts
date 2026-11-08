import { FinishReason } from "@google/genai";
import { describe, expect, it } from "vitest";
import { mapStopReason } from "../src/api/google-shared/response.ts";

describe("Gemini finish reason mapping", () => {
	it("maps CONTINUATION, a stop at the per-request token limit, to length", () => {
		expect(mapStopReason(FinishReason.CONTINUATION)).toBe("length");
	});

	it("keeps MAX_TOKENS as length and STOP as stop", () => {
		expect(mapStopReason(FinishReason.MAX_TOKENS)).toBe("length");
		expect(mapStopReason(FinishReason.STOP)).toBe("stop");
	});
});

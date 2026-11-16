import { describe, expect, it } from "vitest";
import { stream } from "../src/api/bedrock-converse-stream.ts";
import { bedrockModel, bedrockContext, bedrockResponse } from "./bedrock-fixtures.ts";
const id = "11111111-2222-3333-4444-555555555555";
const diagnostic = (message: Awaited<ReturnType<ReturnType<typeof stream>["result"]>>) =>
	message.diagnostics?.find((d) => d.type === "bedrock_response_failure");
describe("Bedrock error metadata", () => {
	it.each(["ValidationException", "Unknown", `${"E".repeat(5000)}Exception`])(
		"records HTTP status/request id and bounded provider code %s",
		async (code) => {
			const result = await stream(bedrockModel, bedrockContext, {
				bearerToken: "fixture-token",
				fetch: async () =>
					new Response('{"message":"Invalid model"}', {
						status: 400,
						headers: { "x-amzn-requestid": id, "x-amzn-errortype": code },
					}),
			}).result();
			expect(result.stopReason).toBe("error");
			expect(diagnostic(result)?.details).toEqual({
				status: 400,
				requestId: id,
				...(code === "ValidationException" ? { errorCode: code } : {}),
			});
			expect(diagnostic(result)?.error).toBeUndefined();
			expect(Object.keys(diagnostic(result) ?? {}).sort()).toEqual(["details", "timestamp", "type"]);
		},
	);
	it.each([
		[400, "ValidationException:http://internal.amazon.com/coral/com.amazon.bedrock/", "Validation error: "],
		[429, "ThrottlingException", "Throttling error: "],
		[500, "InternalServerException", "Internal server error: "],
		[503, "ServiceUnavailableException", "Service unavailable: "],
	])("keeps the legacy prefix for an HTTP %i %s", async (status, code, prefix) => {
		const result = await stream(bedrockModel, bedrockContext, {
			bearerToken: "fixture-token",
			maxRetries: 0,
			fetch: async () => new Response('{"message":"Invalid model"}', { status, headers: { "x-amzn-errortype": code } }),
		}).result();
		expect(result.stopReason).toBe("error");
		expect(result.errorMessage?.startsWith(prefix)).toBe(true);
		expect(result.errorMessage).toContain("Invalid model");
	});
	it("drops oversized request ids", async () => {
		const result = await stream(bedrockModel, bedrockContext, {
			bearerToken: "fixture-token",
			fetch: async () =>
				new Response('{"message":"Invalid model"}', { status: 400, headers: { "x-amzn-requestid": "R".repeat(5000) } }),
		}).result();
		expect(diagnostic(result)?.details).toEqual({ status: 400 });
	});
	it("correlates a mid-stream exception to the response request id", async () => {
		const result = await stream(bedrockModel, bedrockContext, {
			bearerToken: "fixture-token",
			fetch: async () =>
				bedrockResponse(
					[{ messageStart: { role: "assistant" } }, { modelStreamErrorException: { message: "stream failed" } }],
					{ "x-amzn-requestid": id },
				),
		}).result();
		expect(result.stopReason).toBe("error");
		expect(diagnostic(result)?.details).toEqual({ requestId: id, errorCode: "ModelStreamErrorException" });
	});
	it("does not invent metadata for a transport failure", async () => {
		const result = await stream(bedrockModel, bedrockContext, {
			bearerToken: "fixture-token",
			fetch: async () => {
				throw new Error("socket hang up");
			},
		}).result();
		expect(result.stopReason).toBe("error");
		expect(result.errorMessage).toContain("socket hang up");
		expect(diagnostic(result)).toBeUndefined();
	});
	it("does not report diagnostics on abort", async () => {
		const result = await stream(bedrockModel, bedrockContext, {
			bearerToken: "fixture-token",
			signal: AbortSignal.abort(),
			fetch: async () => {
				throw new Error("must not fetch");
			},
		}).result();
		expect(result.stopReason).toBe("aborted");
		expect(diagnostic(result)).toBeUndefined();
	});
});

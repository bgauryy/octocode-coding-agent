import { afterEach, describe, expect, it, vi } from "vitest";
import { validateOpenAIIdToken } from "../src/auth/oauth/openai-id-token.ts";
import { openAIJwks, signedOpenAIIdToken } from "./openai-id-token-fixtures.ts";

const signal = new AbortController().signal;
const validate = (token: string) => validateOpenAIIdToken(token, "oaiapp_issued", "nonce", signal);

describe("ChatGPT OIDC identity validation", () => {
	afterEach(() => vi.unstubAllGlobals());

	function stubKeys(body: unknown = openAIJwks) {
		const fetchMock = vi.fn(async (url: string, options: RequestInit) => {
			expect(url).toBe("https://auth.openai.com/.well-known/jwks.json");
			expect(options.redirect).toBe("error");
			return Response.json(body);
		});
		vi.stubGlobal("fetch", fetchMock);
		return fetchMock;
	}

	it("accepts a signed token bound to this client and authorization attempt", async () => {
		stubKeys();
		await expect(validate(signedOpenAIIdToken("nonce"))).resolves.toBe("test-subject");
	});

	it("accepts multiple audiences only when the authorized party names this client", async () => {
		stubKeys();
		await expect(
			validate(signedOpenAIIdToken("nonce", { aud: ["oaiapp_issued", "other-client"], azp: "oaiapp_issued" })),
		).resolves.toBe("test-subject");
		await expect(validate(signedOpenAIIdToken("nonce", { azp: "other-client" }))).rejects.toThrow("issuer or audience");
	});

	it("rejects ambiguous signing keys rather than accepting the first matching key", async () => {
		stubKeys({ keys: [...openAIJwks.keys, ...openAIJwks.keys] });
		await expect(validate(signedOpenAIIdToken("nonce"))).rejects.toThrow("ambiguous");
	});

	it("rejects a token without an expiration", async () => {
		stubKeys();
		await expect(validate(signedOpenAIIdToken("nonce", { exp: undefined }))).rejects.toThrow("expired");
	});

	it("does not fetch signing keys after the login attempt is cancelled", async () => {
		const fetchMock = stubKeys();
		const aborted = AbortSignal.abort(new Error("Login cancelled"));
		await expect(
			validateOpenAIIdToken(signedOpenAIIdToken("nonce"), "oaiapp_issued", "nonce", aborted),
		).rejects.toThrow("Login cancelled");
		expect(fetchMock).not.toHaveBeenCalled();
	});

	it.each([false, true])(
		"releases a failed signing-key response when cancellation rejects=%s",
		async (rejectCancel) => {
			const cancel = vi.fn(async () => {
				if (rejectCancel) throw new Error("Response cancellation failed");
			});
			const body = new ReadableStream<Uint8Array>({
				start(controller) {
					controller.enqueue(new TextEncoder().encode("service unavailable"));
				},
				cancel,
			});
			vi.stubGlobal(
				"fetch",
				vi.fn(async () => new Response(body, { status: 503 })),
			);

			await expect(validate(signedOpenAIIdToken("nonce"))).rejects.toThrow("OpenAI signing key request failed (503)");
			expect(cancel).toHaveBeenCalledOnce();
		},
	);

	it("preserves the signing-key HTTP error when the response has no body", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn(async () => new Response(null, { status: 503 })),
		);
		await expect(validate(signedOpenAIIdToken("nonce"))).rejects.toThrow("OpenAI signing key request failed (503)");
	});

	it.each([
		[{ iss: "https://attacker.example" }, "issuer or audience"],
		[{ aud: "another-client" }, "issuer or audience"],
		[{ aud: ["oaiapp_issued", "other-client"] }, "issuer or audience"],
		[{ exp: 0 }, "expired"],
		[{ nbf: 1e12 }, "not yet valid"],
		[{ nonce: "another-attempt" }, "nonce mismatch"],
		[{ sub: "" }, "no subject"],
	] as const)("rejects invalid identity claims %j", async (claims, message) => {
		stubKeys();
		await expect(validate(signedOpenAIIdToken("nonce", claims))).rejects.toThrow(message);
	});

	it("rejects tampering with an otherwise valid signed token", async () => {
		stubKeys();
		const [header, payload, signature] = signedOpenAIIdToken("nonce").split(".");
		const claims = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
		const forgedPayload = Buffer.from(JSON.stringify({ ...claims, sub: "attacker" })).toString("base64url");
		await expect(validate(`${header}.${forgedPayload}.${signature}`)).rejects.toThrow("signature");
	});

	it("rejects unknown signing keys", async () => {
		stubKeys({ keys: [] });
		await expect(validate(signedOpenAIIdToken("nonce"))).rejects.toThrow("signing key not found");
	});

	it("rejects unsigned tokens without fetching keys", async () => {
		const fetchMock = stubKeys();
		const header = Buffer.from(JSON.stringify({ alg: "none", kid: "test-key" })).toString("base64url");
		await expect(validate(`${header}.e30.c2ln`)).rejects.toThrow("algorithm");
		expect(fetchMock).not.toHaveBeenCalled();
	});
});

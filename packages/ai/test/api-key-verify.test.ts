import { afterEach, describe, expect, it, vi } from "vitest";
import { CLAUDE_SUBSCRIPTION_TOKEN_REFUSAL } from "../src/api/anthropic-messages/token.ts";
import { InMemoryCredentialStore } from "../src/auth/credential-store.ts";
import { loginProvider } from "../src/models/auth.ts";
import { anthropicProvider } from "../src/providers/anthropic.ts";
import { opencodeGoProvider } from "../src/providers/opencode-go.ts";
import { opencodeProvider } from "../src/providers/opencode.ts";
import { openaiProvider } from "../src/providers/openai.ts";
import type { AuthEvent } from "../src/auth/types.ts";
import { verifyByRequest } from "../src/auth/verify.ts";

async function signIn(id: string, key: string, status: number | Error) {
	const fetchMock = vi.fn(async () => {
		if (status instanceof Error) throw status;
		return new Response("{}", { status });
	});
	vi.stubGlobal("fetch", fetchMock);
	const store = new InMemoryCredentialStore();
	const events: AuthEvent[] = [];
	const factories: Record<string, () => unknown> = {
		anthropic: anthropicProvider,
		opencode: opencodeProvider,
		"opencode-go": opencodeGoProvider,
	};
	const providers = new Map([[id, (factories[id] ?? openaiProvider)()]]);
	const outcome = await loginProvider(providers as never, store, id, "api_key", {
		prompt: async () => key,
		notify: (event) => events.push(event),
	}).then(
		() => "saved",
		(error: Error) => error.message,
	);
	return { outcome, saved: await store.read(id), events, fetchMock };
}

afterEach(() => vi.unstubAllGlobals());

describe("API key verification at sign-in", () => {
	it("refuses a key the provider answers with 401 and saves nothing", async () => {
		const { outcome, saved } = await signIn("openai", "sk-bad", 401);
		expect(outcome).toContain("rejected this key");
		expect(saved).toBeUndefined();
	});

	it.each(["openai", "anthropic"])("saves a restricted %s key when its model list denies permission", async (id) => {
		const { outcome, saved, events } = await signIn(id, "restricted-fixture-key", 403);
		expect(outcome).toBe("saved");
		expect(saved).toMatchObject({ type: "api_key", key: "restricted-fixture-key" });
		expect(events).toContainEqual(
			expect.objectContaining({ type: "info", message: expect.stringContaining("HTTP 403") }),
		);
	});

	it.each([200, 401, 403, 503])(
		"releases the HTTP %s verification body without following redirects",
		async (status) => {
			const cancel = vi.fn();
			const body = new ReadableStream<Uint8Array>({ cancel });
			const fetchMock = vi.fn(async () => new Response(body, { status }));
			vi.stubGlobal("fetch", fetchMock);
			await verifyByRequest("https://example.test/models", { "x-api-key": "fixture" }, new AbortController().signal);
			expect(cancel).toHaveBeenCalledOnce();
			expect(fetchMock).toHaveBeenCalledWith(
				"https://example.test/models",
				expect.objectContaining({ redirect: "error" }),
			);
		},
	);

	it("saves a key the model list accepts, asking the free endpoint with the key", async () => {
		const { outcome, saved, fetchMock } = await signIn("openai", "sk-good", 200);
		expect(outcome).toBe("saved");
		expect(saved).toMatchObject({ type: "api_key", key: "sk-good" });
		expect(fetchMock).toHaveBeenCalledWith(
			"https://api.openai.com/v1/models",
			expect.objectContaining({ headers: { Authorization: "Bearer sk-good" } }),
		);
	});

	it("saves with a warning when the network fails", async () => {
		const { outcome, saved, events } = await signIn("openai", "sk-good", new TypeError("fetch failed"));
		expect(outcome).toBe("saved");
		expect(saved).toBeDefined();
		expect(events).toContainEqual(
			expect.objectContaining({ type: "info", message: expect.stringContaining("saved anyway") }),
		);
	});

	it("saves with a warning on a server error, which is not a refusal", async () => {
		const { outcome, events } = await signIn("openai", "sk-good", 503);
		expect(outcome).toBe("saved");
		expect(events).toContainEqual(expect.objectContaining({ message: expect.stringContaining("saved anyway") }));
	});

	it("refuses a Claude subscription token without a network call, saves nothing and names the external agent", async () => {
		const { outcome, saved, fetchMock } = await signIn("anthropic", "sk-ant-oat01-token", 200);
		expect(outcome).toBe(CLAUDE_SUBSCRIPTION_TOKEN_REFUSAL);
		expect(outcome).not.toContain("sk-ant-oat01-token");
		expect(saved).toBeUndefined();
		expect(fetchMock).not.toHaveBeenCalled();
	});

	it.each([
		["opencode", "https://opencode.ai/inference/v1/models"],
		["opencode-go", "https://opencode.ai/inference/go/v1/models"],
	])("checks a %s key against its free model list and refuses a 401", async (id, url) => {
		const bad = await signIn(id, "oc-bad", 401);
		expect(bad.outcome).toContain("rejected this key");
		expect(bad.saved).toBeUndefined();
		const good = await signIn(id, "  oc-good\n", 200);
		expect(good.saved).toMatchObject({ type: "api_key", key: "oc-good" });
		expect(good.fetchMock).toHaveBeenCalledWith(
			url,
			expect.objectContaining({ headers: { Authorization: "Bearer oc-good" } }),
		);
	});

	it("trims a pasted Anthropic key and saves nothing for an empty one", async () => {
		const good = await signIn("anthropic", "  sk-ant-api03-good\n", 200);
		expect(good.saved).toMatchObject({ type: "api_key", key: "sk-ant-api03-good" });
		const empty = await signIn("anthropic", " \n", 200);
		expect(empty.outcome).toBe("No Anthropic API key was entered. Nothing was saved.");
		expect(empty.saved).toBeUndefined();
		expect(empty.fetchMock).not.toHaveBeenCalled();
	});

	it("saves nothing when the key prompt is answered empty", async () => {
		const { outcome, saved, fetchMock } = await signIn("opencode", "   ", 200);
		expect(outcome).toContain("Nothing was saved");
		expect(saved).toBeUndefined();
		expect(fetchMock).not.toHaveBeenCalled();
	});
});

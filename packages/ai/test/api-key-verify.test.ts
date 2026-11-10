import { afterEach, describe, expect, it, vi } from "vitest";
import { InMemoryCredentialStore } from "../src/auth/credential-store.ts";
import { loginProvider } from "../src/models/auth.ts";
import { anthropicProvider } from "../src/providers/anthropic.ts";
import { openaiProvider } from "../src/providers/openai.ts";
import type { AuthEvent } from "../src/auth/types.ts";

async function signIn(id: string, key: string, status: number | Error) {
	const fetchMock = vi.fn(async () => {
		if (status instanceof Error) throw status;
		return new Response("{}", { status });
	});
	vi.stubGlobal("fetch", fetchMock);
	const store = new InMemoryCredentialStore();
	const events: AuthEvent[] = [];
	const providers = new Map([[id, id === "anthropic" ? anthropicProvider() : openaiProvider()]]);
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

	it("refuses on 403 too", async () => {
		expect((await signIn("anthropic", "sk-ant-api03-bad", 403)).outcome).toContain("rejected this key");
	});

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

	it("does not check an Anthropic subscription token", async () => {
		const { outcome, fetchMock } = await signIn("anthropic", "sk-ant-oat01-token", 401);
		expect(outcome).toBe("saved");
		expect(fetchMock).not.toHaveBeenCalled();
	});
});

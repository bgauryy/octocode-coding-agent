import { describe, expect, it } from "vitest";
import { handleCommand, type RpcCommandHost } from "../src/modes/rpc/rpc-mode/commands.ts";

const SECRET_URL = "https://user:secret@host.example/v1?key=abc&api-version=1";

const model = {
	provider: "acme",
	id: "m1",
	name: "m1",
	api: "openai-completions",
	baseUrl: SECRET_URL,
} as never;

function host(): RpcCommandHost {
	return {
		session: {
			model,
			messages: [],
			modelRuntime: { getAvailableSnapshot: () => [model], allowsUnattendedUse: () => true },
			setModel: async () => {},
			cycleModel: async () => ({ model, thinkingLevel: "off", isScoped: false }),
		},
		rpc: undefined,
		runtimeHost: {},
		output: () => {},
	} as unknown as RpcCommandHost;
}

function expectNoSecret(response: unknown): void {
	const text = JSON.stringify(response);
	expect(text).not.toContain("secret");
	expect(text).not.toContain("user:");
	expect(text).not.toContain("abc");
	expect(text).toContain("host.example/v1");
	expect(text).toContain("api-version=1");
}

describe("RPC model replies", () => {
	it.each([
		["get_state", { type: "get_state" }],
		["get_available_models", { type: "get_available_models" }],
		["set_model", { type: "set_model", provider: "acme", modelId: "m1" }],
		["cycle_model", { type: "cycle_model" }],
	] as const)("%s carries no credential from the baseUrl", async (_name, command) => {
		const response = await handleCommand(host(), command);

		expect(response).toMatchObject({ success: true });
		expectNoSecret(response);
	});

	it("does not change the session's own model object", async () => {
		await handleCommand(host(), { type: "get_available_models" });

		expect((model as { baseUrl: string }).baseUrl).toBe(SECRET_URL);
	});
});

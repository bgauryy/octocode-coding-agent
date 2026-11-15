import { createAssistantMessageEventStream } from "@octocodeai/octocode-ai/compat";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AuthStorage } from "../src/core/auth-storage.ts";
import { ModelRegistry } from "../src/core/model-registry.ts";
import { testProviderCredential } from "../src/modes/interactive/interactive-mode/provider-test.ts";
import { providerHealth } from "../src/octocode/subagents/provider-health.ts";
import { createInMemoryModelRegistry, getModelRuntime } from "./model-runtime-test-utils.ts";

const REFUSAL = '429 {"type":"error","error":{"type":"FreeUsageLimitError"}}';

describe("Test credential", () => {
	afterEach(() => {
		vi.restoreAllMocks();
		vi.unstubAllGlobals();
	});

	it("sends a request even when the provider's model list accepts the key", async () => {
		const authStorage = AuthStorage.inMemory();
		await authStorage.modify("opencode", async () => ({ type: "api_key", key: "test-key" }));
		const registry = await createInMemoryModelRegistry(authStorage);
		// The model list answers 200 for any key; only a request shows the refusal.
		const fetchList = vi.fn(async () => new Response(JSON.stringify({ data: [] }), { status: 200 }));
		vi.stubGlobal("fetch", fetchList);
		const requested: string[] = [];
		vi.spyOn(ModelRegistry.prototype, "streamSimple").mockImplementation((model) => {
			requested.push(model.id);
			const stream = createAssistantMessageEventStream();
			const message = {
				role: "assistant" as const,
				content: [],
				api: model.api,
				provider: model.provider,
				model: model.id,
				usage: {
					input: 0,
					output: 0,
					cacheRead: 0,
					cacheWrite: 0,
					totalTokens: 0,
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
				},
				stopReason: "error" as const,
				errorMessage: REFUSAL,
				timestamp: Date.now(),
			};
			queueMicrotask(() => stream.push({ type: "error", reason: "error", error: message }));
			return stream;
		});
		const shown = { status: [] as string[], error: [] as string[], warning: [] as string[] };
		const host = {
			session: { modelRuntime: getModelRuntime(registry), model: undefined },
			showStatus: (text: string) => shown.status.push(text),
			showError: (text: string) => shown.error.push(text),
			showWarning: (text: string) => shown.warning.push(text),
		};

		await testProviderCredential(host as never, "opencode", "OpenCode Zen");

		expect(requested.length).toBeGreaterThan(0);
		expect(fetchList).not.toHaveBeenCalled();
		expect(shown.error.join("\n")).toContain("FreeUsageLimitError");
		expect(providerHealth.get("opencode")?.via).toBe("check");
	});
});

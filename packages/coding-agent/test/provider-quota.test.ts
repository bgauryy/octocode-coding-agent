import {
	type AssistantMessage,
	createAssistantMessageEventStream,
	fauxAssistantMessage,
	type Model,
	type Provider,
	type QuotaReading,
	type SimpleStreamOptions,
} from "@octocodeai/octocode-ai";
import { describe, expect, it, vi } from "vitest";
import {
	agentDbQuotaStore,
	ProviderQuotas,
	providerQuotas,
	QUOTA_WRITE_INTERVAL_MS,
	type QuotaStore,
	quotaStep,
} from "../src/core/model-runtime/quota-request.ts";
import { type ModelRequestHost, streamSimpleChatModel } from "../src/core/model-runtime/requests.ts";

const START = Date.UTC(2026, 10, 23, 12, 0, 0);
const START_S = START / 1000;

function clockAt(start = START) {
	const clock = { now: start };
	return { clock, now: () => clock.now };
}

/** A store two "processes" share, kept like the database rows: the later observation of a window wins. */
function sharedStore(): QuotaStore & { rows: Map<string, QuotaReading>; writes: QuotaReading[][] } {
	const rows = new Map<string, QuotaReading>();
	const writes: QuotaReading[][] = [];
	return {
		rows,
		writes,
		read: (provider) => [...rows.values()].filter((row) => row.provider === provider),
		readSince: (since) => [...rows.values()].filter((row) => row.observedAt >= since),
		write: async (readings) => {
			writes.push(readings);
			for (const reading of readings) {
				const key = `${reading.provider}/${reading.window}`;
				const stored = rows.get(key);
				if (!stored || reading.observedAt >= stored.observedAt) rows.set(key, reading);
			}
		},
	};
}

/** ChatGPT plan headers: a 5-hour window `used` percent full, resetting at `resetAt` (seconds), and a weekly one. */
const codexHeaders = (used: number, resetAt = START_S + 7_200): Record<string, string> => ({
	"x-codex-primary-used-percent": String(used),
	"x-codex-primary-window-minutes": "300",
	"x-codex-primary-reset-at": String(resetAt),
	"x-codex-secondary-used-percent": "18",
	"x-codex-secondary-window-minutes": "10080",
	"x-codex-secondary-reset-at": String(START_S + 5 * 86_400),
});

describe("provider quotas", () => {
	it("writes a provider's readings at most once per interval, but at once when a plan window crosses a mark", () => {
		const store = sharedStore();
		const { clock, now } = clockAt();
		const quotas = new ProviderQuotas(() => store, now);
		quotas.recordHeaders("openai", codexHeaders(40));
		expect(store.writes).toHaveLength(1);
		expect(store.writes[0].map((reading) => reading.window)).toEqual(["primary", "secondary"]);

		clock.now += 10_000;
		quotas.recordHeaders("openai", codexHeaders(55));
		expect(store.writes).toHaveLength(1);
		// This process sees its own latest reading at once.
		expect(quotas.current("openai")[0]).toMatchObject({ window: "primary", label: "5h", usedFraction: 0.55 });

		clock.now += 1_000;
		quotas.recordHeaders("openai", codexHeaders(71));
		expect(store.writes).toHaveLength(2);

		clock.now += 1_000;
		quotas.recordHeaders("openai", codexHeaders(72, START_S + 7_200 + 3_600));
		expect(store.writes).toHaveLength(3);

		clock.now += QUOTA_WRITE_INTERVAL_MS - 1;
		quotas.recordHeaders("openai", codexHeaders(73, START_S + 7_200 + 3_600));
		expect(store.writes).toHaveLength(3);
		clock.now += 1;
		quotas.recordHeaders("openai", codexHeaders(73, START_S + 7_200 + 3_600));
		expect(store.writes).toHaveLength(4);
	});

	it("throttles rate readings by provider and never writes a response without quota headers", () => {
		const store = sharedStore();
		const { clock, now } = clockAt();
		const quotas = new ProviderQuotas(() => store, now);
		const rate = (remaining: number) => ({
			"x-ratelimit-limit-requests": "100",
			"x-ratelimit-remaining-requests": String(remaining),
			"x-ratelimit-reset-requests": "30s",
		});
		quotas.recordHeaders("openai", rate(90));
		quotas.recordHeaders("groq", rate(10));
		clock.now += 5_000;
		quotas.recordHeaders("openai", rate(5));
		quotas.recordHeaders("openai", { "content-type": "application/json" });
		expect(store.writes.map((readings) => readings[0].provider)).toEqual(["openai", "groq"]);
		expect(quotas.providers()).toEqual(["openai", "groq"]);
	});

	it("joins another process's later readings and drops the ones whose window already reset", () => {
		const store = sharedStore();
		const { clock, now } = clockAt();
		const mine = new ProviderQuotas(() => store, now);
		const peer = new ProviderQuotas(() => store, now);
		mine.recordHeaders("openai", codexHeaders(40));
		clock.now += 1_000;
		peer.recordHeaders("openai", codexHeaders(80));
		clock.now += 10_000;
		expect(mine.current("openai").map((reading) => reading.usedFraction)).toEqual([0.8, 0.18]);
		expect(mine.all().map((reading) => `${reading.provider}/${reading.window}`)).toEqual([
			"openai/primary",
			"openai/secondary",
		]);
		clock.now = (START_S + 7_200) * 1000 + 1;
		expect(mine.current("openai").map((reading) => reading.window)).toEqual(["secondary"]);
	});

	it("keeps its own readings when the store fails, and says so once", () => {
		const errors: unknown[] = [];
		const quotas = new ProviderQuotas(
			() => {
				throw new Error("database is locked");
			},
			() => START,
			(error) => errors.push(error),
		);
		quotas.recordHeaders("openai", codexHeaders(40));
		expect(quotas.current("openai")).toHaveLength(2);
		expect(errors).toHaveLength(1);
	});

	it("runs the caller's response hook after recording, and keeps its failure", async () => {
		const quotas = new ProviderQuotas(
			() => sharedStore(),
			() => START,
		);
		const seen: string[] = [];
		const hook = quotaStep(
			{ provider: "openai" },
			{ onResponse: (response) => void seen.push(String(response.status)) },
			quotas,
		);
		await hook({ status: 200, headers: codexHeaders(10) }, {});
		expect(seen).toEqual(["200"]);
		expect(quotas.current("openai")).toHaveLength(2);
		const failing = quotaStep(
			{ provider: "openai" },
			{
				onResponse: () => {
					throw new Error("refused by the caller");
				},
			},
			quotas,
		);
		expect(() => failing({ status: 200, headers: {} }, {})).toThrow("refused by the caller");
	});
});

const model = (provider: string): Model<"openai-responses"> => ({
	id: "m",
	name: "m",
	api: "openai-responses",
	provider,
	baseUrl: "https://example.invalid",
	reasoning: false,
	input: ["text"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 100_000,
	maxTokens: 1_000,
});

/** A host whose provider hands each request's options a response with `headers`, as the transport does. */
function hostResponding(headers: Record<string, string>): ModelRequestHost {
	const provider = {
		streamSimple: (requestModel: Model<"openai-responses">, _context: unknown, options?: SimpleStreamOptions) => {
			const stream = createAssistantMessageEventStream();
			const reply: AssistantMessage = fauxAssistantMessage("done");
			void Promise.resolve(options?.onResponse?.({ status: 200, headers }, requestModel)).then(() => {
				stream.push({ type: "done", reason: "stop", message: reply });
				stream.end(reply);
			});
			return stream;
		},
	} as unknown as Provider;
	return {
		getProvider: () => provider,
		getAuth: async () => ({ auth: { apiKey: "key" } }),
		getCachePolicy: () => ({ options: {} }) as ReturnType<ModelRequestHost["getCachePolicy"]>,
		resolveModel: async () => {
			throw new Error("not routed");
		},
		streamSimple: () => {
			throw new Error("not used");
		},
	};
}

describe("a chat request through the runtime", () => {
	it("stores the quota its response's headers carry, where another process reads it", async () => {
		const provider = `quota-test-${process.pid}-${Date.now()}`;
		const resetAt = Math.floor(Date.now() / 1000) + 3_600;
		const headers = codexHeaders(62, resetAt);
		const callerSaw: number[] = [];
		const result = await streamSimpleChatModel(
			hostResponding(headers),
			model(provider),
			{ messages: [] },
			{ onResponse: (response) => void callerSaw.push(response.status) },
		).result();
		expect(result.stopReason).toBe("stop");
		expect(callerSaw).toEqual([200]);
		expect(providerQuotas.current(provider)[0]).toMatchObject({ usedFraction: 0.62, resetsAt: resetAt * 1000 });
		await vi.waitFor(() =>
			expect(
				agentDbQuotaStore()
					.read(provider)
					.map((reading) => [reading.window, reading.usedFraction]),
			).toEqual([
				["primary", 0.62],
				["secondary", 0.18],
			]),
		);
	});
});

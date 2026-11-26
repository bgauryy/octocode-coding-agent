import { describe, expect, it } from "vitest";
import { withCredentialRenewal } from "../src/models/credential-renewal.ts";
import type { AssistantMessage, AssistantMessageEvent } from "../src/types.ts";

function message(overrides: Partial<AssistantMessage> = {}): AssistantMessage {
	return {
		role: "assistant",
		content: [],
		api: "openai-completions",
		provider: "gw",
		model: "m",
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "stop",
		timestamp: 0,
		...overrides,
	};
}

async function* events(...list: AssistantMessageEvent[]): AsyncGenerator<AssistantMessageEvent> {
	yield* list;
}

const refused = (): AssistantMessageEvent[] => [
	{ type: "start", partial: message() },
	{
		type: "error",
		reason: "error",
		error: message({ stopReason: "error", errorMessage: "401 Unauthorized: invalid api key" }),
	},
];
const answered = (): AssistantMessageEvent[] => [
	{ type: "start", partial: message() },
	{ type: "done", reason: "stop", message: message() },
];

async function collect(stream: AsyncIterable<AssistantMessageEvent>): Promise<string[]> {
	const types: string[] = [];
	for await (const event of stream) types.push(event.type);
	return types;
}

describe("withCredentialRenewal", () => {
	it("renews a refused command key once and shows only the retry", async () => {
		let attempts = 0;
		let renewed = 0;
		const types = await collect(
			withCredentialRenewal(async () => {
				attempts++;
				return { events: events(...(attempts === 1 ? refused() : answered())), renew: () => renewed++ };
			}),
		);
		expect({ attempts, renewed, types }).toEqual({ attempts: 2, renewed: 1, types: ["start", "done"] });
	});

	it("retries at most once", async () => {
		let attempts = 0;
		const types = await collect(
			withCredentialRenewal(async () => {
				attempts++;
				return { events: events(...refused()), renew: () => {} };
			}),
		);
		expect(attempts).toBe(2);
		expect(types).toEqual(["start", "error"]);
	});

	it("does not retry without renew or for other errors", async () => {
		let attempts = 0;
		await collect(
			withCredentialRenewal(async () => {
				attempts++;
				return { events: events(...refused()) };
			}),
		);
		const overloaded: AssistantMessageEvent = {
			type: "error",
			reason: "error",
			error: message({ stopReason: "error", errorMessage: "529 overloaded" }),
		};
		await collect(
			withCredentialRenewal(async () => {
				attempts++;
				return { events: events(overloaded), renew: () => {} };
			}),
		);
		expect(attempts).toBe(2);
	});
});

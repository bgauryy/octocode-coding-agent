import { fauxAssistantMessage } from "@octocodeai/octocode-ai";
import { afterEach, expect, it } from "vitest";
import { createHarness, type Harness } from "./suite/harness.ts";

let harness: Harness | undefined;
afterEach(() => {
	harness?.cleanup();
	harness = undefined;
});

/** About `tokens` of context: the estimate counts three characters a token. */
const filler = (tokens: number, label: string) => `${label} ${"x".repeat(tokens * 3)}`;

/** A session on a virtual model routed to a 50k-token model, whose compaction a hook declines, and a request over the threshold. */
async function routedSession(virtual: boolean) {
	const attempts: string[] = [];
	harness = await createHarness({
		models: [{ id: "large", contextWindow: 50_000, maxTokens: 4000 }],
		tools: [],
		compactionPolicy: { reserveTokens: 1_000, keepRecentTokens: 500 },
		builtinCompactionFactories: [
			(api) => {
				api.bus.on("session_before_compact", async (event) => {
					attempts.push(event.reason);
					return { cancel: true, failure: "no gain" };
				});
			},
		],
	});
	if (virtual) {
		harness.session.modelRuntime.registerVirtualModel({
			provider: "router",
			id: "auto",
			name: "Auto",
			thinkingLevels: ["low"],
			contextWindow: 1000,
			route: () => ({ model: harness!.session.modelRuntime.getModel("faux", "large")!, thinkingLevel: "low" }),
		});
	}
	if (virtual) await harness.session.setModel(harness.session.modelRuntime.getModel("router", "auto")!);
	for (let i = 0; i < 5; i++) {
		harness.sessionManager.appendMessage({ role: "user", content: filler(9_800, `turn ${i}`), timestamp: 0 });
		harness.sessionManager.appendMessage(fauxAssistantMessage(`answer ${i}`));
	}
	harness.session.refreshContext();
	return { harness, attempts };
}

/** The request is prepared again with what the first preparation returned, as a retry of the same request is. */
async function prepareTwice(session: Harness) {
	const { agent } = session.session;
	const request = {
		context: { messages: [], tools: [] },
		model: agent.state.model,
		thinkingLevel: agent.state.thinkingLevel,
	} as never as Parameters<NonNullable<typeof agent.prepareRequest>>[0];
	const first = await agent.prepareRequest!(request, new AbortController().signal);
	await agent.prepareRequest!({ ...request, context: first?.context ?? request.context }, new AbortController().signal);
}

it.each([false, true])(
	"makes one compaction attempt for a request that is prepared twice (virtual model: %s)",
	async (virtual) => {
		const { harness: session, attempts } = await routedSession(virtual);
		await prepareTwice(session);
		expect(attempts).toEqual(["threshold"]);
	},
);

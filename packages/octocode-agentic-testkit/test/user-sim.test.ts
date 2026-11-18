import { describe, expect, it } from "vitest";
import type { AgentSession } from "../src/adapter.ts";
import { referenceAdapter } from "../src/adapters/reference/index.ts";
import type { InprocResult } from "../src/agents/inproc.ts";
import { script, type Gateway, type Step } from "../src/gateway.ts";
import type { Tier } from "../src/tiers.ts";
import { textOf } from "../src/trace.ts";
import { converse, DEFAULT_STOP_TOKEN, modelUser, scriptedUser } from "../src/user-sim.ts";
import { gateway } from "./helpers.ts";

async function agent(steps: Step[]): Promise<{ gw: Gateway; session: AgentSession<InprocResult> }> {
	const gw = await gateway({ responder: script(steps) });
	const session = await referenceAdapter({ trace: gw.trace, conversation: true }).start({ gatewayUrl: gw.url });
	return { gw, session };
}

const userTexts = (gw: Gateway, i: number): string[] =>
	gw.trace.requests[i].messages.filter((m) => m.role === "user").map((m) => textOf(m.content));

describe("converse with a scripted user", () => {
	it("drives a multi-turn conversation and stops when the script ends", async () => {
		const { gw, session } = await agent([{ text: "Which city?" }, { text: "Booked Paris." }]);
		const user = scriptedUser(["Book me a flight", (a) => (a?.includes("city") ? "Paris" : "no question asked")]);
		const c = await converse(session, user, { maxTurns: 5 });
		expect(c.stopped).toBe("user");
		expect(c.turns.map(({ user, answer }) => ({ user, answer }))).toEqual([
			{ user: "Book me a flight", answer: "Which city?" },
			{ user: "Paris", answer: "Booked Paris." },
		]);
		// The reference adapter kept the conversation: the second request carries both user turns.
		expect(userTexts(gw, 1)).toEqual(["Book me a flight", "Paris"]);
		await session.close();
	});

	it("a function turn that returns undefined ends the conversation", async () => {
		const { gw, session } = await agent([{ text: "Done." }]);
		const c = await converse(session, scriptedUser(["hi", () => undefined, "never sent"]), { maxTurns: 5 });
		expect(c).toMatchObject({ stopped: "user", turns: [{ user: "hi", answer: "Done." }] });
		expect(gw.trace.requests).toHaveLength(1);
	});

	it("stops at maxTurns without asking the user again", async () => {
		const { gw, session } = await agent([{ text: "ok" }]);
		let asked = 0;
		const c = await converse(
			session,
			{
				next: ({ turn }) => {
					asked++;
					return `message ${turn}`;
				},
			},
			{ maxTurns: 2 },
		);
		expect(c.stopped).toBe("max-turns");
		expect(c.turns.map((t) => t.user)).toEqual(["message 0", "message 1"]);
		expect(asked).toBe(2);
		expect(gw.trace.requests).toHaveLength(2);
	});

	it("sends firstMessage first, then asks the user from its first turn", async () => {
		const { session } = await agent([{ text: "Hello." }]);
		const c = await converse(session, scriptedUser(["second"]), { maxTurns: 5, firstMessage: "first" });
		expect(c.turns.map((t) => t.user)).toEqual(["first", "second"]);
		expect(c.stopped).toBe("user");
	});

	it("reads answers from the trace when the result carries none", async () => {
		const { gw, session } = await agent([{ text: "one" }, { text: "two" }]);
		const bare: AgentSession<undefined> = {
			run: async (input) => void (await session.run(input)),
			close: () => session.close(),
		};
		const c = await converse(bare, scriptedUser(["a", "b"]), { maxTurns: 5, trace: gw.trace });
		expect(c.turns.map((t) => t.answer)).toEqual(["one", "two"]);
	});

	it("fails loudly when no answer can be read, or maxTurns is not positive (must fail)", async () => {
		const { session } = await agent([{ text: "x" }]);
		const bare: AgentSession<number> = { run: async () => 1, close: async () => {} };
		await expect(converse(bare, scriptedUser(["a"]), { maxTurns: 2 })).rejects.toThrow(
			"converse: the run result has no `answer`; pass `answerOf` or `trace`",
		);
		await expect(converse(session, scriptedUser(["a"]), { maxTurns: 0 })).rejects.toThrow(RangeError);
	});
});

describe("modelUser", () => {
	it("plays the user through a second gateway and stops on the stop token", async () => {
		const { gw, session } = await agent([{ text: "Which date?" }]);
		const userGw = await gateway({
			responder: script([{ text: "I need a flight to Paris." }, { text: `Great, thanks. ${DEFAULT_STOP_TOKEN}` }]),
		});
		const user = modelUser({
			model: { baseUrl: `${userGw.url}/v1`, api: "openai", model: "user-sim" },
			goal: "book a flight to Paris on May 3",
			persona: "a terse traveller",
		});
		const c = await converse(session, user, { maxTurns: 5 });
		expect(c.stopped).toBe("stop-token");
		expect(c.turns.map(({ user: u, answer }) => ({ user: u, answer }))).toEqual([
			{ user: "I need a flight to Paris.", answer: "Which date?" },
		]);
		// The agent never saw the stop message.
		expect(gw.trace.requests).toHaveLength(1);
		const [first, second] = userGw.trace.requests;
		expect(first.model).toBe("user-sim");
		const system = textOf(first.messages[0].content);
		expect(system).toContain("book a flight to Paris on May 3");
		expect(system).toContain("a terse traveller");
		expect(system).toContain(DEFAULT_STOP_TOKEN);
		// Roles are swapped: the simulated user's own message is `assistant`, the agent's answer is `user`.
		expect(second.messages.slice(2).map((m) => [m.role, textOf(m.content)])).toEqual([
			["assistant", "I need a flight to Paris."],
			["user", "Which date?"],
		]);
	});

	it("takes a Tier and sends its body fields", async () => {
		const { session } = await agent([{ text: "ok" }]);
		const userGw = await gateway({ responder: script([{ text: "hello" }, { text: "STOP" }]) });
		const tier: Tier = {
			name: "local",
			baseUrl: `${userGw.url}/v1`,
			model: "tiny",
			api: "openai",
			body: { reasoning_effort: "none" },
			remote: false,
			timeoutMs: 5000,
		};
		const c = await converse(session, modelUser({ model: tier, goal: "say hello", stopToken: "STOP" }), {
			maxTurns: 3,
		});
		expect(c).toMatchObject({ stopped: "stop-token", turns: [{ user: "hello" }] });
		expect(userGw.trace.requests[0].raw).toMatchObject({ model: "tiny", reasoning_effort: "none" });
	});

	it("throws on an empty user message, an upstream error and a missing model id (must fail)", async () => {
		const { session } = await agent([{ text: "ok" }]);
		const empty = await gateway({ responder: script([{ text: "   " }]) });
		const forward = { baseUrl: `${empty.url}/v1`, api: "openai" as const, model: "m" };
		await expect(converse(session, modelUser({ model: forward, goal: "g" }), { maxTurns: 2 })).rejects.toThrow(
			"modelUser: the user model returned an empty message after 0 turns",
		);
		const down = await gateway({ responder: script([{ error: { status: 503, message: "overloaded" } }]) });
		await expect(
			converse(session, modelUser({ model: { ...forward, baseUrl: `${down.url}/v1` }, goal: "g" }), { maxTurns: 2 }),
		).rejects.toThrow(/upstream 503/);
		expect(() => modelUser({ model: { baseUrl: empty.url }, goal: "g" })).toThrow(/set model.model/);
	});
});

import { type AgentContext, methods } from "@agentclientprotocol/sdk";
import type { Question } from "@octocodeai/octocode-contracts";
import { describe, expect, it } from "vitest";
import { askClient } from "../../src/server/ask.ts";

const approval: Question = {
	id: "a",
	type: "approval",
	question: "Run it?",
	approval: { targets: ["ls"] },
	options: [
		{ id: "o", label: "Once", role: "allow_once" },
		{ id: "s", label: "Session", role: "allow_session" },
		{ id: "k", label: "Kind", role: "allow_kind" },
		{ id: "d", label: "Deny", role: "deny" },
		{ id: "ds", label: "Deny for the session", role: "deny_session" },
		{ id: "n", label: "Deny with note", role: "deny_note" },
	],
};
const batch: Question[] = [
	{
		id: "c",
		type: "choice",
		question: "Which?",
		options: [
			{ id: "1", label: "A" },
			{ id: "2", label: "B" },
		],
	},
	{
		id: "m",
		type: "multi",
		question: "Which many?",
		options: [
			{ id: "1", label: "A" },
			{ id: "2", label: "B" },
		],
	},
	{ id: "t", type: "text", question: "Name?" },
];

function fake(answer: (method: string, params: any) => unknown) {
	const calls: { method: string; params: any }[] = [];
	const client = {
		request: async (method: string, params: any) => {
			calls.push({ method, params });
			return answer(method, params);
		},
	} as unknown as AgentContext;
	const env = (elicitationForm: boolean) => ({
		client,
		sessionId: "s",
		signal: new AbortController().signal,
		elicitationForm,
		onCancelled: () => {},
	});
	return { calls, env };
}

describe("ACP ask", () => {
	it("maps approval roles to permission kinds, omitting deny_note", async () => {
		const { calls, env } = fake(() => ({ outcome: { outcome: "selected", optionId: "s" } }));
		const replies = await askClient(env(false), [approval]);
		expect(calls[0].params.options.map((o: any) => [o.optionId, o.kind])).toEqual([
			["o", "allow_once"],
			["s", "allow_always"],
			["k", "allow_always"],
			["d", "reject_once"],
			["ds", "reject_always"],
		]);
		expect(replies).toEqual([{ id: "a", picks: ["s"] }]);
	});

	it("asks the other types as one form and maps accept to replies", async () => {
		const { calls, env } = fake(() => ({ action: "accept", content: { c: "2", m: ["1", "2"], t: "Ada" } }));
		const replies = await askClient(env(true), batch);
		expect(calls).toHaveLength(1);
		expect(calls[0].method).toBe(methods.client.elicitation.create);
		expect(Object.keys(calls[0].params.requestedSchema.properties)).toEqual(["c", "m", "t"]);
		expect(replies).toEqual([
			{ id: "c", picks: ["2"] },
			{ id: "m", picks: ["1", "2"] },
			{ id: "t", picks: [], text: "Ada" },
		]);
	});

	it.each([
		["decline", "declined"],
		["cancel", "aborted"],
	] as const)("maps an elicitation %s to %s", async (action, cancelled) => {
		const { env } = fake(() => ({ action }));
		const replies = await askClient(env(true), batch);
		expect(replies.every((reply) => "cancelled" in reply && reply.cancelled === cancelled)).toBe(true);
	});

	it("answers unavailable, never declined, when the client has no form elicitation", async () => {
		const { calls, env } = fake(() => ({}));
		const replies = await askClient(env(false), batch);
		expect(calls).toHaveLength(0);
		expect(replies).toEqual(batch.map((q) => ({ id: q.id, cancelled: "unavailable" })));
	});
});

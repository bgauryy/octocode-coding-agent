import { describe, expect, it } from "vitest";
import { scripts, script, type Responder } from "../src/gateway.ts";
import type { ChatMessage } from "../src/trace.ts";
import { chat, gateway } from "./helpers.ts";

/*
 * Lineage: requests without an `x-testkit-agent` header, as every real CLI sends them. The gateway must tell the
 * main agent, its children, compactions and side calls apart from the conversations alone.
 */

const MAIN_SYSTEM = { role: "system", content: "You are the main agent." };
const CHILD_SYSTEM = { role: "system", content: "You are a research subagent." };
const tool = (name: string) => ({
	type: "function",
	function: { name, description: name, parameters: { type: "object" } },
});
const MAIN_TOOLS = [tool("spawn"), tool("search")];
const CHILD_TOOLS = [tool("search")];

type Msg = ChatMessage;
const user = (content: string): Msg => ({ role: "user", content });
const called = (id: string, name: string, args: unknown): Msg => ({
	role: "assistant",
	content: "",
	tool_calls: [{ id, type: "function", function: { name, arguments: JSON.stringify(args) } }],
});
const result = (id: string, content: string): Msg => ({ role: "tool", tool_call_id: id, content });
const said = (content: string): Msg => ({ role: "assistant", content });

async function send(url: string, system: unknown, messages: Msg[], tools: unknown[] = MAIN_TOOLS): Promise<void> {
	const r = await chat(url, { model: "m", messages: [system, ...messages], tools });
	expect(r.status).toBe(200);
}

const TASK = "Find who calls parseConfig in src/";
const SPAWN = { role: "researcher", task: TASK };

describe("lineage", () => {
	it("a synchronous spawn: the child is found by its task, scripted by role, and reports through the tool result", async () => {
		const gw = await gateway({
			responder: scripts({
				main: [{ toolCalls: [{ name: "spawn", args: SPAWN }] }, { text: "main done" }],
				researcher: [{ text: "loader.ts calls it" }],
			}),
		});
		await send(gw.url, MAIN_SYSTEM, [user("delegate the search")]);
		await send(gw.url, CHILD_SYSTEM, [user(`Task: ${TASK}`)], CHILD_TOOLS);
		await send(gw.url, MAIN_SYSTEM, [
			user("delegate the search"),
			called("call_1", "spawn", SPAWN),
			result("call_1", "loader.ts calls it"),
		]);
		expect(gw.trace.requests.map((r) => r.agent)).toEqual(["main", "researcher", "main"]);
		expect(gw.trace.of("answer").map((e) => [e.agent, e.data])).toEqual([
			["researcher", "loader.ts calls it"],
			["main", "main done"],
		]);
		expect(gw.trace).toHaveSpawned("researcher", { times: 1 });
		expect(gw.trace).toHaveHandedOff("main", "researcher");
		expect(gw.trace).toHaveNoOrphanAgents();
		expect(gw.trace.spans.get("researcher")).toMatchObject({ parent: "main", reported: true });
		// Inferred events never claim the harness reports events.
		expect(gw.trace.probes.has("events")).toBe(false);
		expect(gw.trace.probes.has("lineage")).toBe(true);
	});

	it("a background spawn: the call returns at once and the child's answer arrives later as a notification", async () => {
		const gw = await gateway({
			responder: scripts({
				main: [{ toolCalls: [{ name: "spawn", args: SPAWN }] }, { text: "waiting" }, { text: "main done" }],
				researcher: [{ text: "loader.ts calls it" }],
			}),
		});
		const head = [user("delegate the search"), called("call_1", "spawn", SPAWN), result("call_1", "agent launched")];
		await send(gw.url, MAIN_SYSTEM, [user("delegate the search")]);
		await send(gw.url, MAIN_SYSTEM, head);
		await send(gw.url, CHILD_SYSTEM, [user(`Task: ${TASK}`)], CHILD_TOOLS);
		await send(gw.url, MAIN_SYSTEM, [
			...head,
			said("waiting"),
			user("<notification>loader.ts calls it</notification>"),
		]);
		expect(gw.trace.requests.map((r) => r.agent)).toEqual(["main", "main", "researcher", "main"]);
		expect(gw.trace).toHaveHandedOff("main", "researcher");
		expect(gw.trace).toHaveNoOrphanAgents();
	});

	it("a child that never answers is an orphan", async () => {
		const gw = await gateway({
			responder: scripts({
				main: [{ toolCalls: [{ name: "spawn", args: SPAWN }] }, { text: "main done" }],
				researcher: [{ toolCalls: [{ name: "search", args: { q: "parseConfig" } }] }],
			}),
		});
		await send(gw.url, MAIN_SYSTEM, [user("delegate the search")]);
		await send(gw.url, CHILD_SYSTEM, [user(`Task: ${TASK}`)], CHILD_TOOLS);
		await send(gw.url, MAIN_SYSTEM, [
			user("delegate the search"),
			called("call_1", "spawn", SPAWN),
			result("call_1", "timed out"),
		]);
		expect(gw.trace).toHaveSpawned("researcher");
		expect(() => expect(gw.trace).toHaveNoOrphanAgents()).toThrow(/orphan agents.*researcher/);
		expect(() => expect(gw.trace).toHaveHandedOff("main", "researcher")).toThrow(/never reported back/);
	});

	it("a forked child extends its parent's history without answering the pending call", async () => {
		const gw = await gateway({
			responder: scripts({
				main: [{ toolCalls: [{ name: "fork", args: { why: "x" } }] }, { text: "done" }],
				fork: [{ text: "forked work done" }],
			}),
		});
		const head = [user("split the work"), called("call_1", "fork", { why: "x" })];
		await send(gw.url, MAIN_SYSTEM, [user("split the work")]);
		await send(gw.url, MAIN_SYSTEM, [...head, user("You are the fork. Continue.")]);
		await send(gw.url, MAIN_SYSTEM, [...head, result("call_1", "forked work done")]);
		expect(gw.trace.requests.map((r) => r.agent)).toEqual(["main", "fork", "main"]);
		expect(gw.trace).toHaveHandedOff("main", "fork");
	});

	it("a shrunk history with the summary the gateway wrote is a compaction; a side call is not an agent", async () => {
		const summary = "Summary: the user asked about the cache docs; search found docs/cache.md.";
		const responder: Responder = ({ request }) => (request.tools.length === 0 ? { text: summary } : { text: "noted" });
		const gw = await gateway({ responder });
		const long = [user("x".repeat(400)), said("first answer that is quite long"), user("y".repeat(400))];
		await send(gw.url, MAIN_SYSTEM, long);
		await send(gw.url, { role: "system", content: "Summarize the conversation." }, [user("summarize: ...")], []);
		await send(gw.url, MAIN_SYSTEM, [user(summary), user("next question")]);
		expect(gw.trace.requests.map((r) => r.agent)).toEqual(["main", "main:aux", "main"]);
		expect(gw.trace).toHaveCompacted({ times: 1 });
		expect(gw.trace).not.toHaveSpawned("main:aux");
	});

	it("a rewrite that keeps the history's size is no compaction; a new session is a fresh main span", async () => {
		const gw = await gateway({ responder: script([{ text: "a" }]) });
		await send(gw.url, MAIN_SYSTEM, [user("question one"), said("answer one")]);
		await send(gw.url, MAIN_SYSTEM, [user("question one"), said("answer one, edited"), user("more")]);
		await send(gw.url, MAIN_SYSTEM, [user("an unrelated new session")]);
		expect(gw.trace.requests.map((r) => r.span)).toEqual(["main", "main", "main#2"]);
		expect(gw.trace).not.toHaveCompacted();
		expect(gw.trace).not.toHaveSpawned("main");
	});

	it("a side call does not consume main's script steps", async () => {
		const gw = await gateway({ responder: script([{ text: "step 0" }, { text: "step 1" }]) });
		await send(gw.url, MAIN_SYSTEM, [user("hello")]);
		await send(gw.url, { role: "system", content: "Write a title." }, [user("Title for: hello")], []);
		await send(gw.url, MAIN_SYSTEM, [user("hello"), said("step 0"), user("again")]);
		expect(gw.trace.of("answer").map((e) => [e.agent, e.data])).toEqual([
			["main", "step 0"],
			["main:aux", "step 0"],
			["main", "step 1"],
		]);
	});

	it("with agents: header, every header-less request is main and nothing is inferred", async () => {
		const gw = await gateway({
			agents: "header",
			responder: script([{ toolCalls: [{ name: "spawn", args: SPAWN }] }, { text: "x" }]),
		});
		await send(gw.url, MAIN_SYSTEM, [user("delegate the search")]);
		await send(gw.url, CHILD_SYSTEM, [user(`Task: ${TASK}`)], CHILD_TOOLS);
		expect(gw.trace.requests.map((r) => r.agent)).toEqual(["main", "main"]);
		expect(gw.trace.probes.has("lineage")).toBe(false);
		expect(() => expect(gw.trace).not.toHaveSpawned("researcher")).toThrow(/cannot observe/);
	});

	it("a header still wins over the lineage", async () => {
		const gw = await gateway({ responder: script([{ text: "x" }]) });
		await chat(gw.url, { model: "m", messages: [MAIN_SYSTEM, user("hi")] }, { "x-testkit-agent": "planner" });
		expect(gw.trace.requests[0].agent).toBe("planner");
		expect(gw.trace.probes.has("lineage")).toBe(false);
	});
});

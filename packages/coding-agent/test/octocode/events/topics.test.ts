import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { fdSync } from "./walk.ts";
import { EVENT_KINDS } from "../../../src/octocode/wake/catalog.ts";
import { TOPICS, isTopic, topicGroup, type AgentEvent, type Topic } from "../../../src/octocode/events/topics.ts";
import { trustOf, type Source } from "../../../src/octocode/events/source-types.ts";

const SRC = join(dirname(fileURLToPath(import.meta.url)), "../../../src/octocode");

describe("the topic catalog", () => {
	it("lists exactly the kinds the wake catalog describes", () => {
		expect([...TOPICS].sort()).toEqual([...EVENT_KINDS].sort());
	});

	it("tells a topic from other text", () => {
		expect(isTopic("job.exit")).toBe(true);
		expect(isTopic("job.nope")).toBe(false);
		expect(isTopic(42)).toBe(false);
		expect(isTopic("toString")).toBe(false);
	});

	it("names the group before the first dot", () => {
		expect(topicGroup("agent.report")).toBe("agent");
		expect(topicGroup("peer.landed")).toBe("peer");
	});

	it("fails when code emits a kind the catalog lacks", () => {
		const known = new Set<string>(TOPICS);
		const emitted: { file: string; kind: string }[] = [];
		const pattern = /\bkind:\s*"((?:agent|job|item|peer|path|monitor|check|time|hook|wake|machine)\.[a-z.]+)"/g;
		for (const file of fdSync(SRC)) {
			const text = readFileSync(file, "utf8");
			for (const match of text.matchAll(pattern)) emitted.push({ file, kind: match[1] ?? "" });
		}
		expect(emitted.length).toBeGreaterThan(0);
		expect(emitted.filter((e) => !known.has(e.kind))).toEqual([]);
	});

	it("types an event envelope with its source", () => {
		const source: Source = { kind: "job", id: "bash-1", channel: "in-process", verified: "proven", trust: 2 };
		const event: AgentEvent<"job.exit"> = {
			seq: 1,
			topic: "job.exit",
			key: "job:bash-1:9",
			at: 9,
			source,
			payload: { job: "bash-1", exit: 0, durationMs: 5, startedAt: 9 },
			digest: "job bash-1 exit 0",
		};
		const topic: Topic = event.topic;
		expect(JSON.parse(JSON.stringify(event))).toEqual(event);
		expect(topic).toBe("job.exit");
	});
});

describe("source trust", () => {
	it.each([
		["terminal", "terminal", "proven", 4],
		["acp", "acp", "proven", 3],
		["web", "web", "proven", 3],
		["job", "in-process", "proven", 2],
		["timer", "in-process", "proven", 2],
		["system", "in-process", "proven", 2],
		["child", "db", "proven", 1],
		["peer", "db", "proven", 1],
		["external", "socket", "self-reported", 0],
		["hook", "in-process", "proven", 1],
		["mcp", "tool-result", "proven", 0],
		["webcontent", "tool-result", "proven", 0],
		["unknown", "db", "none", 0],
	] as const)("%s over %s (%s) has trust %i", (kind, channel, verified, trust) => {
		expect(trustOf(kind, channel, verified)).toBe(trust);
	});

	it("never trusts a terminal claim that is not proven", () => {
		expect(trustOf("terminal", "socket", "self-reported")).toBe(0);
		expect(trustOf("terminal", "db", "proven")).toBe(0);
		expect(trustOf("acp", "terminal", "proven")).toBe(0);
	});
});

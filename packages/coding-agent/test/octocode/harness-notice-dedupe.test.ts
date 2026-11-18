import { describe, expect, it } from "vitest";
import { renderPrompt } from "../../src/core/prompt-template.ts";
import { externalFacts, externalFooter, externalHeader } from "../../src/octocode/api/bridge/caller.ts";
import { encodeCondition, storedKind } from "../../src/octocode/timer/conditions/index.ts";
import { wakeText } from "../../src/octocode/timer/model.ts";
import { fenceUntrusted, fencedParts } from "../../src/octocode/shared/fence.ts";
import { messageText } from "../../src/octocode/team/routing.ts";
import type { Message } from "../../src/octocode/team/model.ts";

/**
 * What a harness message adds around the text it carries. The trust rule lives in the system prompt once; a message
 * names its sender, time and fence and nothing a second copy of the rule would say.
 */

const bytes = (text: string) => Buffer.byteLength(text);

describe("an external message", () => {
	const facts = externalFacts(
		"octocode-main-fd988644",
		{ team: "snappy-mantle", instanceId: "oc-fbbd2e", pid: 42795, cwd: "/work/repo" },
		"socket",
		false,
	);

	it("carries its sender, process facts, time and untrusted fence on one header line, with the body intact", () => {
		const header = externalHeader(facts, Date.parse("2026-11-18T11:46:38"));
		expect(header).not.toContain("\n");
		for (const fact of ["octocode-main-fd988644", "snappy-mantle", "oc-fbbd2e", "42795", "/work/repo", "11:46:38"])
			expect(header).toContain(fact);
		const content = fenceUntrusted(header, "build is red", { footer: externalFooter(facts) });
		expect(fencedParts(content)?.body).toBe("build is red");
		expect(content).toMatch(/\n<<<untrusted-[0-9a-f]{16} /);
	});

	it("stays a single short header, not the former 700-byte preamble", () => {
		const header = externalHeader(facts, 0);
		// The former header alone was about 700 bytes for these facts.
		expect(bytes(header)).toBeLessThan(300);
	});

	it("adds a reply line only when the sender asks for one or waits", () => {
		expect(externalFooter(facts)).toBe("");
		const asking = externalFacts("ci", {}, "socket", true, true, []);
		expect(externalFooter({ ...asking, replyTo: "oc-1" })).toContain("oc-1");
		expect(externalFooter(asking)).not.toBe("");
	});
});

describe("the trust rule for messages of other processes", () => {
	it("is in the system prompt of both the main agent and a child, once each", () => {
		for (const main of [true, false]) {
			const rule = renderPrompt("shared/trust.md", { main }).trim();
			const prompt = renderPrompt("policy/safety.md", { main, gitState: false, agentTool: true, lean: false });
			expect(prompt.split(rule)).toHaveLength(2);
		}
	});
});

describe("a peer message", () => {
	const message = (extra: Partial<Message> = {}): Message =>
		({
			id: 7,
			from: "researcher-1234",
			to: ["main-aaaaaa"],
			text: "done",
			at: 0,
			state: "delivered",
			replyRequired: false,
			...extra,
		}) as Message;

	it("keeps header, fence and a short footer; the ack rule is not repeated in it", () => {
		const text = messageText(message());
		const parts = fencedParts(text);
		expect(parts?.body).toBe("done");
		expect(bytes(parts?.footer ?? "")).toBeLessThan(60);
		expect(text.split("\n")[0]).toContain("researcher-1234");
	});
});

describe("a timer wake", () => {
	const row = (extra: Record<string, unknown> = {}) =>
		({
			id: 345,
			kind: "until",
			status: "done",
			stop_reason: "met",
			note: "Knip finished: read the log",
			condition_kind: storedKind({ kind: "command", command: "test -e knip.log" }),
			condition: encodeCondition({ kind: "command", command: "test -e knip.log" }),
			last_output: "",
			last_exit: 0,
			checks: 0,
			spent_usd: 0,
			max_runs: null,
			runs: 1,
			...extra,
		}) as never;

	it("states the model's note once and not the condition command the model already wrote", () => {
		const text = wakeText(row());
		expect(text.split("Knip finished: read the log")).toHaveLength(2);
		expect(text).not.toContain("test -e knip.log");
		expect(text).toContain("345");
		expect(text).toContain("met");
	});

	it("still reports what a check said when it has something to say", () => {
		const text = wakeText(row({ last_output: "3 files left", last_exit: 0 }));
		expect(text).toContain("3 files left");
		const failing = wakeText(row({ status: "expired", stop_reason: "deadline", last_output: "", last_exit: 1 }));
		expect(failing).toMatch(/\b1\b/);
		expect(failing).toContain("Knip finished");
	});
});

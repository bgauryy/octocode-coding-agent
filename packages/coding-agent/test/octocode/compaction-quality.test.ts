import fs from "node:fs";
import path from "node:path";
import { fauxAssistantMessage } from "@octocodeai/octocode-ai";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { isRecord } from "@octocodeai/octocode-contracts/guards";
import { splitSummary } from "../../src/core/compaction/summary-view.ts";
import { registerCompaction } from "../../src/octocode/compaction/register.ts";
import { RESTORED_FILES_TYPE } from "../../src/octocode/files/reads.ts";
import { FileGuard } from "../../src/octocode/files/tool/guard.ts";
import { capOutputToFile } from "../../src/octocode/shared/spill.ts";
import { createHarness, getMessageText, type Harness } from "../suite/harness.ts";
import { tmp } from "./helpers.ts";

/**
 * Summary quality across repeated compactions, on the scripted model and the real compaction path: what a model that
 * writes a lossy checkpoint must still hand the next turn. Each assertion names a fact (a message, a rule, a path),
 * so dropping any one of them in code fails here.
 */

let harness: Harness | undefined;
let savedHome: string | undefined;
beforeEach(() => {
	savedHome = process.env.OCTOCODE_HOME;
	process.env.OCTOCODE_HOME = tmp();
});
afterEach(() => {
	harness?.cleanup();
	harness = undefined;
	if (savedHome === undefined) delete process.env.OCTOCODE_HOME;
	else process.env.OCTOCODE_HOME = savedHome;
});

const filler = (n: number) => "padding words ".repeat(n);
const saved = (mark: string) => capOutputToFile(`${mark}\n${"line of output\n".repeat(6_000)}`, { label: "quality" });
const fileOf = (note: string) => /Full output: (\S+);/.exec(note)![1];
const count = (text: string, part: string) => text.split(part).length - 1;

const CONSTRAINT = "Never switch branches in the shared checkout";
const DECISION = "Keep the tokenizer";
const PARSER_LINE = 'export const MARK_7731 = "restored line";';

function summary(h: Harness): string {
	const entry = h.sessionManager.getBranch().findLast((e) => e.type === "compaction");
	if (entry?.type !== "compaction") throw new Error("no compaction");
	return entry.summary;
}

async function run() {
	const dir = tmp();
	const file = path.join(dir, "parser.ts");
	fs.writeFileSync(file, `${PARSER_LINE}\nexport const parser = 1;\n`);
	harness = await createHarness({
		settings: { retry: { enabled: false } },
		models: [{ id: "m", contextWindow: 60_000, maxTokens: 1_000 }],
		compactionPolicy: { keepRecentTokens: 1_000 },
		builtinCompactionFactories: [(api) => void registerCompaction(api, new FileGuard())],
	});
	const h = harness;
	const turn = (user: string, answer: string) => {
		h.sessionManager.appendMessage({ role: "user", content: [{ type: "text", text: user }], timestamp: Date.now() });
		h.sessionManager.appendMessage(fauxAssistantMessage(answer));
	};
	const users = [
		"Goal: ship the parser. " + CONSTRAINT + ". " + filler(120),
		"Decided: " + DECISION + ". " + filler(120),
	];
	turn(users[0], "ok");
	h.sessionManager.appendMessage({
		role: "assistant",
		content: [{ type: "toolCall", id: "r1", name: "file", arguments: { queries: [] } }],
		api: "faux",
		provider: "faux",
		model: "m",
		usage: {
			input: 1,
			output: 1,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 2,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "toolUse",
		timestamp: Date.now(),
	} as never);
	h.sessionManager.appendMessage({
		role: "toolResult",
		toolCallId: "r1",
		toolName: "file",
		details: { outcomes: [{ ok: true, path: file }] },
		content: [{ type: "text", text: `${PARSER_LINE}\nexport const parser = 1;\n` }],
		isError: false,
		timestamp: Date.now(),
	});
	const note = saved("BIGRESULT-ONE");
	h.sessionManager.appendMessage({
		role: "toolResult",
		toolCallId: "b1",
		toolName: "bash",
		content: [{ type: "text", text: note }],
		isError: false,
		timestamp: Date.now(),
	});
	turn(users[1], "noted");
	h.session.refreshContext();
	h.setResponses([
		fauxAssistantMessage(
			`## Goal\nShip the parser\n\n## Constraints & Preferences\n- ${CONSTRAINT}\n\n## Key Decisions\n- **${DECISION}**: tests pin it\n\n## TL;DR\nFirst.`,
		),
	]);
	await h.session.compact();
	// A second era; the lossy model writes neither the rule nor the decision, so only the ledger can bring them back.
	users.push("Third request: add the lexer. " + filler(120), "Fourth request: wire the CLI. " + filler(120));
	turn(users[2], "done");
	turn(users[3], "done");
	h.session.refreshContext();
	h.setResponses([fauxAssistantMessage(`## TL;DR\nSecond.`)]);
	await h.session.compact();
	return { h, second: summary(h), users, file, saved: fileOf(note) };
}

describe("facts that survive two compactions", () => {
	it("keeps every user message, the ledger once, the goal, the saved path and the restored file", async () => {
		const r = await run();
		const parts = splitSummary(r.second);
		const kept = r.h.session.messages.flatMap((m) => (m.role === "user" ? [getMessageText(m)] : []));
		expect(parts.omitted).toBe(0);
		expect([...parts.messages, ...kept]).toEqual(r.users);
		// The model's second checkpoint wrote neither: code puts each back, once.
		expect(count(parts.body, CONSTRAINT)).toBe(1);
		expect(count(parts.body, DECISION)).toBe(1);
		expect(parts.body).toMatch(/\[C1\] Never switch/);
		expect(parts.body).toMatch(/\[D1\] \*\*Keep the tokenizer/);
		// The saved path appears once, and no bullet line of the body repeats.
		expect(count(r.second, r.saved)).toBe(1);
		// The open goal: the second checkpoint wrote none, so code carries the first one's, once.
		expect(count(parts.body, "## Goal\nShip the parser")).toBe(1);
		expect(count(r.second, "Ship the parser")).toBe(1);
		const bullets = parts.body.split("\n").filter((line) => line.startsWith("- "));
		expect(new Set(bullets).size).toBe(bullets.length);
		// Each compaction reads the file back for the model that follows it; the first copy is summarized away with its
		// era, so what the model holds now is one copy, not two.
		const restored = (messages: readonly unknown[]) =>
			messages.flatMap((m) =>
				isRecord(m) && m.role === "custom" && m.customType === RESTORED_FILES_TYPE ? [String(m.content)] : [],
			);
		const live = restored(r.h.sessionManager.buildSessionProjection().messages);
		expect(live).toHaveLength(1);
		expect(
			r.h.sessionManager.getBranch().filter((e) => e.type === "custom_message" && e.customType === RESTORED_FILES_TYPE),
		).toHaveLength(2);
		expect(live.join("\n")).toContain(PARSER_LINE);
	});
});

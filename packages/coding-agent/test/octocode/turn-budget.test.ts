import fs from "node:fs";
import os from "node:os";
import type { ToolResultMessage } from "@octocodeai/octocode-ai";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { setCurrentSession } from "../../src/octocode/shared/home.ts";
import { SETTINGS_DEFAULTS } from "../../src/core/settings-defaults.ts";
import {
	REQUEST_MAX_CHARS,
	RESULT_DEFAULT_BYTES,
	TEXT_MAX_CHARS,
	TURN_MAX_CHARS,
} from "../../src/octocode/shared/output-budget.ts";
import { capResultText } from "../../src/octocode/shared/spill.ts";
import { budgetToolResult, registerTurnBudget, TurnBudget } from "../../src/octocode/shared/turn-budget.ts";
import { fakeCtx, fakeHost } from "./fake-host.ts";
import { tmp } from "./helpers.ts";

let saved: string | undefined;

beforeEach(() => {
	saved = process.env.OCTOCODE_HOME;
	process.env.OCTOCODE_HOME = tmp();
});

afterEach(() => {
	setCurrentSession(undefined);
	if (saved === undefined) delete process.env.OCTOCODE_HOME;
	else process.env.OCTOCODE_HOME = saved;
});

/** A page like the server's: rows, then the `next` continuation at the very end. */
const page = (chars: number, mark: string) =>
	`${"- row: some repository text\n".repeat(Math.ceil(chars / 28))}next:\n  continueChars: { charOffset: ${mark} }\n`;

const result = (toolName: string, text: string, id = toolName): ToolResultMessage => ({
	role: "toolResult",
	toolCallId: id,
	toolName,
	content: [{ type: "text", text }],
	isError: false,
	timestamp: 0,
});

const textOf = (message: ToolResultMessage) => (message.content[0] as { text: string }).text;
const archiveOf = (text: string) => /saved as JSON lines at (.+)\.\]/.exec(text)![1];
const records = (file: string) =>
	fs
		.readFileSync(file, "utf8")
		.trim()
		.split("\n")
		.map((line) => JSON.parse(line) as { tool: string; text: string });

describe("output budget policy", () => {
	it("keeps one default for bash and the other tools, and a requested page whole", () => {
		expect(SETTINGS_DEFAULTS.bashOutputMaxBytes).toBe(RESULT_DEFAULT_BYTES);
		expect(TEXT_MAX_CHARS).toBeGreaterThan(REQUEST_MAX_CHARS);
		expect(TURN_MAX_CHARS).toBeGreaterThanOrEqual(2 * REQUEST_MAX_CHARS);
	});

	it("capResultText keeps a text part whole up to the limit and saves a longer one", () => {
		const fits = "é".repeat(TEXT_MAX_CHARS);
		expect(capResultText(fits, "x")).toBe(fits);
		const long = page(TEXT_MAX_CHARS * 2, "1");
		const shown = capResultText(long, "x");
		expect(shown.length).toBeLessThan(long.length);
		expect(shown).toContain("Full output:");
		expect(capResultText(long, "x", long.length)).toBe(long);
	});
});

describe("TurnBudget", () => {
	it("bounds all text across results and preserves the overflow in one recoverable archive", () => {
		const budget = new TurnBudget();
		const pages = Array.from({ length: 30 }, (_, i) => page(30_000, String(i)));
		const shown = pages.map((text) => budget.text(text, "localFetch"));
		expect(shown.slice(0, 3)).toEqual(pages.slice(0, 3));
		const archive = archiveOf(shown[3]);
		expect(records(archive).map((record) => record.text)).toEqual(pages.slice(3));
		expect(shown.slice(4).every((text) => text.startsWith("[Omitted: this turn's text budget"))).toBe(true);
		// Each result after the first omitted one costs a short pointer, which the budget counts.
		expect(shown.reduce((sum, text) => sum + text.length, 0)).toBeLessThanOrEqual(TURN_MAX_CHARS + 30 * 100);
		budget.reset();
		expect(budget.text("new turn", "t")).toBe("new turn");
	});

	it("starts a new turn with the whole budget, and counts only what the model gets", () => {
		const budget = new TurnBudget();
		for (let i = 0; i < 3; i++) budget.text(page(30_000, String(i)), "localFetch");
		expect(budget.limit()).toBeLessThan(10_000);
		budget.reset();
		expect(budget.limit()).toBe(TEXT_MAX_CHARS);
		const small = new TurnBudget();
		for (let i = 0; i < 30; i++) small.text("x".repeat(1_000), "t");
		expect(small.limit()).toBe(TEXT_MAX_CHARS);
	});

	it("saves a part over the per-part cap whole and keeps its head and tail", () => {
		const huge = page(120_000, "777");
		const shown = new TurnBudget().text(huge, "bash");
		expect(shown.length).toBeLessThanOrEqual(TEXT_MAX_CHARS);
		expect(shown).toContain("continueChars: { charOffset: 777 }");
		const file = /Full output: (\S+?); search/.exec(shown)![1].replace(/^~/, os.homedir());
		expect(fs.readFileSync(file, "utf8")).toBe(huge);
	});
});

describe("budgetToolResult", () => {
	it("returns nothing for a result within the budget, and keeps images and other fields", () => {
		const budget = new TurnBudget();
		budget.charge(TURN_MAX_CHARS - 20_000);
		const message = result("bash", "ok");
		expect(budgetToolResult(budget, message)).toBeUndefined();
		const mixed: ToolResultMessage = {
			...message,
			content: [
				{ type: "image", data: "x".repeat(10), mimeType: "image/png" },
				{ type: "text", text: "x".repeat(30_000) },
			],
			details: { fullOutputPath: "/saved" },
		};
		const bounded = budgetToolResult(budget, mixed)!;
		expect(bounded.content[0]).toBe(mixed.content[0]);
		expect(bounded.details).toBe(mixed.details);
		expect(bounded.toolCallId).toBe("bash");
		expect((bounded.content[1] as { text: string }).text).toContain("Turn text budget reached");
	});
});

describe("tool results of one assistant message", () => {
	const setup = () => {
		const fake = fakeHost();
		registerTurnBudget(fake.api);
		const ctx = fakeCtx({ cwd: tmp() });
		const turn = () => fake.fire("turn_start", { type: "turn_start" }, ctx);
		/** What the agent loop does for each result, in tool-call order. */
		const end = async (message: unknown) => {
			const replaced = (await fake.fire("message_end", { type: "message_end", message }, ctx)) as
				| { message: ToolResultMessage }
				| undefined;
			return replaced?.message ?? (message as ToolResultMessage);
		};
		return { turn, end, fake };
	};

	it("keeps five 30 KB results within one budget: the first three whole, the rest saved to a file", async () => {
		const { turn, end } = setup();
		await turn();
		const outputs = Array.from({ length: 5 }, (_, i) => `${String(i).repeat(29_999)}\n`);
		const shown: ToolResultMessage[] = [];
		for (const [i, text] of outputs.entries()) shown.push(await end(result("bash", text, `call-${i}`)));
		expect(shown.slice(0, 3).map(textOf)).toEqual(outputs.slice(0, 3));
		expect(textOf(shown[3])).toContain("Turn text budget reached");
		expect(textOf(shown[4])).toContain("[Omitted: this turn's text budget");
		expect(shown.map((message) => message.toolCallId)).toEqual(outputs.map((_, i) => `call-${i}`));
		expect(records(archiveOf(textOf(shown[3])))).toEqual([
			{ tool: "bash", text: outputs[3] },
			{ tool: "bash", text: outputs[4] },
		]);
		expect(shown.map(textOf).join("").length).toBeLessThan(TURN_MAX_CHARS + 1_000);
	});

	it("spends the budget in tool-call order across native and MCP tools, so the same calls always lose the same text", async () => {
		const runs: string[][] = [];
		for (let run = 0; run < 2; run++) {
			const { turn, end } = setup();
			await turn();
			const shown: string[] = [];
			for (const tool of ["bash", "mcp__octocode__localSearch", "file", "web_fetch", "bash"]) {
				shown.push(textOf(await end(result(tool, "z".repeat(25_000)))).slice(0, 12));
			}
			runs.push(shown);
		}
		expect(runs[0]).toEqual(runs[1]);
		expect(runs[0].map((text) => text.startsWith("zzz"))).toEqual([true, true, true, true, false]);
	});

	it("starts every assistant message with the whole budget", async () => {
		const { turn, end } = setup();
		const text = "y".repeat(30_000);
		for (let message = 0; message < 3; message++) {
			await turn();
			for (let i = 0; i < 3; i++) expect(textOf(await end(result("bash", text)))).toBe(text);
		}
	});

	it("leaves non-tool messages alone", async () => {
		const { turn, fake } = setup();
		await turn();
		const message = { role: "user", content: "x".repeat(TURN_MAX_CHARS * 2), timestamp: 0 };
		expect(await fake.fire("message_end", { type: "message_end", message }, fakeCtx({ cwd: tmp() }))).toBeUndefined();
	});
});

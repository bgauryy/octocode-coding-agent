import { readFileSync } from "node:fs";
import { fauxAssistantMessage, fauxToolCall } from "@octocodeai/octocode-ai";
import { visibleWidth } from "@octocodeai/octocode-tui/text";
import { afterEach, describe, expect, it } from "vitest";
import { VirtualTerminal } from "../../../tui/test/virtual-terminal.ts";
import { startInteractive } from "./e2e-commands-harness.ts";
import { hang, KEY, startUi, type UiHarness } from "./e2e-ui-flows/ui.ts";

/** The `✻ Worked …` line: one per settled run, however many segments (follow-ups, retries) the run took. */
let t: UiHarness | undefined;
afterEach(async () => {
	await t?.stop();
	t = undefined;
});

const ALT_ENTER = "\x1b[13;3u"; // kitty encoding
const LINE = /✻ Worked [^\n]*/g;
const lines = async () => ((await t!.text()).match(LINE) ?? []).map((line) => line.trimEnd());
const idle = () => t!.until(() => !t!.host.session.isStreaming, "idle");
const toolTurn = (command: string) =>
	fauxAssistantMessage([fauxToolCall("bash", { command, reason: "a quick command" })], { stopReason: "toolUse" });

describe("turn summary line", () => {
	it("writes one line after a multi-turn tool run", async () => {
		t = await startUi();
		t.script(toolTurn("echo one"), toolTurn("echo two"), "all done");
		await t.type("do two things");
		t.press(KEY.enter);
		await t.until(async () => (await lines()).length > 0, "the summary line");
		await idle();
		expect(await lines()).toEqual([expect.stringMatching(/^✻ Worked \d+s · 2 tools/)]);
		expect(t.requests).toHaveLength(3);
	});

	it("clones without recording a finished job when shutdown detaches a scheduled timer", async () => {
		const run = await startInteractive();
		try {
			expect((await run.submit("/loop 10m check again")).text).toContain("Scheduled task");
			run.script(toolTurn("echo one"), fauxAssistantMessage("done"));
			await run.submit("run a tool");
			await run.host.session.waitForIdle();
			const file = run.host.sessionManager.getSessionFile()!;
			const before = readFileSync(file, "utf8");
			expect(before).not.toContain('"customType":"octocode-turn"');
			expect((await run.submit("/clone")).text).toContain("Cloned to new session");
			expect(readFileSync(file, "utf8")).toEqual(before);
		} finally {
			await run.stop();
		}
	});

	it("waits for a queued follow-up, then writes one line", async () => {
		t = await startUi();
		const first = hang("first reply");
		const second = hang("follow reply");
		t.script(first, toolTurn("echo follow"), second);
		await t.type("busy");
		t.press(KEY.enter);
		await t.until(() => t!.host.session.isStreaming && t!.requests.length === 1, "turn to reach the model");
		await t.type("follow me");
		t.press(ALT_ENTER);
		first.release();
		await t.until(() => t!.requests.length === 3, "the follow-up to reach the model");
		expect(await lines()).toEqual([]);
		second.release();
		await t.until(async () => (await lines()).length > 0, "the summary line");
		await idle();
		expect(await lines()).toEqual([expect.stringMatching(/^✻ Worked \d+s · 1 tool(?: · cache \d+%)?$/)]);
	});

	it("keeps a retried run whole, and counts its scripted spend", async () => {
		t = await startUi();
		t.host.session.settingsManager.applyOverrides({ retry: { enabled: true, maxRetries: 2, baseDelayMs: 50 } });
		const session = t.host.session;
		t.script(
			toolTurn("echo one"),
			fauxAssistantMessage("", { stopReason: "error", errorMessage: "529 overloaded" }),
			() => {
				// A request made outside a reply (as a compaction summary is), recorded while the run is on.
				session.sessionManager.appendUsage(
					"side_question",
					"faux",
					"faux-1",
					{
						input: 10,
						output: 5,
						cacheRead: 0,
						cacheWrite: 0,
						totalTokens: 15,
						cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0.5 },
					},
					"b44",
				);
				return fauxAssistantMessage("recovered");
			},
		);
		await t.type("go");
		t.press(KEY.enter);
		await t.until(async () => (await lines()).length > 0, "the summary line");
		await idle();
		expect(t.requests).toHaveLength(3);
		expect(await lines()).toEqual([
			expect.stringMatching(/^✻ Worked \d+s · 1 tool · ≈\$0\.50(?: \+ n\/a)? · cache \d+%/),
		]);
	});

	it("Esc during a retry countdown restores the error without sending another request", async () => {
		t = await startUi();
		t.host.session.settingsManager.applyOverrides({ retry: { enabled: true, maxRetries: 2, baseDelayMs: 60_000 } });
		t.script(fauxAssistantMessage("", { stopReason: "error", errorMessage: "529 overloaded" }), "unexpected retry");
		await t.type("go");
		t.press(KEY.enter);
		await t.until(async () => (await t!.text()).includes("Retried after error"), "the retry countdown");
		t.press(KEY.esc);
		await t.until(async () => (await t!.text()).includes("Retry cancelled"), "the cancelled retry");
		const screen = await t.text();
		expect(screen).toContain("Error: 529 overloaded");
		expect(screen).not.toContain("Retried after error");
		expect(t.requests).toHaveLength(1);
	});

	describe("persistent footer", () => {
		/** The footer's two rows: model, permission and context fill on the first, total tokens on the second. */
		const footer = async () => {
			const rows = (await t!.grid()).map((row) => row.trimEnd());
			const top = rows.findIndex((row) => /\bctx \S/.test(row));
			return top < 0 ? "" : rows.slice(top, top + 2).join("\n");
		};
		/** A wide terminal: the temp working directory is long, and the narrow footer drops the token total first. */
		const startWide = async () => {
			const terminal = new VirtualTerminal(200, 40);
			const wide = (await startInteractive({ terminal })) as UiHarness;
			// Keep the same space for footer data regardless of the host's temporary-path length.
			terminal.resize(200 + visibleWidth(wide.host.session.sessionManager.getCwd()), 40);
			wide.text = async () => (await wide.grid()).join("\n").trimEnd();
			wide.type = async (text) => {
				for (const ch of text) wide.press(ch);
				await new Promise((resolve) => setTimeout(resolve, 150));
			};
			await wide.until(async () => (await wide.text()).length > 0, "first paint");
			return wide;
		};
		const turn = async (prompt: string) => {
			await t!.type(prompt);
			const before = t!.requests.length;
			t!.press(KEY.enter);
			await t!.until(() => t!.requests.length > before, "the request to reach the model");
			await idle();
		};

		it("shows context %, tokens and (in the turn line) cache % after turns with usage", async () => {
			t = await startWide();
			// A run with a tool call writes a summary line; a plain reply does not.
			t.script(toolTurn("echo one"), "first answer", toolTurn("echo two"), "second answer");
			await t.until(async () => /ctx [▰▱]+ \d+% of \d+k/.test(await footer()), "a context gauge");
			expect(await footer()).not.toMatch(/\d+ tok(?!\/s)/);
			await turn("hello there");
			await turn("and again");
			const replies = t.host.session.sessionManager
				.getBranch()
				.flatMap((entry) =>
					entry.type === "message" && entry.message.role === "assistant" ? [entry.message.usage] : [],
				);
			expect(replies).toHaveLength(4);
			expect(replies[3].cacheRead, "the second request re-reads the first prompt").toBeGreaterThan(0);
			await t.until(async () => /\dk? tok(?!\/s)/.test(await footer()), "the footer to count tokens");
			const rows = await footer();
			// Context fill is known (a percentage over the auto-compact window), never `?`.
			expect(rows).toMatch(/ctx [▰▱]+ \d+% of \d+k/);
			expect(rows).not.toMatch(/ctx \? of/);
			// Tokens: new prompt plus output; cache reads appear once, as the cached share.
			expect(rows).toMatch(/[1-9]\d*(?:\.\d)?k? tok \(↑\d[\d.]*k? ↓\d[\d.]*k?\)/);
			expect(rows).toMatch(/[1-9]\d*% cached/);
			// Cache % is on each run's summary line, not in the footer.
			await t.until(async () => (await lines()).length === 2, "both summary lines");
			expect(await lines()).toEqual([expect.stringMatching(/cache \d+%/), expect.stringMatching(/cache [1-9]\d*%/)]);
		});

		it("shows ? for the context fill when usage is unknown after a compaction", async () => {
			t = await startWide();
			// The seeded history leaves the window no room for a cached-request summary, so the standalone one summarizes
			// it in two parts.
			t.script("an answer", "summary of the older turns", "summary of the earlier turns");
			await turn("hello");
			await t.until(async () => /ctx [▰▱]+ \d+% of/.test(await footer()), "a known context fill");
			// A real compaction: until the next reply, how full the context is cannot be known.
			// Compaction keeps the last 20k tokens of history: seed enough older history for it to have something to summarize.
			const manager = t.host.session.sessionManager;
			for (let i = 0; i < 3; i++) {
				manager.appendMessage({ role: "user", content: "x".repeat(100_000), timestamp: Date.now() });
				manager.appendMessage(fauxAssistantMessage("y".repeat(100_000)));
			}
			await t.host.session.compact();
			await t.until(async () => /ctx \? of \d+k/.test(await footer()), "the footer to show ? after compaction");
			expect(await footer()).not.toMatch(/ctx [▰▱]+ \d+%/);
			expect(await footer()).toMatch(/1 compaction/);
		});
	});
});

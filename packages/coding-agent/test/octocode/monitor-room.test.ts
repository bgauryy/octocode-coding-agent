import { describe, expect, it, vi } from "vitest";
import { registerMonitorRoom } from "../../src/octocode/monitor-room/command.ts";
import { roomRows, roomText } from "../../src/octocode/monitor-room/rows.ts";
import { ATTENTION_RULES } from "../../src/octocode/monitor/attention/rules.ts";
import { MonitorLedger } from "../../src/octocode/monitor/ledger.ts";
import { Subcommands } from "../../src/octocode/shared/commands.ts";
import { initTheme } from "../../src/theme/theme.ts";
import { fakeCtx } from "./fake-host.ts";

const NOW = 10_000_000;

/** A ledger with a swap alert 3 minutes ago, a tripped load without an alert, and a stuck job whose alert did not arrive. */
function ledger(): MonitorLedger {
	const l = new MonitorLedger(() => NOW);
	l.record({ rule: "swap", value: 92, threshold: 90, at: NOW - 180_000 }, true);
	l.trip("load", true);
	l.record({ rule: "job", value: 16, threshold: 15, subject: "job-7", at: NOW - 60_000 }, false);
	return l;
}

describe("monitor room rows", () => {
	it("has one row per ledger rule, in order, whatever the rules are", () => {
		const rows = roomRows(ledger().rules(), NOW);
		expect(rows.map((row) => row.rule)).toEqual(ATTENTION_RULES.map((rule) => rule.id));
	});

	it("shows state, reading against threshold, trips, alerts, relative last alert and subject", () => {
		const byRule = new Map(roomRows(ledger().rules(), NOW).map((row) => [row.rule, row]));
		expect(byRule.get("swap")).toEqual({
			rule: "swap",
			state: "tripped",
			reading: "92% vs 90%",
			trips: 1,
			alerts: 1,
			lastAlert: "3m ago",
			subject: "-",
		});
		// A machine threshold over its streak with no alert yet.
		expect(byRule.get("load")).toMatchObject({ state: "tripped", reading: "-", trips: 1, alerts: 0, lastAlert: "-" });
		// An undelivered alert counts as a trip and not as an alert.
		expect(byRule.get("job")).toMatchObject({
			reading: "16m vs 15m",
			trips: 1,
			alerts: 0,
			lastAlert: "-",
			subject: "job-7",
		});
		expect(byRule.get("context")).toMatchObject({ state: "ok", trips: 0, alerts: 0, reading: "-" });
	});

	it("prints an aligned table with a header and every rule", () => {
		const text = roomText(roomRows(ledger().rules(), NOW));
		const lines = text.split("\n");
		expect(lines[0]).toMatch(/^rule\s+state\s+reading\s+trips\s+alerts\s+last alert\s+subject$/);
		expect(lines).toHaveLength(ATTENTION_RULES.length + 1);
		expect(lines.find((line) => line.startsWith("swap"))).toMatch(/^swap\s+tripped\s+92% vs 90%\s+1\s+1\s+3m ago\s+-$/);
		expect(lines.find((line) => line.startsWith("job"))).toMatch(/^job\s+tripped\s+16m vs 15m\s+1\s+0\s+-\s+job-7$/);
	});
});

describe("/monitor", () => {
	function setup() {
		const commands = new Subcommands();
		registerMonitorRoom(commands, {} as never, { ledger: ledger(), now: () => NOW });
		return commands.get("monitor")!;
	}

	it("prints the table as text without a screen", async () => {
		const ctx = fakeCtx({ cwd: ".", hasUI: false });
		const written: string[] = [];
		const spy = vi.spyOn(process.stderr, "write").mockImplementation((chunk) => (written.push(String(chunk)), true));
		try {
			await setup().handler("", ctx);
		} finally {
			spy.mockRestore();
		}
		expect(written.join("")).toMatch(/swap\s+tripped\s+92% vs 90%\s+1\s+1\s+3m ago/);
		expect(ctx.ui.notes.map((note) => note.message).join("\n")).toContain("job-7");
	});

	it("prints text on a screen when asked, and refuses other arguments", async () => {
		const ctx = fakeCtx({ cwd: ".", hasUI: true });
		await setup().handler("text", ctx);
		expect(ctx.ui.notes.at(-1)?.message).toMatch(/^rule\s+state/);
		await setup().handler("bogus", ctx);
		expect(ctx.ui.notes.at(-1)).toEqual({ message: "Usage: /monitor [text]", type: "warning" });
	});

	it("opens a page of every rule on a screen, a rule's figures on Enter, and leaves on Escape", async () => {
		initTheme("dark", false);
		const screens: string[] = [];
		const ctx = fakeCtx({
			cwd: ".",
			hasUI: true,
			ui: {
				custom: async (factory: never) => {
					let answer: unknown;
					const component = (
						factory as (...args: unknown[]) => { render(width: number): string[]; handleInput(data: string): void }
					)({ terminal: { rows: 40 }, requestRender: () => undefined }, {}, {}, (value: unknown) => (answer = value));
					screens.push(component.render(160).join("\n"));
					// The list opens the highlighted rule with Enter; the rule page and the list's second visit end with Escape.
					component.handleInput(screens.length === 1 ? "\r" : "\u001b");
					return answer;
				},
			} as never,
		});
		await setup().handler("", ctx);
		expect(screens).toHaveLength(3);
		for (const { id } of ATTENTION_RULES) expect(screens[0]).toContain(id);
		expect(screens[0]).toContain("tripped");
		expect(screens[0]).toContain("92% vs 90%");
		expect(screens[1]).toContain("Monitor \u00b7 load");
		expect(screens[1]).toMatch(/State[^\n]*tripped/);
		expect(screens[2]).toContain("92% vs 90%");
	});
});

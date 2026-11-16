import { setKeybindings, visibleWidth } from "@octocodeai/octocode-tui";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { KeybindingsManager } from "../src/core/keybindings.ts";
import type { SessionInfo } from "../src/core/session-manager.ts";
import { SessionSelectorComponent } from "../src/modes/interactive/components/session-selector.ts";
import type { SessionExtras } from "../src/modes/interactive/components/session-selector/types.ts";
import { initTheme } from "../src/theme/theme.ts";

const DOWN = "\x1b[B";
const SPACE = " ";
const CTRL_O = "\x1b[111;5u";
const ENTER = "\r";

const flush = () => new Promise<void>((resolve) => setImmediate(resolve));
const plain = (text: string) => text.replace(/\x1B\[[0-?]*[ -/]*[@-~]/g, "");

function makeSession(n: number, overrides: Partial<SessionInfo> = {}): SessionInfo {
	const id = `s${String(n).padStart(3, "0")}`;
	return {
		path: `/tmp/${id}.jsonl`,
		id,
		cwd: "/work/repo",
		created: new Date(0),
		// Newest first, an hour apart.
		modified: new Date(Date.now() - n * 3_600_000),
		messageCount: 5 + n,
		firstMessage: `Task number ${n} with a rather long description that goes on and on ${"x".repeat(200)}`,
		allMessagesText: `Task number ${n}`,
		...overrides,
	};
}

const many = (count: number) => Array.from({ length: count }, (_, i) => makeSession(i));

function open(
	sessions: SessionInfo[],
	options: ConstructorParameters<typeof SessionSelectorComponent>[6] = {},
	callbacks: { onSelect?: (path: string) => void } = {},
) {
	const selector = new SessionSelectorComponent(
		async () => sessions,
		async () => sessions,
		callbacks.onSelect ?? (() => {}),
		() => {},
		() => {},
		() => {},
		{ keybindings: new KeybindingsManager(), initialSort: "recent", ...options },
	);
	return selector;
}

beforeAll(() => initTheme("dark"));
beforeEach(() => {
	setKeybindings(new KeybindingsManager());
	// Rows show times of day and group by calendar day: a fixed local noon keeps every relative time on the same day.
	vi.useFakeTimers({ toFake: ["Date"] });
	vi.setSystemTime(new Date(2026, 5, 17, 12, 0, 0));
});
afterEach(() => vi.useRealTimers());

describe.each([
	[80, 24],
	[120, 40],
	[200, 40],
	[120, 24],
])("session picker at %i columns and %i rows", (width, rows) => {
	it("never draws a line wider than the terminal and keeps the selected row on screen after 50 downs", async () => {
		const selector = open(many(97), { viewportRows: () => rows });
		await flush();
		for (let i = 0; i < 50; i++) {
			selector.handleInput(DOWN);
			const lines = selector.render(width);
			expect(lines.length).toBeLessThanOrEqual(rows);
			for (const line of lines) expect(visibleWidth(line)).toBeLessThanOrEqual(width);
		}
		const lines = selector.render(width).map(plain);
		const selected = selector.getSessionList().getSelectedSession()!;
		expect(selected.id).toBe("s050");
		const at = lines.findIndex((line) => /›\s+Task number 50 /.test(line));
		expect(at).toBeGreaterThan(0);
		// Both lines of the selected row are visible.
		expect(lines[at + 1]).toContain("55 msgs");
	});
});

describe("session picker layout", () => {
	it("titles the picker with the selection and the scope, and groups recent sessions by day", async () => {
		const sessions = [makeSession(0), makeSession(30), makeSession(24 * 10)];
		const lines = (async () => {
			const selector = open(sessions);
			await flush();
			return selector.render(120).map(plain);
		})();
		const out = (await lines).join("\n");
		expect(out).toContain("Resume session (1 of 3)");
		expect(out).toContain("◉ This folder ○ All");
		expect(out).toContain("Sort: Recent");
		expect(out).toMatch(/Today[\s\S]*Task number 0/);
		expect(out).toMatch(/This week|Yesterday/);
		expect(out).toMatch(/Older[\s\S]*Task number 240/);
		expect(out).toContain("just now · 5 msgs");
		expect(out).toContain("⌕");
	});

	it("shows when a session started and how long it ran, and keeps it longer than the message count", async () => {
		const modified = new Date(Date.now() - 5 * 60_000);
		const created = new Date(modified.getTime() - (93 * 60_000 + 20_000));
		const session = makeSession(0, { created, modified });
		const selector = open([session], { viewportRows: () => 40 });
		await flush();
		const clock = created.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });
		const wide = selector.render(120).map(plain).join("\n");
		expect(wide).toContain(`5m ago · ${clock} (1h 33m) · 5 msgs`);
		const tight = selector.render(30).map(plain).join("\n");
		expect(tight).toContain(clock);
		expect(tight).not.toContain("5 msgs");
		selector.handleInput(SPACE);
		const preview = selector.render(120).map(plain).join("\n");
		expect(preview).toMatch(/Started .* · ran 1h 33m/);
	});

	it("leaves the time out when the start is unknown", async () => {
		const selector = open([makeSession(0, { created: new Date(Number.NaN) })]);
		await flush();
		expect(selector.render(120).map(plain).join("\n")).toContain("just now · 5 msgs");
	});

	it("does not select a group label: one down moves to the next session", async () => {
		const selector = open([makeSession(0), makeSession(30)]);
		await flush();
		selector.handleInput(DOWN);
		expect(selector.getSessionList().getSelectedSession()!.id).toBe("s030");
	});

	it("shows a skill block as `skill: request` and a placeholder for an empty prompt", async () => {
		const selector = open([
			makeSession(0, {
				firstMessage: '<skill name="octocode-architect" location="/x">\nbody\n</skill>\n\nreview the graph',
			}),
			makeSession(1, { firstMessage: "" }),
		]);
		await flush();
		const out = selector.render(120).map(plain).join("\n");
		expect(out).toContain("octocode-architect: review the graph");
		expect(out).not.toContain("<skill");
		expect(out).toContain("(no prompt yet)");
	});

	it("puts extras on line 2 and drops files, not cost, at 80 columns or fewer", async () => {
		const extras = new Map<string, SessionExtras>([
			["s000", { branch: "feat/x", cost: "≈$1.84", files: 7, items: ["B12", "B7"], agent: "inky-kraken", live: true }],
		]);
		const selector = open([makeSession(0)], { extras: () => extras });
		await flush();
		const wide = selector.render(160).map(plain).join("\n");
		expect(wide).toContain("feat/x · ≈$1.84 · 7 files · B12 B7 · inky-kraken · 5 msgs");
		expect(wide).toContain("●");
		const narrow = selector.render(80).map(plain).join("\n");
		expect(narrow).toContain("feat/x");
		expect(narrow).toContain("≈$1.84");
		expect(narrow).not.toContain("7 files");
	});

	it("marks the current session and says when only the transcript matched", async () => {
		const sessions = [
			makeSession(0, { firstMessage: "Plan worktree support", allMessagesText: "Plan worktree support" }),
			makeSession(1, { firstMessage: "Other task", allMessagesText: "Other task and the worktree appears later" }),
		];
		const selector = open(sessions);
		await flush();
		for (const ch of "worktree") selector.handleInput(ch);
		const out = selector.render(120).map(plain);
		const title = out.findIndex((line) => line.includes("Plan worktree support"));
		const other = out.findIndex((line) => line.includes("Other task"));
		expect(title).toBeGreaterThan(0);
		expect(other).toBeGreaterThan(title);
		expect(out[title + 1]).not.toContain("matched in transcript");
		expect(out[other + 1]).toContain("matched in transcript");
		expect(out.join("\n")).toContain("(1 of 2)");
	});

	it("previews the selected session with space, and types a space once there is a query", async () => {
		const selector = open([makeSession(0, { cwd: "/work/repo" })], {
			extras: () => new Map([["s000", { branch: "main-x", files: 2 }]]),
		});
		await flush();
		selector.handleInput(SPACE);
		let out = selector.render(100).map(plain).join("\n");
		expect(out).toContain("First prompt");
		expect(out).toContain("/work/repo");
		expect(out).toContain("main-x · 2 files");
		selector.handleInput(SPACE);
		out = selector.render(100).map(plain).join("\n");
		expect(out).not.toContain("First prompt");
		selector.handleInput("a");
		selector.handleInput(SPACE);
		selector.handleInput("b");
		expect(selector.render(100).map(plain).join("\n")).toContain("a b");
	});

	it("groups by folder in the All scope", async () => {
		const sessions = [
			makeSession(0, { cwd: "/work/a" }),
			makeSession(1, { cwd: "/work/b" }),
			makeSession(2, { cwd: "/work/a" }),
		];
		const selector = open(sessions, { initialScope: "all" });
		await flush();
		const lines = selector.render(120).map(plain);
		const labels = lines.filter((line) => /^ \S*\/work\/[ab]$/.test(line.trimEnd()));
		expect(labels.map((line) => line.trim().split(" ").at(-1))).toEqual(["/work/a", "/work/b"]);
		expect(selector.getSessionList().getCounts().shown).toBe(3);
	});

	it("opens an action menu on the actions key and runs the chosen action for the selected session", async () => {
		const run = vi.fn(async () => {});
		const selector = open(many(2), {
			actions: [
				{ label: "Details", run },
				{ label: "Forget", run: async () => {} },
			],
		});
		await flush();
		expect(selector.render(120).map(plain).join("\n")).toContain("actions");
		selector.handleInput(DOWN);
		selector.handleInput(CTRL_O);
		expect(selector.render(120).map(plain).join("\n")).toMatch(/Details[\s\S]*Forget/);
		selector.handleInput(ENTER);
		await flush();
		expect(run).toHaveBeenCalledWith(expect.objectContaining({ id: "s001" }));
	});

	it("paints a quick first page before the full listing arrives", async () => {
		let finish: (sessions: SessionInfo[]) => void = () => {};
		const full = new Promise<SessionInfo[]>((resolve) => (finish = resolve));
		const selector = new SessionSelectorComponent(
			() => full,
			async () => [],
			() => {},
			() => {},
			() => {},
			() => {},
			{ keybindings: new KeybindingsManager(), quickList: async () => [makeSession(1)] },
		);
		await flush();
		expect(selector.render(120).map(plain).join("\n")).toContain("Task number 1");
		finish([makeSession(1), makeSession(2)]);
		await flush();
		expect(selector.getSessionList().getCounts().total).toBe(2);
	});

	it("opens with a query and the All scope when asked", async () => {
		const selector = open(many(5), { initialQuery: "number 3" });
		await flush();
		expect(selector.getSessionList().getSelectedSession()!.id).toBe("s003");
	});
});

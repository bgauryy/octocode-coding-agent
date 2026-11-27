/**
 * Transcript rows that change only on a signal must be tracked, or the virtual document re-renders them every frame.
 * Each kind is mounted in a container: an unchanged frame renders none of them, a state change renders the row again,
 * and a left click opens (and closes) the row where it can be expanded.
 */
import {
	Container,
	type Component,
	type TUI,
	type TuiMouseEvent,
	getKeybindings,
	markFolded,
	setKeybindings,
	setPointerClicksActive as setTranscriptRowsClickable,
} from "@octocodeai/octocode-tui";
import { afterEach, beforeAll, describe, expect, test, vi } from "vitest";
import { KeybindingsManager } from "../src/core/keybindings.ts";
import type { EntryRenderer } from "../src/core/features/types.ts";
import type { CustomEntry } from "../src/core/session-manager.ts";
import { BashExecutionComponent } from "../src/modes/interactive/components/bash-execution.ts";
import { CustomEntryComponent } from "../src/modes/interactive/components/custom-entry.ts";
import { CustomMessageComponent } from "../src/modes/interactive/components/custom-message.ts";
import { SkillInvocationMessageComponent } from "../src/modes/interactive/components/skill-invocation-message.ts";
import { expandHint } from "../src/octocode/shared/text.ts";
import { registerWakeRow } from "../src/octocode/ui/wake-row.ts";
import { WAKE_TYPE } from "../src/octocode/wake/gate.ts";
import { initTheme } from "../src/theme/theme.ts";
import { stripAnsi } from "../src/utils/ansi.ts";
import { asSetup } from "./octocode/fake-host.ts";

const WIDTH = 80;
const ui = { requestRender: () => {} } as unknown as TUI;

function click(component: Component, row: number, height: number): boolean {
	const event: TuiMouseEvent = {
		type: "click",
		button: "left",
		x: 2,
		y: row,
		screenX: 2,
		screenY: row,
		width: WIDTH,
		height,
		shift: false,
		alt: false,
		ctrl: false,
		clickCount: 1,
	};
	return (
		(component as Component & { handleMouse(e: TuiMouseEvent): { handled?: boolean } | undefined }).handleMouse(event)
			?.handled === true
	);
}

/** Counts calls of the `render` a component class declares: the prototype is wrapped, never the instance. */
function countRenders(prototype: { render(width: number): string[] }) {
	const original = prototype.render;
	const spy = vi.spyOn(prototype, "render").mockImplementation(function (this: unknown, width: number) {
		return original.call(this, width);
	});
	return spy;
}

let wakeRenderer: EntryRenderer | undefined;
registerWakeRow(
	asSetup({
		registerEntryRenderer: (_type: string, renderer: EntryRenderer) => {
			wakeRenderer = renderer;
		},
	}) as never,
);

const wakeEntry: CustomEntry = {
	type: "custom",
	customType: WAKE_TYPE,
	id: "w1",
	parentId: null,
	timestamp: new Date().toISOString(),
	data: {
		events: [
			{ kind: "report", label: "report jolly-reef done (B526)" },
			{ kind: "job", label: "job bash-5 exit 0" },
		],
	},
};

interface Kind {
	name: string;
	make(): Component;
	/** The prototype whose `render` the kind's own class declares. */
	prototype(row: Component): { render(width: number): string[] };
	change(row: Component): void;
}

const kinds: Kind[] = [
	{
		name: "bash execution",
		make: () => {
			const row = new BashExecutionComponent("seq 40", ui);
			row.appendOutput(`${Array.from({ length: 40 }, (_, i) => `line ${i}`).join("\n")}\n`);
			row.setComplete(0, false);
			return row;
		},
		prototype: () => BashExecutionComponent.prototype,
		change: (row) => (row as BashExecutionComponent).setExpanded(true),
	},
	{
		name: "custom message (default rendering)",
		make: () =>
			new CustomMessageComponent({ role: "custom", customType: "note", content: "hello", display: true, timestamp: 1 }),
		prototype: () => CustomMessageComponent.prototype,
		change: (row) => (row as CustomMessageComponent).setOutputPad(3),
	},
	{
		name: "custom entry (wake row)",
		make: () => new CustomEntryComponent(wakeEntry, wakeRenderer!),
		prototype: () => CustomEntryComponent.prototype,
		change: (row) => (row as CustomEntryComponent).setExpanded(true),
	},
	{
		name: "wake row",
		make: () => wakeRenderer!(wakeEntry, { expanded: false }, { fg: (_c: string, t: string) => t } as never)!,
		prototype: (row) => Object.getPrototypeOf((row as unknown as { child: object }).child),
		change: (row) => click(row, 0, 1),
	},
	{
		name: "skill invocation",
		make: () =>
			new SkillInvocationMessageComponent({
				name: "research",
				location: "/tmp/skills/research/SKILL.md",
				content: "body",
			} as never),
		prototype: () => SkillInvocationMessageComponent.prototype,
		change: (row) => (row as SkillInvocationMessageComponent).setExpanded(true),
	},
];

describe("transcript row render tracking", () => {
	beforeAll(() => initTheme("dark"));
	const previousKeybindings = getKeybindings();
	afterEach(() => {
		vi.restoreAllMocks();
		setKeybindings(previousKeybindings);
		setTranscriptRowsClickable(false);
	});

	for (const kind of kinds) {
		test(`${kind.name}: an unchanged frame renders nothing, a state change renders again`, () => {
			const transcript = new Container();
			const row = kind.make();
			transcript.addChild(row);
			transcript.render(WIDTH);

			const spy = countRenders(kind.prototype(row));
			transcript.render(WIDTH);
			expect(spy).toHaveBeenCalledTimes(0);

			kind.change(row);
			transcript.render(WIDTH);
			expect(spy.mock.calls.length).toBeGreaterThan(0);
		});
	}
});

describe("click to expand", () => {
	beforeAll(() => initTheme("dark"));
	afterEach(() => setTranscriptRowsClickable(false));

	test("a bash row opens and closes on a left click, and only when output is hidden", () => {
		const row = new BashExecutionComponent("seq 40", ui);
		row.appendOutput(`${Array.from({ length: 40 }, (_, i) => `line ${i}`).join("\n")}\n`);
		row.setComplete(0, false);
		const collapsed = row.render(WIDTH);
		expect(stripAnsi(collapsed.join("\n"))).not.toContain("line 0 ");
		expect(click(row, 2, collapsed.length)).toBe(true);
		const open = row.render(WIDTH);
		expect(stripAnsi(open.join("\n"))).toContain("line 0 ");
		expect(click(row, 2, open.length)).toBe(true);
		expect(row.render(WIDTH).length).toBe(collapsed.length);

		const short = new BashExecutionComponent("echo hi", ui);
		short.appendOutput("hi\n");
		short.setComplete(0, false);
		expect(click(short, 2, short.render(WIDTH).length)).toBe(false);
	});

	test("a system event discloses its route and payload only when opened", () => {
		const entry = {
			...wakeEntry,
			data: {
				events: [
					{
						kind: "job.exit",
						label: "Build completed",
						from: "job build",
						data: { exit: 0, durationMs: 1400 },
					},
				],
			},
		};
		const row = new CustomEntryComponent(entry, wakeRenderer!);
		const preview = row.render(30).join("\n");
		expect(preview).toContain("Build completed");
		expect(preview).not.toContain("durationMs");
		row.setExpanded(true);
		const details = stripAnsi(row.render(60).join("\n"));
		expect(details).toContain("job.exit · job build → this session");
		expect(details).toContain('"durationMs": 1400');
	});

	test("a wake row opens on a left click while ctrl+o state of other rows is untouched", () => {
		const first = wakeRenderer!(wakeEntry, { expanded: false }, { fg: (_c: string, t: string) => t } as never)!;
		const second = wakeRenderer!(wakeEntry, { expanded: false }, { fg: (_c: string, t: string) => t } as never)!;
		expect(first.render(WIDTH)).toHaveLength(1);
		expect(click(first, 0, 1)).toBe(true);
		expect(first.render(WIDTH)).toHaveLength(3);
		expect(second.render(WIDTH)).toHaveLength(1);
		click(first, 0, 3);
		expect(first.render(WIDTH)).toHaveLength(1);
	});
});

describe("expand hint wording", () => {
	afterEach(() => setTranscriptRowsClickable(false));

	test("names the click only where the mouse is reported and the row toggles on it", () => {
		setTranscriptRowsClickable(false);
		expect(expandHint("expand", "ctrl+o")).toBe(markFolded("(ctrl+o to expand)"));
		expect(expandHint("expand", "unbound")).toBe("");
		setTranscriptRowsClickable(true);
		expect(expandHint("expand", "ctrl+o")).toBe(markFolded("(ctrl+o or click to expand)"));
		expect(expandHint("expand", "ctrl+t")).toBe(markFolded("(ctrl+t or click to expand)"));
		expect(expandHint("expand", "")).toBe(markFolded("(click to expand)"));
		expect(expandHint("expand", "ctrl+o", false)).toBe(markFolded("(ctrl+o to expand)"));
		expect(expandHint("collapse", "ctrl+o", false)).toBe("(ctrl+o to collapse)");
		expect(expandHint("expand", "unbound", false)).toBe("");
	});

	test("follows the shared flag for the thinking key and an unbound key", () => {
		setKeybindings(new KeybindingsManager({ "app.thinking.toggle": [] }));
		setTranscriptRowsClickable(true);
		expect(expandHint("expand", "")).toBe(markFolded("(click to expand)"));
	});
});

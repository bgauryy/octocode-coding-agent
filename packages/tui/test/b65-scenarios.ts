import type { FrameSample, Harness } from "./b65-harness.ts";

export const TRANSITIONS = [
	"startup",
	"streaming",
	"first scroll",
	"scrollbar",
	"selection (settled, cross-history)",
	"search (settled)",
	"resize",
] as const;

export interface ScriptResult {
	/** Frames per transition, in order. */
	readonly samples: Map<string, FrameSample[]>;
	/** The painted screen after each transition has settled. */
	readonly screens: Map<string, readonly string[]>;
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** Exact layout, and an open search finished indexing (it indexes between frames in time-budgeted slices). */
export async function settled(h: Harness, name: string): Promise<FrameSample[]> {
	const frames = h.settle(name);
	for (let wait = 0; wait < 2000 && h.screen().some((row) => row.includes("Searching")); wait++) {
		await sleep(2);
		frames.push(h.frame(name));
	}
	return frames;
}
const WHEEL_UP = "\x1b[<64;50;10M";

/**
 * The same event script for every layout: startup, streaming into a new last row, the first wheel scroll, the
 * scrollbar, a selection from the first row to a late one, search, and a width change. Each transition ends settled
 * (an exact layout), where the screens of a virtual and an exact transcript must be equal.
 */
export async function runScript(h: Harness, rows: number): Promise<ScriptResult> {
	const samples = new Map<string, FrameSample[]>();
	const screens = new Map<string, readonly string[]>();
	const run = async (name: string, body: () => FrameSample[]) => {
		const frames = body();
		frames.push(...(await settled(h, name)));
		samples.set(name, frames);
		screens.set(name, [...h.screen()]);
	};

	await run("startup", () => h.settle("startup"));

	await run("streaming", () => {
		const frames: FrameSample[] = [];
		const row = h.appendRow(rows);
		let text = "Streaming reply:";
		for (let tick = 0; tick < 20; tick++) {
			text += ` word${tick} and \`code${tick}\`${tick % 5 === 4 ? "\\n\\n- item" : ""}`;
			frames.push(h.update("streaming", () => row.setText(text)));
		}
		return frames;
	});

	await run("first scroll", () => {
		const frames: FrameSample[] = [];
		for (let tick = 0; tick < 10; tick++) frames.push(h.input("first scroll", WHEEL_UP));
		return frames;
	});

	await run("scrollbar", () => {
		const frames: FrameSample[] = [];
		frames.push(h.input("scrollbar", `\x1b[<35;${h.width};5M`));
		frames.push(h.input("scrollbar", `\x1b[<0;${h.width};5M`));
		for (const y of [8, 12, 16]) frames.push(h.input("scrollbar", `\x1b[<32;${h.width};${y}M`));
		frames.push(h.input("scrollbar", `\x1b[<0;${h.width};16m`));
		return frames;
	});

	await run("selection (settled, cross-history)", () => {
		const frames: FrameSample[] = [];
		const name = "selection (settled, cross-history)";
		frames.push(h.update(name, () => h.transcript.scrollToStart()));
		frames.push(h.input(name, "\x1b[<0;5;3M"));
		frames.push(h.update(name, () => h.transcript.scrollToEnd()));
		for (const y of [10, 20]) frames.push(h.input(name, `\x1b[<32;40;${y}M`));
		frames.push(h.input(name, "\x1b[<0;40;20m"));
		return frames;
	});

	await run("search (settled)", () => {
		const frames: FrameSample[] = [];
		const name = "search (settled)";
		frames.push(h.input(name, "\x1b[102;6u"));
		for (const key of "Step 5") frames.push(h.input(name, key));
		return frames;
	});

	const resized: FrameSample[] = [];
	const first = h.frames.length;
	h.terminal.resize(80, h.height);
	await sleep(120);
	resized.push(...h.frames.slice(first));
	await run("resize", () => resized);
	return { samples, screens };
}

/** Selection and search while the first layout is still being measured (virtual): the cold paths. */
export async function runCold(
	h: Harness,
): Promise<{ selection: FrameSample[]; search: FrameSample[]; screens: readonly string[][] }> {
	const selection: FrameSample[] = [];
	const search: FrameSample[] = [];
	const screens: string[][] = [];
	h.frame("cold start");
	selection.push(h.update("cold selection", () => h.transcript.scrollToStart()));
	selection.push(h.input("cold selection", "\x1b[<0;5;3M"));
	selection.push(h.update("cold selection", () => h.transcript.scrollToEnd()));
	for (const y of [10, 20]) selection.push(h.input("cold selection", `\x1b[<32;40;${y}M`));
	selection.push(h.input("cold selection", "\x1b[<0;40;20m"));
	selection.push(...(await settled(h, "cold selection")));
	screens.push([...h.screen()]);
	search.push(h.input("cold search", "\x1b[102;6u"));
	for (const key of "Step 5") search.push(h.input("cold search", key));
	search.push(...(await settled(h, "cold search")));
	screens.push([...h.screen()]);
	return { selection, search, screens };
}

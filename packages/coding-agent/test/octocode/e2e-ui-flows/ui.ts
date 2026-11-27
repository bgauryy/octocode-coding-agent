import { fauxAssistantMessage } from "@octocodeai/octocode-ai";
import { ensureTool } from "../../../src/utils/tools-manager.ts";
import { VirtualTerminal } from "../../../../tui/test/virtual-terminal.ts";
import { type InteractiveHarness, type InteractiveOptions, startInteractive } from "../e2e-commands-harness.ts";

/** Keys as a terminal sends them. */
export const KEY = {
	esc: "\x1b",
	enter: "\r",
	tab: "\t",
	ctrlC: "\x03",
	ctrlD: "\x04",
	up: "\x1b[A",
	down: "\x1b[B",
	pageUp: "\x1b[5~",
	pageDown: "\x1b[6~",
};

/** A model turn that streams nothing until the user aborts it (or `release()` is called). */
export function hang(text = "released") {
	// A release that comes before the model is called (the run is still preparing) answers that call at once.
	let released = false;
	let release: () => void = () => {
		released = true;
	};
	const state = { started: false };
	const step = (_context: unknown, options?: { signal?: AbortSignal }) =>
		new Promise<ReturnType<typeof fauxAssistantMessage>>((resolve) => {
			state.started = true;
			release = () => resolve(fauxAssistantMessage(text));
			if (released) return release();
			options?.signal?.addEventListener("abort", release, { once: true });
		});
	return Object.assign(step, {
		release: () => release(),
		/** True once the run reached the model: its prompt is in the session. */
		started: () => state.started,
	});
}

export interface UiHarness extends InteractiveHarness {
	terminal: VirtualTerminal;
	/** The visible rows joined, trailing blanks dropped. */
	text(): Promise<string>;
	/** Types text one key at a time, then lets the renderer settle. */
	type(text: string): Promise<void>;
	/** `shutdown` calls (the process exit itself is replaced). */
	shutdowns: number;
}

/** The interactive host over an xterm grid (120x40): keys go in through the terminal, assertions read its rows. */
export async function startUi(options: Omit<InteractiveOptions, "terminal"> = {}): Promise<UiHarness> {
	const terminal = new VirtualTerminal(120, 40);
	const t = (await startInteractive({ ...options, terminal })) as UiHarness;
	t.shutdowns = 0;
	// `startup.run` (skipped by the harness) resolves fd for `@` completion; do the same.
	t.host.uiStore.getState().setFdPath(await ensureTool("fd"));
	t.host.setupAutocompleteProvider();
	(t.host as { shutdown: unknown }).shutdown = async () => {
		t.shutdowns++;
	};
	t.text = async () => (await t.grid()).join("\n").trimEnd();
	t.type = async (text) => {
		for (const ch of text) t.press(ch);
		await new Promise((resolve) => setTimeout(resolve, 150));
	};
	await t.until(async () => (await t.text()).length > 0, "first paint");
	return t;
}

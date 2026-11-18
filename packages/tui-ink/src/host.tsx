import { PassThrough } from "node:stream";
import type { Terminal } from "@octocodeai/octocode-tui";
import { type Instance, render, type RenderOptions } from "ink";
import type { ReactNode } from "react";
import { type InputSource, InputProvider } from "./input.tsx";
import { type StdoutCounters, TerminalStdout } from "./terminal-stdout.ts";

/** `inline` writes finished rows to native scrollback under a live area; `fullscreen` owns the alternate screen. */
export type InkScreen = "inline" | "fullscreen";

/** Streaming paints about every 40 ms, the old renderer's pace. */
export const STREAM_FRAME_FPS = 25;

// SGR (1006) button and wheel reports with focus events; matches the old fullscreen renderer.
const ENABLE_MOUSE = "\x1b[?1000h\x1b[?1002h\x1b[?1004h\x1b[?1006h";
const DISABLE_MOUSE = "\x1b[?1006l\x1b[?1004l\x1b[?1003l\x1b[?1002l\x1b[?1000l";

export interface InkHostOptions {
	readonly terminal: Terminal;
	readonly screen: InkScreen;
	readonly input?: InputSource;
	readonly maxFps?: number;
	readonly incrementalRendering?: boolean;
	readonly onRender?: RenderOptions["onRender"];
}

export interface InkHost {
	readonly counters: Readonly<StdoutCounters>;
	rerender(node: ReactNode): void;
	/** The terminal changed size: Ink lays out again at the new size. */
	resized(): void;
	unmount(): void;
}

/**
 * Mount `node` with Ink on the terminal's output queue. Input stays with the terminal's own parser: Ink gets a stdin
 * that is not a TTY, so it never switches raw mode or reads keys, and `useInput` is not used.
 */
export function mountInk(node: ReactNode, options: InkHostOptions): InkHost {
	const stdout = new TerminalStdout(options.terminal);
	const stdin = new PassThrough();
	const wrap = (child: ReactNode) => <InputProvider source={options.input}>{child}</InputProvider>;
	const fullscreen = options.screen === "fullscreen";
	const instance: Instance = render(wrap(node), {
		stdout,
		stdin,
		exitOnCtrlC: false,
		patchConsole: false,
		// The stream is a terminal even where CI detection would say otherwise.
		interactive: true,
		alternateScreen: fullscreen,
		maxFps: options.maxFps ?? STREAM_FRAME_FPS,
		incrementalRendering: options.incrementalRendering ?? false,
		onRender: options.onRender,
	});
	if (fullscreen) options.terminal.write(ENABLE_MOUSE);
	let mounted = true;
	return {
		counters: stdout.counters,
		rerender: (next) => instance.rerender(wrap(next)),
		resized: () => stdout.resized(),
		unmount: () => {
			if (!mounted) return;
			mounted = false;
			if (fullscreen) options.terminal.write(DISABLE_MOUSE);
			instance.unmount();
			stdin.destroy();
		},
	};
}

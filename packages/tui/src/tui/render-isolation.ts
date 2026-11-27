import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { stripTerminalSequences } from "../utils/ansi-codes.ts";
import { stripControlCharacters } from "../utils/chars.ts";
import { truncateToWidth } from "../utils/truncate.ts";
import type { Component } from "./component.ts";

/** Receives a component's render error; called once per distinct failure until the component renders again. */
export type RenderErrorListener = (error: unknown, component: Component) => void;

let activeListener: RenderErrorListener | undefined;
const reportedFailures = new WeakMap<Component, string>();

/**
 * Run one TUI frame with render isolation: inside it, a component that throws from `render` is
 * replaced by a one-line fallback and reported to `listener`, so its siblings keep painting.
 * Outside a frame (a direct `render` call) errors propagate unchanged.
 */
export function withRenderIsolation<T>(listener: RenderErrorListener, frame: () => T): T {
	const previous = activeListener;
	activeListener = listener;
	try {
		return frame();
	} finally {
		activeListener = previous;
	}
}

/**
 * Bind `work` to the render isolation active now. A frame hands out work that renders later, from a key or pointer
 * handler outside any frame (measuring a virtualized scroll view's rows, say); bound, a component that throws there
 * paints its fallback and reaches the frame's listener, as it would inside the frame.
 */
export function bindRenderIsolation<T>(work: () => T): () => T {
	const listener = activeListener;
	return listener ? () => withRenderIsolation(listener, work) : work;
}

function componentName(component: Component): string {
	const name = (component as { constructor?: { name?: unknown } }).constructor?.name;
	return typeof name === "string" && name !== "Object" && name !== "" ? name : "Component";
}

function errorMessage(error: unknown): string {
	if (!(error instanceof Error)) return String(error);
	return error.name && error.name !== "Error" ? `${error.name}: ${error.message}` : error.message;
}

/** Render a child at a composite's boundary; the innermost boundary around a throwing component isolates it. */
export function renderIsolated(component: Component, width: number): string[] {
	return renderIsolatedWith(component, width, () => component.render(width));
}

/** `renderIsolated`, with `render` producing the component's rows in another form; a failure paints the fallback row. */
export function renderIsolatedWith<T>(component: Component, width: number, render: () => T): T | string[] {
	const listener = activeListener;
	if (!listener) return render();
	try {
		const lines = render();
		if (reportedFailures.has(component)) reportedFailures.delete(component);
		return lines;
	} catch (error) {
		const name = componentName(component);
		const message = errorMessage(error);
		// Frames repeat every few milliseconds; report a failure once, not once per frame.
		if (reportedFailures.get(component) !== message) {
			reportedFailures.set(component, message);
			try {
				listener(error, component);
			} catch {
				// A failing reporter must not take down the frame it is reporting on.
			}
		}
		const firstLine = stripControlCharacters(stripTerminalSequences(message.split("\n", 1)[0] ?? ""));
		const text = `⚠ ${name} failed to render: ${firstLine}`;
		return [truncateToWidth(text, Math.max(1, width))];
	}
}

/** Whether the last isolated render of `component` failed and painted the fallback row instead. */
export function renderFailed(component: Component): boolean {
	return reportedFailures.has(component);
}

/** Default reporter: append the error to `octocode-tui-render-errors.log` beside the TUI's other debug logs. */
export function appendRenderErrorLog(logDirectory: string | undefined, error: unknown, component: Component): void {
	const logPath = path.join(logDirectory ?? os.tmpdir(), "octocode-tui-render-errors.log");
	const detail = error instanceof Error ? (error.stack ?? errorMessage(error)) : errorMessage(error);
	fs.mkdirSync(path.dirname(logPath), { recursive: true });
	fs.appendFileSync(
		logPath,
		`[${new Date().toISOString()}] ${componentName(component)} failed to render\n${detail}\n\n`,
	);
}

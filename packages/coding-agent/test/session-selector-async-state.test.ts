import { setKeybindings } from "@octocodeai/octocode-tui";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { KeybindingsManager } from "../src/core/keybindings.ts";
import type { SessionInfo } from "../src/core/session-manager.ts";
import type { SessionRemoval } from "../src/core/session-picker.ts";
import { SessionSelectorComponent } from "../src/modes/interactive/components/session-selector.ts";
import { initTheme } from "../src/theme/theme.ts";

const flush = () => new Promise<void>((resolve) => setImmediate(resolve));
const CTRL_R = "\x1b[114;5u";
const session: SessionInfo = {
	path: "/tmp/selector-async-session.jsonl",
	id: "selector-async",
	cwd: "/tmp",
	name: "Old",
	created: new Date(0),
	modified: new Date(0),
	messageCount: 1,
	firstMessage: "hello",
	allMessagesText: "hello",
};

function deferred<T>() {
	let resolve!: (value: T) => void;
	const promise = new Promise<T>((done) => {
		resolve = done;
	});
	return { promise, resolve };
}

describe("session picker asynchronous state", () => {
	const opened: SessionSelectorComponent[] = [];
	beforeAll(() => initTheme("dark"));
	beforeEach(() => setKeybindings(new KeybindingsManager()));
	afterEach(() => {
		for (const picker of opened.splice(0)) picker.dispose();
	});

	it("falls back to transcript listing when the quick catalog throws synchronously", async () => {
		const picker = new SessionSelectorComponent(
			async () => [session],
			async () => [],
			() => {},
			() => {},
			() => {},
			() => {},
			{
				quickList: () => {
					throw new Error("catalog unavailable");
				},
			},
		);
		opened.push(picker);
		await flush();
		expect(picker.getSessionList().getSelectedSessionPath()).toBe(session.path);
		expect(picker.render(120).join("\n")).not.toMatch(/loading/i);
	});

	it("keeps displayed quick rows available for deletion and scope changes", async () => {
		const full = deferred<SessionInfo[]>();
		const removeSessions = vi.fn(async () => ({ removed: [], problems: [] }));
		const picker = new SessionSelectorComponent(
			() => full.promise,
			async () => [],
			() => {},
			() => {},
			() => {},
			() => {},
			{ quickList: async (scope) => (scope === "current" ? [session] : []), removeSessions },
		);
		opened.push(picker);
		await flush();
		picker.handleInput("\t");
		picker.handleInput("\t");
		expect(picker.getSessionList().getSelectedSessionPath()).toBe(session.path);
		picker.handleInput("\x04");
		picker.handleInput("\r");
		await flush();
		expect(removeSessions).toHaveBeenCalledWith([session]);
	});

	it("submits a pending rename once and shows progress", async () => {
		const rename = deferred<void>();
		const renameSession = vi.fn(() => rename.promise);
		const picker = new SessionSelectorComponent(
			async () => [session],
			async () => [],
			() => {},
			() => {},
			() => {},
			() => {},
			{ renameSession },
		);
		opened.push(picker);
		await flush();
		picker.handleInput(CTRL_R);
		picker.handleInput("\r");
		picker.handleInput("\r");
		expect(renameSession).toHaveBeenCalledTimes(1);
		expect(picker.render(120).join("\n")).toContain("Renaming session");
		rename.resolve();
		await flush();
		expect(picker.render(120).join("\n")).toContain("Resume session");
	});

	it("does not redraw or restart listing after a pending rename is disposed", async () => {
		const rename = deferred<void>();
		const load = vi.fn(async () => [session]);
		const render = vi.fn();
		const picker = new SessionSelectorComponent(
			load,
			async () => [],
			() => {},
			() => {},
			() => {},
			render,
			{ renameSession: () => rename.promise },
		);
		opened.push(picker);
		await flush();
		picker.handleInput(CTRL_R);
		picker.handleInput("\r");
		picker.dispose();
		render.mockClear();
		rename.resolve();
		await flush();
		expect(render).not.toHaveBeenCalled();
		expect(load).toHaveBeenCalledTimes(1);
	});

	it("keeps a delete pending once and ignores its completion after disposal", async () => {
		const removal = deferred<SessionRemoval>();
		const removeSessions = vi.fn(() => removal.promise);
		const load = vi.fn(async () => [session]);
		const render = vi.fn();
		const picker = new SessionSelectorComponent(
			load,
			async () => [],
			() => {},
			() => {},
			() => {},
			render,
			{ removeSessions },
		);
		opened.push(picker);
		await flush();
		picker.handleInput("\x04");
		picker.handleInput("\r");
		picker.handleInput("\x04");
		picker.handleInput("\r");
		expect(removeSessions).toHaveBeenCalledTimes(1);
		expect(picker.render(120).join("\n")).toContain("Deleting session");
		picker.dispose();
		render.mockClear();
		removal.resolve({ removed: [session.path], problems: [], method: "trash" });
		await flush();
		expect(render).not.toHaveBeenCalled();
		expect(load).toHaveBeenCalledTimes(1);
	});
});

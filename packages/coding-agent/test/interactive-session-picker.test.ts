import { setKeybindings } from "@octocodeai/octocode-tui";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { KeybindingsManager } from "../src/core/keybindings.ts";
import { type SessionInfo, SessionManager } from "../src/core/session-manager.ts";
import { pickSession } from "../src/modes/interactive/interactive-mode/session-picker.ts";
import { initTheme } from "../src/theme/theme.ts";

const ENTER = "\r";
const flush = () => new Promise<void>((resolve) => setImmediate(resolve));

const row: SessionInfo = {
	path: "/tmp/quick.jsonl",
	id: "quick",
	cwd: "/work/repo",
	name: "Fix resume picker",
	nameSource: "auto",
	created: new Date(0),
	modified: new Date(),
	messageCount: 4,
	firstMessage: "fix the resume picker",
	allMessagesText: "",
};

beforeAll(() => initTheme("dark"));
beforeEach(() => setKeybindings(new KeybindingsManager()));
afterEach(() => vi.restoreAllMocks());

describe("interactive pickSession", () => {
	it("resumes a row from the quick first page while the full listing is still loading", async () => {
		// The full transcript listing never finishes: only the catalog's quick page is on screen.
		vi.spyOn(SessionManager, "list").mockReturnValue(new Promise(() => {}));
		let input: ((data: string) => void) | undefined;
		const host = {
			session: { setSessionName: vi.fn() },
			sessionManager: {
				getCwd: () => "/work/repo",
				getSessionDir: () => "/tmp",
				getSessionFile: () => "/tmp/current.jsonl",
				usesDefaultSessionDir: () => true,
			},
			ui: {},
			showExtensionCustom: <T>(
				factory: (
					tui: unknown,
					theme: unknown,
					keybindings: unknown,
					done: (value: T) => void,
				) => {
					handleInput(data: string): void;
				},
			) =>
				new Promise<T>((resolve) => {
					const tui = { requestRender: () => {}, terminal: { rows: 40, columns: 120 } };
					const component = factory(tui, undefined, new KeybindingsManager(), resolve);
					input = (data) => component.handleInput(data);
				}),
		} as unknown as Parameters<typeof pickSession>[0];

		const picked = pickSession(host, { quickList: async () => [row] });
		await flush();
		await flush();
		input!(ENTER);
		expect(await picked).toEqual(row);
	});
});

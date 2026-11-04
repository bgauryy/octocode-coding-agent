import { Container, setKeybindings, TuiMainScreen, visibleWidth } from "@octocodeai/octocode-tui";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { VirtualTerminal } from "../../tui/test/virtual-terminal.ts";
import type { QueuedInput, ReleasedQueuedInput } from "../src/core/agent-session.ts";
import { KeybindingsManager } from "../src/core/keybindings.ts";
import type { QueueListComponent } from "../src/modes/interactive/components/queue-list.ts";
import { showQueueManager } from "../src/modes/interactive/interactive-mode/queue-list.ts";
import { initTheme } from "../src/theme/theme.ts";
import { bindQueueState, createFakeHost, fakeQueueService, heldStore } from "./interactive-mode-host.ts";

const KEY = { up: "\x1b[A", down: "\x1b[B", shiftUp: "\x1b[1;2A", enter: "\r", esc: "\x1b" };

beforeEach(() => {
	initTheme("dark");
	setKeybindings(new KeybindingsManager());
});
afterEach(() => setKeybindings(new KeybindingsManager()));

/** A session queue with the core semantics: held messages keep their place and cannot be delivered or changed. */
function fixture(
	queued: Array<Partial<QueuedInput> & { text: string }>,
	compaction: Array<{ text: string; mode: "steer" | "followUp" }> = [],
) {
	let items: QueuedInput[] = queued.map((entry, index) => ({
		id: `q${index + 1}`,
		mode: "steer",
		imageCount: 0,
		source: "interactive",
		...entry,
	}));
	const held = new Set<string>();
	const ordered = () => [...items.filter((i) => i.mode === "steer"), ...items.filter((i) => i.mode === "followUp")];
	const session = {
		isStreaming: true,
		isCompacting: false,
		getQueuedInputs: () => ordered().map((item) => (held.has(item.id) ? { ...item, held: true as const } : item)),
		getSteeringMessages: () =>
			ordered()
				.filter((i) => i.mode === "steer")
				.map((i) => i.text),
		getFollowUpMessages: () =>
			ordered()
				.filter((i) => i.mode === "followUp")
				.map((i) => i.text),
		removeQueuedInput: vi.fn((id: string) => {
			const found = items.find((item) => item.id === id && !held.has(id));
			items = items.filter((item) => item !== found);
			return found;
		}),
		moveQueuedInput: vi.fn((id: string, direction: "up" | "down") => {
			const list = ordered();
			const index = list.findIndex((item) => item.id === id);
			const other = list[index + (direction === "up" ? -1 : 1)];
			if (index < 0 || !other || other.mode !== list[index].mode) return false;
			const a = items.indexOf(list[index]);
			const b = items.indexOf(other);
			[items[a], items[b]] = [items[b], items[a]];
			return true;
		}),
		setQueuedInputMode: vi.fn((id: string, mode: "steer" | "followUp") => {
			const found = items.find((item) => item.id === id && !held.has(id));
			if (!found) return false;
			items = [...items.filter((item) => item !== found), { ...found, mode }];
			return true;
		}),
		holdQueuedInput: vi.fn((id: string) => {
			const found = items.find((item) => item.id === id);
			if (!found || held.has(id)) return undefined;
			held.add(id);
			return { ...found, held: true as const };
		}),
		releaseQueuedInput: vi.fn((id: string, text?: string): ReleasedQueuedInput => {
			const found = items.find((item) => item.id === id);
			if (!found || !held.delete(id)) return { outcome: "missing" };
			if (text !== undefined && !text.trim()) {
				items = items.filter((item) => item !== found);
				return { outcome: "removed" };
			}
			if (text !== undefined) found.text = text;
			if (session.isStreaming) return { outcome: "queued" };
			items = items.filter((item) => item !== found);
			return { outcome: "idle", mode: found.mode, text: found.text, images: [], source: found.source };
		}),
		prompt: vi.fn(async (_text: string, options?: { preflightResult?: () => void }) => options?.preflightResult?.()),
		/** The agent starts delivering the first message that is not held. */
		deliverNext() {
			const next = ordered().find((item) => !held.has(item.id));
			items = items.filter((item) => item !== next);
		},
	};
	let mounted: { component: QueueListComponent; dispose?: () => void } | undefined;
	const editorText = { value: "" };
	const ui = {
		session,
		uiStore: heldStore(compaction),
		editor: { getText: () => editorText.value, setText: (text: string) => (editorText.value = text) },
		pendingMessagesContainer: new Container(),
		getAppKeyDisplay: () => "alt+up",
		keybindings: new KeybindingsManager(),
		settingsManager: { getExternalEditorCommand: () => undefined },
		showStatus: vi.fn(),
		showError: vi.fn(),
		showSelector: vi.fn((create: (done: () => void) => { component: unknown; dispose?: () => void }) => {
			const created = create(() => {
				created.dispose?.();
				mounted = undefined;
			});
			mounted = created as typeof mounted;
		}),
		ui: Object.assign(new TuiMainScreen(new VirtualTerminal()), { requestRender: vi.fn() }),
	};
	const host = createFakeHost(ui);
	const { source, sync } = fakeQueueService(session);
	bindQueueState(host, source);
	const list = () => mounted?.component;
	const press = (...keys: string[]) => {
		for (const key of keys) list()?.handleInput(key);
	};
	const texts = () => session.getQueuedInputs().map((item) => item.text);
	return { host, ui, session, sync, list, press, texts, editorText, displace: () => mounted?.dispose?.() };
}

describe("queued-messages list", () => {
	test("opens focused on the last message for Up and lists every row with kind and notes", () => {
		const { host, list } = fixture([
			{ text: "first" },
			{ text: "with image", mode: "followUp", imageCount: 1, source: "extension" },
		]);
		expect(showQueueManager(host, "last")).toBe(true);
		expect(list()?.selectedIndex).toBe(1);
		const rendered = list()?.render(80).join("\n") ?? "";
		expect(rendered).toContain("Next turn");
		expect(rendered).toContain("After run");
		expect(rendered).toContain("1 attachment, extension");
		expect(rendered).toContain("enter edit");
		for (const line of list()?.render(80) ?? [])
			expect(line.replace(/\x1b\[[0-9;]*m/g, "").length).toBeLessThanOrEqual(80);
	});

	test("fits narrow terminals and wide characters, and always keeps the keys to edit, delete and close", () => {
		const { host, list } = fixture([
			{ text: "日本語のメッセージはとても長いです。日本語のメッセージはとても長いです 😀😀", mode: "followUp" },
			{ text: "fix the failing tests in src/core and also update the docs\nsecond line", imageCount: 1 },
		]);
		expect(showQueueManager(host, "last")).toBe(true);
		for (const width of [30, 40, 60, 80]) {
			const lines = list()?.render(width) ?? [];
			for (const line of lines) expect(visibleWidth(line), `width ${width}`).toBeLessThanOrEqual(width);
			const text = lines.map((line) => line.replace(/\x1b\[[0-9;]*m/g, "")).join("\n");
			expect(text, `width ${width}`).toMatch(/enter edit · d delete · esc close|d delete · esc close/);
		}
	});

	test("says so and opens nothing when the queue is empty", () => {
		const { host, ui } = fixture([]);
		expect(showQueueManager(host)).toBe(false);
		expect(ui.showSelector).not.toHaveBeenCalled();
		expect(ui.showStatus).toHaveBeenCalledWith("No queued messages");
	});

	test("moves, toggles and deletes the selected message; selection follows it", () => {
		const { host, press, texts, list, session } = fixture([
			{ text: "a" },
			{ text: "b" },
			{ text: "c", mode: "followUp" },
		]);
		showQueueManager(host);
		press(KEY.down, KEY.shiftUp);
		expect(texts()).toEqual(["b", "a", "c"]);
		expect(list()?.selectedIndex).toBe(0);
		press("J");
		expect(texts()).toEqual(["a", "b", "c"]);
		// c: after run → next turn, goes last among next-turn messages.
		press(KEY.down, "s");
		expect(session.getSteeringMessages()).toEqual(["a", "b", "c"]);
		expect(list()?.selectedIndex).toBe(2);
		press("s");
		expect(session.getFollowUpMessages()).toEqual(["c"]);
		press("d");
		expect(texts()).toEqual(["a", "b"]);
		expect(list()?.selectedIndex).toBe(1);
		press(KEY.esc);
		expect(list()).toBeUndefined();
	});

	test("edit holds the message so delivery passes it, and saving puts the new text back in its place", () => {
		const { host, press, texts, session, list } = fixture([{ text: "a" }, { text: "b" }, { text: "c" }]);
		showQueueManager(host);
		press(KEY.down, KEY.enter);
		expect(session.holdQueuedInput).toHaveBeenCalledWith("q2");
		expect(list()?.isEditing).toBe(true);
		// The agent takes the next deliverable message: a, then c; never the held b.
		session.deliverNext();
		expect(texts()).toEqual(["b", "c"]);
		press("!", KEY.enter);
		expect(session.releaseQueuedInput).toHaveBeenCalledWith("q2", "b!");
		expect(texts()).toEqual(["b!", "c"]);
		expect(session.getQueuedInputs()[0].held).toBeUndefined();
		expect(list()?.isEditing).toBe(false);
		expect(list()?.selectedIndex).toBe(0);
		expect(session.prompt).not.toHaveBeenCalled();
	});

	test("cancelling an edit puts the message back unchanged; blank text removes it", () => {
		const { host, press, texts, session } = fixture([{ text: "keep" }, { text: "x" }]);
		showQueueManager(host);
		press("e", "?", KEY.esc);
		expect(session.releaseQueuedInput).toHaveBeenLastCalledWith("q1", undefined);
		expect(texts()).toEqual(["keep", "x"]);
		press(KEY.down, "e", "\x7f", KEY.enter);
		expect(texts()).toEqual(["keep"]);
	});

	test("editing a message whose delivery already began does nothing but say so", () => {
		const { host, press, session, ui, list, texts } = fixture([{ text: "racing" }, { text: "other" }]);
		showQueueManager(host);
		session.deliverNext();
		press(KEY.enter);
		expect(list()?.isEditing).toBe(false);
		expect(ui.showStatus).toHaveBeenCalledWith("That message is already being delivered");
		expect(texts()).toEqual(["other"]);
		expect(session.releaseQueuedInput).not.toHaveBeenCalled();
	});

	test("when the run ended during the edit, saving sends the message once instead of queueing it", () => {
		const { host, press, session, texts } = fixture([{ text: "later", mode: "followUp" }]);
		showQueueManager(host);
		press(KEY.enter);
		session.isStreaming = false;
		press("!", KEY.enter);
		expect(texts()).toEqual([]);
		expect(session.prompt).toHaveBeenCalledOnce();
		expect(session.prompt).toHaveBeenCalledWith(
			"later!",
			expect.objectContaining({ streamingBehavior: "followUp", expandPromptTemplates: false }),
		);
	});

	test("a dialog that displaces the list mid-edit releases the held message unchanged", () => {
		const { host, press, session, displace, texts } = fixture([{ text: "held" }]);
		showQueueManager(host);
		press(KEY.enter, "x");
		displace();
		expect(session.releaseQueuedInput).toHaveBeenCalledWith("q1", undefined);
		expect(texts()).toEqual(["held"]);
	});

	test("refreshes on queue changes: delivered rows vanish and the list closes when empty", () => {
		const { host, session, list, sync } = fixture([{ text: "a" }, { text: "b" }]);
		showQueueManager(host, "last");
		session.deliverNext();
		sync();
		expect(list()?.render(80).join("\n")).toContain("1 next turn");
		expect(list()?.selectedIndex).toBe(0);
		session.deliverNext();
		sync();
		expect(list()).toBeUndefined();
	});

	test("compaction-queue messages: toggle, and an edit returns to the same slot while compaction runs", () => {
		const { host, ui, press, session } = fixture(
			[],
			[
				{ text: "one", mode: "steer" },
				{ text: "two", mode: "steer" },
			],
		);
		session.isCompacting = true;
		showQueueManager(host);
		press("e");
		expect(ui.uiStore.getState().queue.compaction.map((m) => m.text)).toEqual(["two"]);
		press("1", KEY.enter);
		expect(ui.uiStore.getState().queue.compaction.map((m) => m.text)).toEqual(["one1", "two"]);
		press("s");
		expect(ui.uiStore.getState().queue.compaction).toEqual([
			{ text: "two", mode: "steer" },
			{ text: "one1", mode: "followUp" },
		]);
	});

	test("the pending-area hint names Up", () => {
		const { ui, sync } = fixture([{ text: "a" }]);
		sync();
		const lines = ui.pendingMessagesContainer.render(80).map((line) => line.replace(/\x1b\[[0-9;]*m/g, ""));
		expect(lines.join("\n")).toContain("↑ to manage · alt+up restores the last · Esc restores all");
	});
});

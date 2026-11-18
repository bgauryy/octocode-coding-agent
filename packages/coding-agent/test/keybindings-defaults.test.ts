import { afterEach, describe, expect, it, vi } from "vitest";

/**
 * Actions that react to keys while the main editor has focus: editor editing, input, application-wide shortcuts,
 * Octocode's permission cycle and fullscreen viewport navigation. Picker, tree, ask, backlog and transcript-search actions
 * run only while their own component has focus, so they may reuse these keys.
 */
const EDITOR_CONTEXT_PREFIXES = ["tui.editor.", "tui.input."];
const EDITOR_CONTEXT_ACTIONS = [
	"app.permission.cycle",
	"app.interrupt",
	"app.clear",
	"app.exit",
	"app.suspend",
	"app.thinking.cycle",
	"app.thinking.toggle",
	"app.model.cycleForward",
	"app.model.cycleBackward",
	"app.model.select",
	"app.tools.expand",
	"app.editor.external",
	"app.message.copy",
	"app.message.followUp",
	"app.message.dequeue",
	"app.clipboard.pasteImage",
	"app.session.new",
	"app.session.tree",
	"app.session.fork",
	"app.session.resume",
	"tui.altScreen.pageUp",
	"tui.altScreen.pageDown",
	"tui.altScreen.halfPageUp",
	"tui.altScreen.halfPageDown",
	"tui.altScreen.lineUp",
	"tui.altScreen.lineDown",
	"tui.altScreen.previousPrompt",
	"tui.altScreen.nextPrompt",
	"tui.altScreen.search",
	"tui.altScreen.top",
	"tui.altScreen.bottom",
];

/**
 * Deliberate layering, where one action handles the key only in a state the other does not:
 * copy acts on a selection and clear otherwise; exit acts only on an empty editor; fullscreen viewport actions shadow
 * editor actions on the same key (documented in docs/keybindings.md), which on Windows and WSL includes `ctrl+f`
 * search over the Emacs-style cursor-right alias.
 */
const LAYERED = new Set([
	"ctrl+c: app.clear, tui.input.copy",
	"ctrl+d: app.exit, tui.editor.deleteCharForward",
	"ctrl+f: tui.altScreen.search, tui.editor.cursorRight",
	"pageDown: tui.altScreen.pageDown, tui.editor.pageDown",
	"pageUp: tui.altScreen.pageUp, tui.editor.pageUp",
]);

const MODIFIERS = ["ctrl", "shift", "alt", "super"];

/** `shift+ctrl+p` and `ctrl+shift+p` are the same key. */
function canonicalKey(key: string): string {
	const parts = key.split("+");
	const base = parts.pop() ?? "";
	const modifiers = parts.sort((a, b) => MODIFIERS.indexOf(a) - MODIFIERS.indexOf(b));
	return [...modifiers, base].join("+");
}

const inEditorContext = (action: string): boolean =>
	EDITOR_CONTEXT_ACTIONS.includes(action) || EDITOR_CONTEXT_PREFIXES.some((prefix) => action.startsWith(prefix));

/** Actions a focused list (picker, page, autocomplete menu) takes: its own keys, never the editor's. */
const inListContext = (action: string): boolean => action.startsWith("tui.select.");

async function collisions(
	platform: NodeJS.Platform,
	env: Record<string, string | undefined>,
	inContext: (action: string) => boolean,
): Promise<string[]> {
	const original = Object.getOwnPropertyDescriptor(process, "platform");
	Object.defineProperty(process, "platform", { value: platform });
	for (const [name, value] of Object.entries(env)) vi.stubEnv(name, value);
	try {
		vi.resetModules();
		const { KEYBINDINGS } = await import("../src/core/keybindings.ts");
		const owners = new Map<string, string[]>();
		for (const [action, definition] of Object.entries(KEYBINDINGS)) {
			if (!inContext(action)) continue;
			const keys: readonly string[] = Array.isArray(definition.defaultKeys)
				? definition.defaultKeys
				: [definition.defaultKeys];
			for (const key of new Set(keys.map(canonicalKey))) owners.set(key, [...(owners.get(key) ?? []), action]);
		}
		return [...owners]
			.filter(([, actions]) => actions.length > 1)
			.map(([key, actions]) => `${key}: ${actions.sort().join(", ")}`)
			.filter((collision) => !LAYERED.has(collision))
			.sort();
	} finally {
		if (original) Object.defineProperty(process, "platform", original);
		vi.unstubAllEnvs();
		vi.resetModules();
	}
}

describe("default keybindings", () => {
	afterEach(() => {
		vi.unstubAllEnvs();
	});

	it.each([
		["macOS", "darwin", {}],
		["Linux", "linux", { WSL_DISTRO_NAME: undefined, WSL_INTEROP: undefined }],
		["WSL", "linux", { WSL_DISTRO_NAME: "Ubuntu" }],
		["Windows", "win32", {}],
	] as const)("gives no two editor actions the same key on %s", async (_name, platform, env) => {
		expect(await collisions(platform, env, inEditorContext)).toEqual([]);
	});

	it.each([
		["macOS", "darwin", {}],
		["Linux", "linux", { WSL_DISTRO_NAME: undefined, WSL_INTEROP: undefined }],
		["WSL", "linux", { WSL_DISTRO_NAME: "Ubuntu" }],
		["Windows", "win32", {}],
	] as const)("gives no two list actions the same key on %s", async (_name, platform, env) => {
		expect(await collisions(platform, env, inListContext)).toEqual([]);
	});

	it("jumps a list to its first and last item with home and end", async () => {
		const { KEYBINDINGS } = await import("../src/core/keybindings.ts");
		expect(KEYBINDINGS["tui.select.home"].defaultKeys).toBe("home");
		expect(KEYBINDINGS["tui.select.end"].defaultKeys).toBe("end");
	});

	it.each([
		["macOS", "darwin", {}, "shift+ctrl+t"],
		["Linux", "linux", { WSL_DISTRO_NAME: undefined, WSL_INTEROP: undefined }, "shift+ctrl+t"],
		["WSL", "linux", { WSL_DISTRO_NAME: "Ubuntu" }, "alt+t"],
		["Windows", "win32", {}, "alt+t"],
	] as const)(
		"cycles thinking with %s's modified key, never a plain shift+letter",
		async (_name, platform, env, expected) => {
			const original = Object.getOwnPropertyDescriptor(process, "platform");
			Object.defineProperty(process, "platform", { value: platform });
			for (const [name, value] of Object.entries(env)) vi.stubEnv(name, value);
			try {
				vi.resetModules();
				const { KEYBINDINGS } = await import("../src/core/keybindings.ts");
				expect(KEYBINDINGS["app.thinking.cycle"].defaultKeys).toBe(expected);
			} finally {
				if (original) Object.defineProperty(process, "platform", original);
				vi.resetModules();
			}
		},
	);

	it("keeps shift+tab for the permission cycle and gives the thinking cycle its own key", async () => {
		const { KEYBINDINGS } = await import("../src/core/keybindings.ts");
		expect(KEYBINDINGS["app.permission.cycle"].defaultKeys).toBe("shift+tab");
		const thinking: readonly string[] = [KEYBINDINGS["app.thinking.cycle"].defaultKeys].flat();
		expect(thinking).not.toContain("shift+tab");
	});
});

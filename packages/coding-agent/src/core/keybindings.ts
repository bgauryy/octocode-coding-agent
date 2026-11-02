import {
	type KeybindingDefinitions,
	type KeybindingsConfig,
	type KeyId,
	TUI_KEYBINDINGS,
	KeybindingsManager as TuiKeybindingsManager,
} from "@octocodeai/octocode-tui";
import { existsSync } from "fs";
import { Compile } from "typebox/compile";
import { getAgentDir } from "../config.ts";
import { configDiscovery, discoveryInput } from "./discovery/service.ts";
import { KeybindingValueSchema } from "./key-id-schema.ts";
import { readJsonFile } from "../../../common/src/json.ts";

export function useWindowsKeybindings(
	platform: NodeJS.Platform = process.platform,
	env: NodeJS.ProcessEnv = process.env,
): boolean {
	return platform === "win32" || (platform === "linux" && Boolean(env.WSL_DISTRO_NAME || env.WSL_INTEROP));
}

const windowsKeybindings = useWindowsKeybindings();

const APP_KEYBINDINGS = {
	"app.permission.cycle": { defaultKeys: "shift+tab", description: "Cycle permission mode" },
	"app.ask.next": { defaultKeys: ["tab", "right"], description: "Next question" },
	"app.ask.previous": { defaultKeys: ["shift+tab", "left"], description: "Previous question" },
	"app.ask.toggle": { defaultKeys: "space", description: "Toggle answer selection" },
	"app.backlog.previousState": { defaultKeys: "left", description: "Move item to previous state" },
	"app.backlog.nextState": { defaultKeys: "right", description: "Move item to next state" },
	"app.backlog.add": { defaultKeys: "a", description: "Add backlog item" },
	"app.backlog.do": { defaultKeys: "d", description: "Work on backlog item" },
	"app.backlog.export": { defaultKeys: "e", description: "Export backlog" },
	"app.backlog.html": { defaultKeys: "h", description: "Open backlog as HTML" },
	"app.backlog.close": { defaultKeys: "q", description: "Close backlog" },
	"app.interrupt": { defaultKeys: "escape", description: "Cancel or abort" },
	"app.clear": { defaultKeys: "ctrl+c", description: "Clear editor" },
	"app.exit": { defaultKeys: "ctrl+d", description: "Exit when editor is empty" },
	"app.suspend": {
		defaultKeys: process.platform === "win32" ? [] : "ctrl+z",
		description: "Suspend to background",
	},
	// shift+tab belongs to app.permission.cycle, which the native editor handles before editor actions. Plain shift+t
	// is indistinguishable from typing "T" in legacy terminals, so the modifier pair mirrors app.model.cycleBackward.
	"app.thinking.cycle": {
		defaultKeys: windowsKeybindings ? "alt+t" : "shift+ctrl+t",
		description: "Cycle thinking level",
	},
	"app.thinking.save": {
		defaultKeys: "ctrl+s",
		description: "Save thinking level",
	},
	"app.model.cycleForward": {
		defaultKeys: "ctrl+p",
		description: "Cycle to next model",
	},
	"app.model.cycleBackward": {
		defaultKeys: windowsKeybindings ? "alt+p" : "shift+ctrl+p",
		description: "Cycle to previous model",
	},
	"app.model.select": { defaultKeys: "ctrl+l", description: "Open model selector" },
	"app.tools.expand": { defaultKeys: "ctrl+o", description: "Toggle tool output" },
	"app.thinking.toggle": {
		defaultKeys: "ctrl+t",
		description: "Toggle thinking blocks",
	},
	"app.session.toggleNamedFilter": {
		defaultKeys: "ctrl+n",
		description: "Toggle named session filter",
	},
	"app.editor.external": {
		defaultKeys: "ctrl+g",
		description: "Open external editor",
	},
	"app.message.copy": {
		defaultKeys: "ctrl+x",
		description: "Copy selection or last assistant message",
	},
	"app.message.followUp": {
		defaultKeys: windowsKeybindings ? "ctrl+q" : "alt+enter",
		description: "Queue follow-up message",
	},
	"app.message.dequeue": {
		defaultKeys: windowsKeybindings ? "alt+q" : "alt+up",
		description: "Restore the last queued message",
	},
	"app.clipboard.pasteImage": {
		defaultKeys: windowsKeybindings ? "alt+v" : "ctrl+v",
		description: "Paste files on macOS, images, or text from clipboard",
	},
	"app.session.new": { defaultKeys: [], description: "Start a new session" },
	"app.session.tree": { defaultKeys: [], description: "Open session tree" },
	"app.session.fork": { defaultKeys: [], description: "Fork current session" },
	"app.session.resume": { defaultKeys: [], description: "Resume a session" },
	"app.tree.foldOrUp": {
		defaultKeys: process.platform === "darwin" ? ["alt+left", "ctrl+left"] : ["ctrl+left", "alt+left"],
		description: "Fold tree branch or move up",
	},
	"app.tree.unfoldOrDown": {
		defaultKeys: process.platform === "darwin" ? ["alt+right", "ctrl+right"] : ["ctrl+right", "alt+right"],
		description: "Unfold tree branch or move down",
	},
	"app.tree.editLabel": {
		defaultKeys: "shift+l",
		description: "Edit tree label",
	},
	"app.tree.toggleLabelTimestamp": {
		defaultKeys: "shift+t",
		description: "Toggle tree label timestamps",
	},
	"app.session.togglePath": {
		defaultKeys: "ctrl+p",
		description: "Toggle session path display",
	},
	"app.session.toggleSort": {
		defaultKeys: "ctrl+s",
		description: "Toggle session sort mode",
	},
	"app.session.rename": {
		defaultKeys: "ctrl+r",
		description: "Rename session",
	},
	"app.session.delete": {
		defaultKeys: "ctrl+d",
		description: "Delete session",
	},
	"app.session.actions": {
		defaultKeys: "ctrl+o",
		description: "Open session actions",
	},
	"app.session.deleteNoninvasive": {
		defaultKeys: "ctrl+backspace",
		description: "Delete session when query is empty",
	},
	"app.models.save": {
		defaultKeys: "ctrl+s",
		description: "Save model selection",
	},
	"app.models.enableAll": {
		defaultKeys: "ctrl+a",
		description: "Enable all models",
	},
	"app.models.clearAll": {
		defaultKeys: "ctrl+x",
		description: "Clear all models",
	},
	"app.models.toggleProvider": {
		defaultKeys: "ctrl+p",
		description: "Toggle all models for provider",
	},
	"app.models.reorderUp": {
		defaultKeys: "alt+up",
		description: "Move model up in order",
	},
	"app.models.reorderDown": {
		defaultKeys: "alt+down",
		description: "Move model down in order",
	},
	"app.tree.filter.default": {
		defaultKeys: "ctrl+d",
		description: "Tree filter: default view",
	},
	"app.tree.filter.noTools": {
		defaultKeys: "ctrl+t",
		description: "Tree filter: hide tool results",
	},
	"app.tree.filter.userOnly": {
		defaultKeys: "ctrl+u",
		description: "Tree filter: user messages only",
	},
	"app.tree.filter.labeledOnly": {
		defaultKeys: "ctrl+l",
		description: "Tree filter: labeled entries only",
	},
	"app.tree.filter.all": {
		defaultKeys: "ctrl+a",
		description: "Tree filter: show all entries",
	},
	"app.tree.filter.cycleForward": {
		defaultKeys: "ctrl+o",
		description: "Tree filter: cycle forward",
	},
	"app.tree.filter.cycleBackward": {
		defaultKeys: "shift+ctrl+o",
		description: "Tree filter: cycle backward",
	},
} as const satisfies KeybindingDefinitions;

export type AppKeybinding = keyof typeof APP_KEYBINDINGS;
type AppKeybindings = { [K in AppKeybinding]: true };

declare module "@octocodeai/octocode-tui" {
	interface Keybindings extends AppKeybindings {}
}

export const KEYBINDINGS = {
	...TUI_KEYBINDINGS,
	"tui.editor.undo": {
		...TUI_KEYBINDINGS["tui.editor.undo"],
		defaultKeys: process.platform === "win32" ? "ctrl+z" : windowsKeybindings ? "alt+z" : "ctrl+-",
	},
	"tui.altScreen.previousPrompt": {
		...TUI_KEYBINDINGS["tui.altScreen.previousPrompt"],
		defaultKeys: windowsKeybindings ? "ctrl+up" : ["ctrl+shift+up", "ctrl+up"],
	},
	"tui.altScreen.nextPrompt": {
		...TUI_KEYBINDINGS["tui.altScreen.nextPrompt"],
		defaultKeys: windowsKeybindings ? "ctrl+down" : ["ctrl+shift+down", "ctrl+down"],
	},
	"tui.altScreen.search": {
		...TUI_KEYBINDINGS["tui.altScreen.search"],
		defaultKeys: windowsKeybindings ? "ctrl+f" : "ctrl+shift+f",
	},
	...APP_KEYBINDINGS,
} as const satisfies KeybindingDefinitions;

const validateKeybindingValue = Compile(KeybindingValueSchema);

function toKeybindingsConfig(value: Record<string, unknown>): KeybindingsConfig {
	const config: KeybindingsConfig = {};
	for (const [key, binding] of Object.entries(value)) {
		if (key === "$schema") continue;
		if (validateKeybindingValue.Check(binding)) config[key] = binding;
	}
	return config;
}

function loadRawConfig(path: string): Record<string, unknown> | undefined {
	if (!existsSync(path)) return undefined;
	try {
		const parsed = readJsonFile(path) as unknown;
		if (typeof parsed !== "object" || parsed === null) return undefined;
		return parsed as Record<string, unknown>;
	} catch {
		return undefined;
	}
}

export class KeybindingsManager extends TuiKeybindingsManager {
	private readBindings: (() => KeybindingsConfig) | undefined;

	constructor(userBindings: KeybindingsConfig = {}, readBindings?: () => KeybindingsConfig) {
		super(KEYBINDINGS, userBindings);
		this.readBindings = readBindings;
	}

	/** User bindings from Octocode's `keybindings.json`, over Pi's (`~/.pi/agent`) action by action. */
	static create(agentDir: string = getAgentDir()): KeybindingsManager {
		const read = () => KeybindingsManager.loadUserBindings(agentDir);
		return new KeybindingsManager(read(), read);
	}

	reload(): void {
		if (this.readBindings) this.setUserBindings(this.readBindings());
	}

	getEffectiveConfig(): KeybindingsConfig {
		return this.getResolvedBindings();
	}

	private static loadUserBindings(agentDir: string): KeybindingsConfig {
		const files = configDiscovery.discover(
			"keybinding",
			discoveryInput({ cwd: process.cwd(), agentDir, projectTrusted: false }),
		);
		// Discovery lists Octocode's file first; later files override earlier ones.
		return files.reduceRight<KeybindingsConfig>((merged, item) => {
			const rawConfig = loadRawConfig(item.provenance.path);
			return rawConfig ? { ...merged, ...toKeybindingsConfig(rawConfig) } : merged;
		}, {});
	}
}

export type { KeyId, KeybindingsConfig };

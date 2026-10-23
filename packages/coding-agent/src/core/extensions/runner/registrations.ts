/** Queries over loaded extensions' registrations: tools, flags, handlers, renderers, shortcuts and commands. */

import type { KeyId } from "@octocodeai/octocode-tui";
import type { KeybindingsConfig } from "../../keybindings.ts";
import { NATIVE_FEATURE_PATH } from "../../native-tools.ts";
import { BUILTIN_SLASH_COMMANDS } from "../../slash-commands.ts";
import type {
	EntryRenderer,
	Extension,
	ExtensionFlag,
	ExtensionShortcut,
	MessageRenderer,
	RegisteredCommand,
	RegisteredTool,
	ResolvedCommand,
} from "../types.ts";

// Extension shortcuts compete with canonical keybinding ids from keybindings.json.
// Only editor-global shortcuts are reserved here. Picker-specific bindings are not.
const RESERVED_KEYBINDINGS_FOR_EXTENSION_CONFLICTS = [
	"app.interrupt",
	"app.clear",
	"app.exit",
	"app.suspend",
	"app.thinking.cycle",
	"app.model.cycleForward",
	"app.model.cycleBackward",
	"app.model.select",
	"app.tools.expand",
	"app.thinking.toggle",
	"app.editor.external",
	"app.message.copy",
	"app.message.followUp",
	"tui.input.submit",
	"tui.select.confirm",
	"tui.select.cancel",
	"tui.input.copy",
	"tui.editor.deleteToLineEnd",
] as const;

type BuiltInKeyBindings = Partial<Record<KeyId, { keybinding: string; restrictOverride: boolean }>>;

const buildBuiltinKeybindings = (resolvedKeybindings: KeybindingsConfig): BuiltInKeyBindings => {
	const builtinKeybindings = {} as BuiltInKeyBindings;
	for (const [keybinding, keys] of Object.entries(resolvedKeybindings)) {
		if (keys === undefined) continue;
		const keyList = Array.isArray(keys) ? keys : [keys];
		const restrictOverride = (RESERVED_KEYBINDINGS_FOR_EXTENSION_CONFLICTS as readonly string[]).includes(keybinding);
		for (const key of keyList) {
			const normalizedKey = key.toLowerCase() as KeyId;
			// If multiple actions bind the same key, the reserved action wins so extensions
			// remain blocked by reserved shortcuts regardless of iteration order.
			const existing = builtinKeybindings[normalizedKey];
			if (existing?.restrictOverride && !restrictOverride) continue;
			builtinKeybindings[normalizedKey] = {
				keybinding,
				restrictOverride,
			};
		}
	}
	return builtinKeybindings;
};

/** Extension shortcuts by normalized key; `addDiagnostic` receives each conflict with a built-in or another extension. */
export function resolveShortcuts(
	extensions: Extension[],
	resolvedKeybindings: KeybindingsConfig,
	addDiagnostic: (message: string, extensionPath: string) => void,
): Map<KeyId, ExtensionShortcut> {
	const builtinKeybindings = buildBuiltinKeybindings(resolvedKeybindings);
	const extensionShortcuts = new Map<KeyId, ExtensionShortcut>();

	for (const ext of extensions) {
		for (const [key, shortcut] of ext.shortcuts) {
			const normalizedKey = key.toLowerCase() as KeyId;

			const builtInKeybinding = builtinKeybindings[normalizedKey];
			if (builtInKeybinding?.restrictOverride === true) {
				addDiagnostic(
					`Extension shortcut '${key}' from ${shortcut.extensionPath} conflicts with built-in shortcut. Skipping.`,
					shortcut.extensionPath,
				);
				continue;
			}

			if (builtInKeybinding?.restrictOverride === false) {
				addDiagnostic(
					`Extension shortcut conflict: '${key}' is built-in shortcut for ${builtInKeybinding.keybinding} and ${shortcut.extensionPath}. Using ${shortcut.extensionPath}.`,
					shortcut.extensionPath,
				);
			}

			const existingExtensionShortcut = extensionShortcuts.get(normalizedKey);
			if (existingExtensionShortcut) {
				addDiagnostic(
					`Extension shortcut conflict: '${key}' registered by both ${existingExtensionShortcut.extensionPath} and ${shortcut.extensionPath}. Using ${shortcut.extensionPath}.`,
					shortcut.extensionPath,
				);
			}
			extensionShortcuts.set(normalizedKey, shortcut);
		}
	}
	return extensionShortcuts;
}

export function resolveRegisteredCommands(extensions: Extension[]): ResolvedCommand[] {
	const commands: RegisteredCommand[] = [];
	const counts = new Map<string, number>();

	for (const ext of extensions) {
		for (const command of ext.commands.values()) {
			commands.push(command);
			counts.set(command.name, (counts.get(command.name) ?? 0) + 1);
		}
	}

	const seen = new Map<string, number>();
	const builtinNames = new Set(BUILTIN_SLASH_COMMANDS.flatMap((command) => [command.name, ...(command.aliases ?? [])]));
	const takenInvocationNames = new Set<string>(builtinNames);

	const resolved = commands.map((command) => {
		const occurrence = (seen.get(command.name) ?? 0) + 1;
		seen.set(command.name, occurrence);

		const nativeBuiltin = command.sourceInfo.path === NATIVE_FEATURE_PATH && builtinNames.has(command.name);
		let invocationName =
			!nativeBuiltin && ((counts.get(command.name) ?? 0) > 1 || builtinNames.has(command.name))
				? `${command.name}:${occurrence}`
				: command.name;

		if (!nativeBuiltin && takenInvocationNames.has(invocationName)) {
			let suffix = occurrence;
			do {
				suffix++;
				invocationName = `${command.name}:${suffix}`;
			} while (takenInvocationNames.has(invocationName));
		}

		takenInvocationNames.add(invocationName);
		return {
			...command,
			invocationName,
		};
	});
	const aliases = new Map<string, number>();
	for (const command of resolved) {
		for (const alias of command.aliases ?? []) aliases.set(alias, (aliases.get(alias) ?? 0) + 1);
	}
	const reserved = new Set([...takenInvocationNames, ...commands.map((command) => command.name)]);
	const occupied = new Set([...reserved, ...aliases.keys()]);
	return resolved.map((command) => ({
		...command,
		...(command.aliases
			? {
					aliases: command.aliases.map((alias) => {
						const nativeAlias =
							command.sourceInfo.path === NATIVE_FEATURE_PATH &&
							BUILTIN_SLASH_COMMANDS.some(
								(builtin) => builtin.name === command.name && builtin.aliases?.includes(alias),
							);
						if (nativeAlias) return alias;
						if (!reserved.has(alias) && aliases.get(alias) === 1) return alias;
						let suffix = 1;
						while (occupied.has(`${alias}:${suffix}`)) suffix++;
						const qualified = `${alias}:${suffix}`;
						occupied.add(qualified);
						return qualified;
					}),
				}
			: {}),
	}));
}

/** User registrations override native tools; the first user registration per name wins. */
export function collectRegisteredTools(extensions: Extension[]): RegisteredTool[] {
	const toolsByName = new Map<string, RegisteredTool>();
	for (const ext of extensions) {
		for (const tool of ext.tools.values()) {
			const existing = toolsByName.get(tool.definition.name);
			if (!existing || existing.sourceInfo.path === NATIVE_FEATURE_PATH) {
				toolsByName.set(tool.definition.name, tool);
			}
		}
	}
	return Array.from(toolsByName.values());
}

/** Registered flags by name; the first registration per name wins. */
export function collectFlags(extensions: Extension[]): Map<string, ExtensionFlag> {
	const allFlags = new Map<string, ExtensionFlag>();
	for (const ext of extensions) {
		for (const [name, flag] of ext.flags) {
			if (!allFlags.has(name)) {
				allFlags.set(name, flag);
			}
		}
	}
	return allFlags;
}

export function hasEventHandlers(extensions: Extension[], eventType: string): boolean {
	for (const ext of extensions) {
		const handlers = ext.handlers.get(eventType);
		if (handlers && handlers.length > 0) {
			return true;
		}
	}
	return false;
}

export function findMessageRenderer(extensions: Extension[], customType: string): MessageRenderer | undefined {
	for (const ext of extensions) {
		const renderer = ext.messageRenderers.get(customType);
		if (renderer) {
			return renderer;
		}
	}
	return undefined;
}

export function findEntryRenderer(extensions: Extension[], customType: string): EntryRenderer | undefined {
	for (const ext of extensions) {
		const renderer = ext.entryRenderers?.get(customType);
		if (renderer) {
			return renderer;
		}
	}
	return undefined;
}

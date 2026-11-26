import type { ResourceDiagnostic } from "../../diagnostics.ts";
/** Queries over loaded features' registrations: tools, flags, handlers, renderers and commands. */

import { BUILTIN_SLASH_COMMANDS } from "../../slash-commands.ts";
import type {
	EntryRenderer,
	FeatureRecord,
	MessageRenderer,
	RegisteredCommand,
	RegisteredTool,
	ResolvedCommand,
} from "../types.ts";

/** Whether two lists hold the same items, by identity, in the same order. */
export function sameItems(a: readonly unknown[], b: readonly unknown[]): boolean {
	if (a.length !== b.length) return false;
	for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
	return true;
}

/**
 * Last resolution per features list. A feature may register a command after load (its `commands` map changes in
 * place), so the cache holds while the registered command objects are the same ones in the same order.
 */
const resolved = new WeakMap<FeatureRecord[], { registered: RegisteredCommand[]; commands: ResolvedCommand[] }>();

/** Commands with their invocation names; the same list (by identity) while no registration changed. */
export function resolveRegisteredCommands(features: FeatureRecord[]): ResolvedCommand[] {
	const registered = features.flatMap((ext) => [...ext.commands.values()]);
	const cached = resolved.get(features);
	if (cached && sameItems(cached.registered, registered)) return cached.commands;
	const commands = resolveCommands(registered);
	resolved.set(features, { registered, commands });
	return commands;
}

function resolveCommands(registered: readonly RegisteredCommand[]): ResolvedCommand[] {
	const commands: RegisteredCommand[] = [];
	const counts = new Map<string, number>();

	for (const command of registered) {
		commands.push(command);
		counts.set(command.name, (counts.get(command.name) ?? 0) + 1);
	}

	const seen = new Map<string, number>();
	const builtinNames = new Set(BUILTIN_SLASH_COMMANDS.map((command) => command.name));
	const takenInvocationNames = new Set<string>(builtinNames);

	return commands.map((command) => {
		const occurrence = (seen.get(command.name) ?? 0) + 1;
		seen.set(command.name, occurrence);

		const nativeBuiltin = command.sourceInfo.owner === "native";
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
		return { ...command, invocationName };
	});
}

/** User registrations override native tools; the first user registration per name wins. */
export function collectRegisteredTools(features: FeatureRecord[]): RegisteredTool[] {
	const toolsByName = new Map<string, RegisteredTool>();
	for (const ext of features) {
		for (const tool of ext.tools.values()) {
			const existing = toolsByName.get(tool.definition.name);
			if (!existing || existing.sourceInfo.owner === "native") {
				toolsByName.set(tool.definition.name, tool);
			}
		}
	}
	return Array.from(toolsByName.values());
}

export function findMessageRenderer(features: FeatureRecord[], customType: string): MessageRenderer | undefined {
	for (const ext of features) {
		const renderer = ext.messageRenderers.get(customType);
		if (renderer) {
			return renderer;
		}
	}
	return undefined;
}

export function findEntryRenderer(features: FeatureRecord[], customType: string): EntryRenderer | undefined {
	for (const ext of features) {
		const renderer = ext.entryRenderers?.get(customType);
		if (renderer) {
			return renderer;
		}
	}
	return undefined;
}

export function commandResolutionDiagnostics(commands: ResolvedCommand[]): ResourceDiagnostic[] {
	return commands
		.filter((command) => command.name !== command.invocationName)
		.map((command) => ({
			type: "warning" as const,
			path: command.sourceInfo.path,
			message: `Command /${command.name} conflicts with another command; available as /${command.invocationName}.`,
		}));
}

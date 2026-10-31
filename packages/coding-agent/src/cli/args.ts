/**
 * CLI argument parsing and help display
 */

import type { ThinkingLevel } from "@octocodeai/octocode-agent-core";
import type { TuiMode } from "../core/settings-manager.ts";
import { isValidThinkingLevel } from "../core/thinking-level.ts";
import { flagSpec, invalidValue, looksLikeFlag, missingValue } from "./args/flags.ts";

export { printHelp } from "./args/help.ts";
export { isValidThinkingLevel };

export type Mode = "text" | "json" | "rpc" | "acp";

export interface Args {
	provider?: string;
	model?: string;
	apiKey?: string;
	systemPrompt?: string;
	appendSystemPrompt?: string[];
	thinking?: ThinkingLevel;
	continue?: boolean;
	resume?: boolean;
	help?: boolean;
	version?: boolean;
	mode?: Mode;
	name?: string;
	noSession?: boolean;
	session?: string;
	sessionId?: string;
	fork?: string;
	sessionDir?: string;
	/** Name of the worktree to start in (`--worktree`). */
	worktree?: string;
	models?: string[];
	tools?: string[];
	excludeTools?: string[];
	noTools?: boolean;
	noBuiltinTools?: boolean;
	extensions?: string[];
	noExtensions?: boolean;
	noMcp?: boolean;
	print?: boolean;
	export?: string;
	noSkills?: boolean;
	skills?: string[];
	promptTemplates?: string[];
	noPromptTemplates?: boolean;
	themes?: string[];
	useTheme?: string;
	noThemes?: boolean;
	noContextFiles?: boolean;
	listModels?: string | true;
	offline?: boolean;
	tuiMode?: TuiMode;
	verbose?: boolean;
	projectTrustOverride?: boolean;
	messages: string[];
	fileArgs: string[];
	/** Unknown flags (potentially extension flags) - map of flag name to value */
	unknownFlags: Map<string, boolean | string>;
	/** Words unknown flags consumed as values, returned to `messages` if the flag is boolean. */
	unknownFlagWords?: Array<{ flag: string; word: string; at: number }>;
	diagnostics: Array<{ type: "warning" | "error"; message: string }>;
}

export function normalizeSessionName(value: string): string | undefined {
	const name = value.trim();
	return name.length > 0 ? name : undefined;
}

export function parseArgs(args: string[]): Args {
	const result: Args = {
		messages: [],
		fileArgs: [],
		unknownFlags: new Map(),
		unknownFlagWords: [],
		diagnostics: [],
	};
	const error = (message: string) => result.diagnostics.push({ type: "error", message });

	for (let i = 0; i < args.length; i++) {
		const arg = args[i];

		if (arg === "--") {
			for (const positionalArg of args.slice(i + 1)) {
				if (positionalArg.startsWith("@")) result.fileArgs.push(positionalArg.slice(1));
				else result.messages.push(positionalArg);
			}
			break;
		}
		if (arg.startsWith("@")) {
			result.fileArgs.push(arg.slice(1));
			continue;
		}
		// `--flag=value` works for every flag that takes a value.
		const eq = arg.startsWith("--") ? arg.indexOf("=") : -1;
		const spec = flagSpec(eq === -1 ? arg : arg.slice(0, eq));
		if (spec) {
			const inline = eq === -1 ? undefined : arg.slice(eq + 1);
			if (spec.kind === "boolean") {
				if (inline !== undefined) error(`${spec.name} does not take a value`);
				else spec.apply(result, undefined);
				continue;
			}
			if (spec.kind === "optional") {
				const next = inline ?? args[i + 1];
				// `-p` takes a message unless the next word is an option or file; `---` text still reads as a message.
				const takes =
					inline !== undefined ||
					(next !== undefined && !next.startsWith("@") && (!next.startsWith("-") || next.startsWith("---")));
				if (inline === undefined && takes) i++;
				if (spec.name === "--print") {
					spec.apply(result, undefined);
					if (takes && next !== undefined) result.messages.push(next);
				} else spec.apply(result, takes ? next : undefined);
				continue;
			}
			const value = inline ?? args[i + 1];
			if (value === undefined || (inline === undefined && looksLikeFlag(value))) {
				error(missingValue(spec));
				continue;
			}
			if (inline === undefined) i++;
			const invalid = invalidValue(spec, value);
			if (invalid) {
				error(invalid);
				continue;
			}
			const failure = spec.apply(result, value);
			if (failure) error(`${eq === -1 ? arg : arg.slice(0, eq)}: ${failure}`);
			continue;
		}
		if (arg.startsWith("--")) {
			// An extension flag: its type is known only once extensions load (see restoreBooleanFlagWords).
			if (eq !== -1) {
				result.unknownFlags.set(arg.slice(2, eq), arg.slice(eq + 1));
				continue;
			}
			const flagName = arg.slice(2);
			const next = args[i + 1];
			if (next !== undefined && !next.startsWith("-") && !next.startsWith("@")) {
				result.unknownFlags.set(flagName, next);
				result.unknownFlagWords!.push({ flag: flagName, word: next, at: result.messages.length });
				i++;
			} else {
				result.unknownFlags.set(flagName, true);
			}
			continue;
		}
		if (arg.startsWith("-") && arg.length > 1) {
			error(`Unknown option: ${arg}`);
			continue;
		}
		result.messages.push(arg);
	}

	return result;
}

/**
 * An unknown `--flag word` is read as a flag with a value, because extension flags are typed only once extensions
 * load. A flag that turns out boolean gives its word back to the prompt, at the position it was typed.
 */
export function restoreBooleanFlagWords(args: Args, isBoolean: (name: string) => boolean): void {
	let shift = 0;
	for (const { flag, word, at } of args.unknownFlagWords ?? []) {
		if (!isBoolean(flag)) continue;
		args.messages.splice(at + shift, 0, word);
		args.unknownFlags.set(flag, true);
		shift++;
	}
	args.unknownFlagWords = [];
}

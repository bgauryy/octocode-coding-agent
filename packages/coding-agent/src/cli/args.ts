/**
 * CLI argument parsing and help display
 */

import { APP_NAME } from "../config.ts";
import { isValidThinkingLevel } from "../core/thinking-level.ts";
import { flagSpec, invalidValue, looksLikeFlag, missingValue } from "./args/flags.ts";
import type { Args } from "./args/types.ts";

export { printHelp } from "./args/help.ts";
export type { Args, Mode } from "./args/types.ts";
export { isValidThinkingLevel };

export function normalizeSessionName(value: string): string | undefined {
	const name = value.trim();
	return name.length > 0 ? name : undefined;
}

export function parseArgs(args: string[]): Args {
	const result: Args = {
		messages: [],
		fileArgs: [],
		unknownFlags: [],
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
				const failure = inline === undefined ? spec.apply(result, undefined) : `does not take a value`;
				if (failure) error(`${spec.name} ${failure}`);
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
			const name = eq === -1 ? arg.slice(2) : arg.slice(2, eq);
			result.unknownFlags.push(name);
			error(`Unknown option: --${name}. Run "${APP_NAME} --help" to see the options.`);
			continue;
		}
		if (arg.startsWith("-") && arg.length > 1) {
			error(`Unknown option: ${arg}. Run "${APP_NAME} --help" to see the options.`);
			continue;
		}
		result.messages.push(arg);
	}

	return result;
}

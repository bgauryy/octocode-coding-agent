import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { NO_NEXT_STEP, nextStepEntries, nextStepFor } from "../../src/core/command-next-steps.ts";
import { BUILTIN_SLASH_COMMANDS } from "../../src/core/slash-commands.ts";
import { registeredCommands } from "./completion-driver.ts";

// `/mcp` is registered by the MCP package, which the native composition does not start.
const OUTSIDE_NATIVE = ["mcp"];

let registered: Awaited<ReturnType<typeof registeredCommands>>;
let names: Set<string>;
beforeAll(async () => {
	registered = await registeredCommands();
	names = new Set([
		...BUILTIN_SLASH_COMMANDS.map((command) => command.name),
		...registered.commands.keys(),
		...OUTSIDE_NATIVE,
	]);
});
afterAll(() => registered?.dispose());

describe("next-step hints for native feature commands", () => {
	it("gives every registered native command a hint or a stated reason for none", () => {
		const native = [...registered.commands.keys(), ...OUTSIDE_NATIVE];
		expect(native.length).toBeGreaterThan(20);
		expect(native.filter((name) => !nextStepFor(name) && !NO_NEXT_STEP[name])).toEqual([]);
	});

	it("keys every hint and exception by a command that exists", () => {
		const keys = [...nextStepEntries().map(([key]) => key), ...Object.keys(NO_NEXT_STEP)];
		expect(keys.filter((key) => !names.has(key.split(" ")[0]))).toEqual([]);
	});

	it("points each hint at a command that exists", () => {
		// The entry itself, not `nextStepFor`: a bare page opener (`permissions`) shows its entry only with arguments.
		const broken = nextStepEntries().flatMap(([key, [command]]) => {
			const target = /^\/(\S+)/.exec(command)?.[1];
			return target && names.has(target) ? [] : [`${key} -> ${target}`];
		});
		expect(broken).toEqual([]);
	});
});

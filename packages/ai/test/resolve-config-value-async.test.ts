import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import {
	clearConfigValueCache,
	resolveConfigValue,
	resolveConfigValueAsync,
	resolveConfigValueUncached,
} from "../src/utils/resolve-config-value.ts";

let dir: string;
beforeEach(() => {
	dir = join(tmpdir(), `octocode-config-async-${Date.now()}-${Math.random().toString(36).slice(2)}`);
	mkdirSync(dir, { recursive: true });
	clearConfigValueCache();
});
afterEach(() => {
	rmSync(dir, { recursive: true, force: true });
	clearConfigValueCache();
});

/** A fake credential command that appends a line per run to a file and prints `output` (a shell expression). */
function counted(name: string, output = "echo fake-secret", pause = "") {
	const file = join(dir, name);
	writeFileSync(file, "");
	const quoted = file.replace(/"/g, '\\"');
	return {
		command: `!sh -c '${pause}echo run >> "${quoted}"; ${output}'`,
		runs: () => readFileSync(file, "utf8").split("\n").filter(Boolean).length,
	};
}

describe("resolveConfigValueAsync", () => {
	test("resolves every kind of value as resolveConfigValue does", async () => {
		process.env.TEST_ASYNC_VALUE = "from-env";
		try {
			const configs = [
				"literal",
				"$TEST_ASYNC_VALUE",
				"${TEST_ASYNC_VALUE}-$MISSING_ASYNC_VALUE",
				"$$escaped",
				"!echo '  spaced  '",
				"!printf 'a\\nb'",
				"!exit 1",
				"!printf ''",
				"!nonexistent-command-12345",
				// More than execSync's default 1 MiB of output fails the command on both paths.
				"!head -c 1100000 /dev/zero | tr '\\0' 'x'",
				"!head -c 1000 /dev/zero | tr '\\0' 'y'",
			];
			for (const config of configs) {
				const today = resolveConfigValueUncached(config);
				clearConfigValueCache();
				expect(await resolveConfigValueAsync(config), config).toEqual(today);
				clearConfigValueCache();
				expect(resolveConfigValue(config), config).toEqual(today);
			}
		} finally {
			delete process.env.TEST_ASYNC_VALUE;
		}
	});

	test("does not block the thread while the command runs", async () => {
		const { command } = counted("slow", "echo slow-secret", "sleep 0.4; ");
		const start = performance.now();
		const pending = resolveConfigValueAsync(command);
		const returnedAfter = performance.now() - start;
		let ticked = false;
		setTimeout(() => (ticked = true), 20);
		const value = await pending;
		expect(returnedAfter).toBeLessThan(100);
		expect(ticked).toBe(true);
		expect(value).toBe("slow-secret");
	});

	test("shares the cache with resolveConfigValue and one run between concurrent reads", async () => {
		const { command, runs } = counted("shared");
		const [first, second] = await Promise.all([resolveConfigValueAsync(command), resolveConfigValueAsync(command)]);
		expect([first, second]).toEqual(["fake-secret", "fake-secret"]);
		expect(resolveConfigValue(command)).toBe("fake-secret");
		expect(await resolveConfigValueAsync(command)).toBe("fake-secret");
		expect(runs()).toBe(1);
	});

	test("never caches a failure", async () => {
		const { command, runs } = counted("failing", "exit 1");
		expect(await resolveConfigValueAsync(command)).toBeUndefined();
		expect(await resolveConfigValueAsync(command)).toBeUndefined();
		expect(resolveConfigValue(command)).toBeUndefined();
		expect(runs()).toBe(3);
	});

	test("a run that started before clearConfigValueCache does not cache what it read", async () => {
		const { command, runs } = counted("rotated", "echo old-secret", "sleep 0.2; ");
		const before = resolveConfigValueAsync(command);
		// A sign-in stores a new secret and clears the cache while the old read is still running.
		clearConfigValueCache();
		expect(await before).toBe("old-secret");
		expect(await resolveConfigValueAsync(command)).toBe("old-secret");
		expect(runs()).toBe(2);
	});

	test("keeps the process alive while a caller awaits the command", () => {
		const source = resolve(import.meta.dirname, "../src/utils/resolve-config-value.ts");
		const script = `const { resolveConfigValueAsync } = await import(${JSON.stringify(source)});
			process.stdout.write(String(await resolveConfigValueAsync("!sleep 0.2; printf fake-awaited")));`;
		const output = execFileSync(process.execPath, ["--input-type=module", "-e", script], { encoding: "utf8" });
		expect(output).toBe("fake-awaited");
	});
});

import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { runProvidersCommand } from "../src/cli/providers-command.ts";
import { stripAnsi } from "../src/utils/ansi.ts";
import { createSandbox, type Sandbox, write } from "./discovery/fixtures.ts";

let sandbox: Sandbox;
beforeEach(() => {
	sandbox = createSandbox();
});
afterEach(() => {
	vi.restoreAllMocks();
	sandbox.cleanup();
});

function capture() {
	const log = vi.spyOn(console, "log").mockImplementation(() => {});
	const error = vi.spyOn(console, "error").mockImplementation(() => {});
	const text = (spy: typeof log) => stripAnsi(spy.mock.calls.map((call) => String(call[0])).join("\n"));
	return { stdout: () => text(log), stderr: () => text(error) };
}

const run = (args: string[]) => runProvidersCommand(args, { cwd: sandbox.cwd });

describe("octocode providers", () => {
	it("prints usage with status 0 for no arguments, help and --help", async () => {
		for (const args of [[], ["help"], ["--help"], ["list", "-h"]]) {
			const out = capture();
			expect(await run(args)).toBe(0);
			expect(out.stdout()).toContain("providers list [--json]");
			vi.restoreAllMocks();
		}
	});

	it("rejects an unknown command or option with status 1 and usage on stderr", async () => {
		let out = capture();
		expect(await run(["frobnicate"])).toBe(1);
		expect(out.stderr()).toContain('Unknown providers command "frobnicate".');
		expect(out.stderr()).toContain("Usage:");
		vi.restoreAllMocks();
		out = capture();
		expect(await run(["list", "--yaml"])).toBe(1);
		expect(out.stderr()).toContain("Unknown option --yaml.");
		expect(out.stdout()).toBe("");
	});

	it("lists providers as JSON with their source and the definition each replaced", async () => {
		const provider = (baseUrl: string) =>
			JSON.stringify({
				providers: { dup: { baseUrl, api: "openai-completions", apiKey: "k", models: [{ id: "m1" }] } },
			});
		const own = write(join(sandbox.agentDir, "models.json"), provider("http://octocode.test/v1"));
		write(join(sandbox.piAgentDir, "models.json"), provider("http://pi.test/v1"));
		const out = capture();
		expect(await run(["list", "--json"])).toBe(0);
		const { providers } = JSON.parse(out.stdout()) as {
			providers: Array<{ id: string; source: unknown; shadowedBy?: string }>;
		};
		expect(providers.find((row) => row.id === "openai")?.source).toBe("built-in");
		const rows = providers.filter((row) => row.id === "dup");
		expect(rows).toHaveLength(2);
		expect(rows[0]).toMatchObject({ source: { file: own, scope: "global", product: "Octocode" } });
		expect(rows[0].shadowedBy).toBeUndefined();
		expect(rows[1]).toMatchObject({ source: { product: "Pi" }, shadowedBy: own });
		expect(out.stdout()).not.toContain("\n");
	});

	it("prints a table without --json", async () => {
		const out = capture();
		expect(await run(["list"])).toBe(0);
		expect(out.stdout()).toMatch(/^openai\s+built-in/m);
	});
});

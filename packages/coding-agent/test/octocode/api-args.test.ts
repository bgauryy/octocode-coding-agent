import fs from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import { integerFlag, parseArgs, pickInstance } from "../../src/octocode/api/args.ts";
import { WAIT_MS } from "../../src/octocode/api/protocol.ts";
import { registerApi } from "../../src/octocode/api/register.ts";
import { apiDir, type InstanceRecord } from "../../src/octocode/api/registry.ts";
import { Subcommands } from "../../src/octocode/shared/commands.ts";
import { fakeCtx, fakeHost } from "./fake-host.ts";
import { tmp } from "./helpers.ts";

const instance = (id: string, cwd = "/w"): InstanceRecord => ({ id, pid: 1, cwd, startedAt: 1, protocol: 1 });

describe("octocode-api arguments", () => {
	it("reads value flags, boolean flags and words", () => {
		const { flags, words } = parseArgs(["--to", "pi-1", "fix", "--wait", "the", "--mode", "steer", "tests"]);
		expect(Object.fromEntries(flags)).toEqual({ to: "pi-1", wait: true, mode: "steer" });
		expect(words).toEqual(["fix", "the", "tests"]);
	});

	it("refuses a value flag with no value instead of falling back to a default instance", () => {
		expect(() => parseArgs(["--to"])).toThrow("--to needs a value.");
		expect(() => parseArgs(["hello", "--from"])).toThrow("--from needs a value.");
		// The next flag is not a value.
		expect(() => parseArgs(["--to", "--wait"])).toThrow("--to needs a value.");
	});

	it("preserves every argument after -- as message text", () => {
		const { flags, words } = parseArgs(["--require-idle", "--", "--to", "other-agent", "--wait"], "send");
		expect(Object.fromEntries(flags)).toEqual({ "require-idle": true });
		expect(words).toEqual(["--to", "other-agent", "--wait"]);
	});

	it("rejects unknown, duplicate and command-inappropriate flags", () => {
		expect(() => parseArgs(["--sesion", "s1"], "send")).toThrow("Unknown flag --sesion");
		expect(() => parseArgs(["--wait"], "status")).toThrow("--wait is not valid for status");
		expect(() => parseArgs(["--to", "first", "--to", "second"], "send")).toThrow("--to was supplied more than once");
	});

	it("validates decimal integer flag values against the shared protocol bounds", () => {
		for (const value of [String(WAIT_MS.min), String(WAIT_MS.max)]) {
			expect(integerFlag(parseArgs(["--timeout", value]).flags, "timeout", WAIT_MS)).toBe(Number(value));
		}
		for (const value of [
			"",
			"NaN",
			"Infinity",
			"1.5",
			"1e3",
			"0x1000",
			String(WAIT_MS.min - 1),
			String(WAIT_MS.max + 1),
		]) {
			expect(() => integerFlag(parseArgs(["--timeout", value]).flags, "timeout", WAIT_MS)).toThrow();
		}
		expect(integerFlag(parseArgs([]).flags, "timeout", WAIT_MS)).toBeUndefined();
	});

	it("picks the named instance, else the only one, else the one in this directory", () => {
		const both = [instance("a", "/x"), instance("b", "/y")];
		expect(pickInstance(both, "b", "/x").id).toBe("b");
		expect(pickInstance([instance("a")], undefined, "/elsewhere").id).toBe("a");
		expect(pickInstance(both, undefined, "/y").id).toBe("b");
		expect(() => pickInstance(both, undefined, "/z")).toThrow("No running instance matches");
		expect(() => pickInstance([instance("a"), instance("b")], undefined, "/w")).toThrow(
			"Several instances match; pass --to <id>: a, b",
		);
	});

	it("treats an empty --to as a name, not as no name", () => {
		expect(() => pickInstance([instance("a")], "", "/w")).toThrow("No running instance matches");
	});
});

describe("API start failure without a UI", () => {
	afterEach(() => vi.unstubAllEnvs());

	it("says why the API is off on stderr, where a headless run can read it", async () => {
		vi.stubEnv("OCTOCODE_HOME", tmp("octo-api-headless-"));
		vi.stubEnv("OCTOCODE_API", "1");
		vi.stubEnv("OCTOCODE_API_HTTP", "abc");
		fs.mkdirSync(apiDir(), { recursive: true });
		const { api } = fakeHost();
		const wired = registerApi(
			api,
			new Subcommands(),
			{ list: () => [], tell: () => ({ sent: [] }), deliverable: (text) => text },
			() => "1.2.3",
		);
		const stderr = vi.spyOn(process.stderr, "write").mockReturnValue(true);
		try {
			const headless = fakeCtx({ cwd: tmp(), hasUI: false });
			await wired.start(headless);
			expect(stderr).toHaveBeenCalledWith(expect.stringContaining("OCTOCODE_API_HTTP=abc is not a port"));
			expect(headless.ui.notes).toEqual([]);
			stderr.mockClear();
			const ui = fakeCtx({ cwd: tmp() });
			await wired.start(ui);
			expect(stderr).not.toHaveBeenCalled();
			expect(ui.ui.notes.at(-1)).toMatchObject({ type: "warning" });
		} finally {
			stderr.mockRestore();
			await wired.stop();
		}
	});
});

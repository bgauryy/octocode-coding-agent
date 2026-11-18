import { afterEach, describe, expect, it, vi } from "vitest";
import type * as Resolve from "../../src/octocode/cli/resolve.ts";
import { asSetup } from "./fake-host.ts";

const resolved = vi.hoisted(() => ({ cli: { bin: "/fake/octocode.js", version: "0.0.0" } as unknown }));
vi.mock("../../src/octocode/cli/resolve.ts", async (importOriginal) => ({
	...(await importOriginal<typeof Resolve>()),
	resolveOctocodeCli: () => resolved.cli,
}));

const captureCli = vi.hoisted(() => vi.fn());
vi.mock("../../src/octocode/cli/run.ts", async (importOriginal) => ({
	...(await importOriginal<object>()),
	captureCli,
}));

const { GITHUB_LOGIN_NOTICE, githubLoginMissing } = await import("../../src/octocode/cli/login-check.ts");
const { registerOctocodeCli } = await import("../../src/octocode/cli/command.ts");
const { Subcommands } = await import("../../src/octocode/shared/commands.ts");

/** A CLI that answers `auth status --json` with `status`; one without `--json` rejects it as invalid input (exit 2). */
function cli(
	status: { code: number | null; stdout: string } | "hang" | "fail",
	options: { json?: boolean; plain?: { code: number | null; stdout: string } } = {},
) {
	return vi.fn((argv: string[], signal: AbortSignal) => {
		if (options.json === false && argv.includes("--json")) return Promise.resolve({ code: 2, stdout: "" });
		if (!argv.includes("--json") && options.plain) return Promise.resolve(options.plain);
		if (status === "fail") return Promise.reject(new Error("spawn ENOENT"));
		if (status === "hang")
			return new Promise<{ code: number | null; stdout: string }>((resolve) =>
				signal.addEventListener("abort", () => resolve({ code: null, stdout: "" })),
			);
		return Promise.resolve(status);
	});
}

const check = (run: ReturnType<typeof cli>, timeoutMs = 1000) =>
	githubLoginMissing(new AbortController().signal, { cwd: process.cwd(), timeoutMs, run });

afterEach(() => {
	resolved.cli = { bin: "/fake/octocode.js", version: "0.0.0" };
});

describe("GitHub sign-in check", () => {
	it("reports a missing sign-in from exit code 4 or `authenticated: false`, in one `--json` run", async () => {
		const byCode = cli({ code: 4, stdout: "" });
		expect(await check(byCode)).toBe(true);
		expect(byCode.mock.calls.map(([argv]) => argv)).toEqual([["auth", "status", "--json"]]);
		const byJson = cli({ code: 0, stdout: '{"authenticated":false}' });
		expect(await check(byJson)).toBe(true);
		expect(byJson).toHaveBeenCalledOnce();
	});

	it("asks a CLI without `--json` plainly once it rejects the option, judging by the exit code alone", async () => {
		const old = cli({ code: 0, stdout: "" }, { json: false, plain: { code: 4, stdout: "Not signed in" } });
		expect(await check(old)).toBe(true);
		expect(old.mock.calls.map(([argv]) => argv)).toEqual([
			["auth", "status", "--json"],
			["auth", "status"],
		]);
		const signedIn = cli({ code: 0, stdout: "" }, { json: false, plain: { code: 0, stdout: "Signed in as u" } });
		expect(await check(signedIn)).toBe(false);
		expect(signedIn).toHaveBeenCalledTimes(2);
	});

	it("is silent when signed in, when the CLI is missing, fails, times out or prints something else", async () => {
		expect(await check(cli({ code: 0, stdout: '{"authenticated":true,"username":"u"}' }))).toBe(false);
		expect(await check(cli({ code: 0, stdout: "not json" }))).toBe(false);
		expect(await check(cli("fail"))).toBe(false);
		const hang = cli("hang");
		expect(await check(hang, 20)).toBe(false);
		resolved.cli = undefined;
		const missing = cli({ code: 4, stdout: "" });
		expect(await check(missing)).toBe(false);
		expect(missing).not.toHaveBeenCalled();
	});

	it("stops when the session ends", async () => {
		const session = new AbortController();
		const running = githubLoginMissing(session.signal, { cwd: process.cwd(), timeoutMs: 60_000, run: cli("hang") });
		session.abort();
		expect(await running).toBe(false);
	});
});

describe("GitHub sign-in notice", () => {
	/** The extension API's event hooks, run as a session would. */
	function host() {
		const handlers = new Map<string, Array<(event: unknown, ctx: unknown) => Promise<void>>>();
		const api = asSetup({
			on: (event: string, handler: (event: unknown, ctx: unknown) => Promise<void>) =>
				handlers.set(event, [...(handlers.get(event) ?? []), handler]),
		});
		const notify = vi.fn();
		const ctx = { hasUI: true, cwd: process.cwd(), ui: { notify } };
		const emit = async (event: string) => {
			for (const handler of handlers.get(event) ?? []) await handler({}, ctx);
		};
		return { api, notify, emit };
	}

	it("shows one notice per run when not signed in, none when the CLI is missing", async () => {
		captureCli.mockImplementation(async () => ({
			output: "",
			stdout: '{"authenticated":false}',
			code: 4,
			truncated: false,
			cancelled: false,
		}));
		const { api, notify, emit } = host();
		registerOctocodeCli(api, new Subcommands());
		await emit("session_start");
		await vi.waitFor(() => expect(notify).toHaveBeenCalledWith(GITHUB_LOGIN_NOTICE, "warning"));
		// One CLI run per start: no `--help` probe before it.
		expect(captureCli.mock.calls.map(([, argv]) => argv)).toEqual([["auth", "status", "--json"]]);
		await emit("session_start");
		await new Promise((resolve) => setTimeout(resolve, 20));
		expect(notify).toHaveBeenCalledOnce();

		resolved.cli = undefined;
		const other = host();
		registerOctocodeCli(other.api, new Subcommands());
		await other.emit("session_start");
		await new Promise((resolve) => setTimeout(resolve, 20));
		expect(other.notify).not.toHaveBeenCalled();
	});
});

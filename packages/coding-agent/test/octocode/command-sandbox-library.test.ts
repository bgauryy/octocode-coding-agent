import { createResolvedAddressGuard } from "@octocodeai/octocode-sandbox-runtime/dist/sandbox/resolved-address-guard.js";
import { PERMISSION_ENV } from "@octocodeai/octocode-common/env";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { Permission } from "../../src/octocode/permission/ask.ts";
import { ALLOW_ONCE } from "../../src/octocode/permission/ask/text.ts";
import type { PermissionMode } from "../../src/octocode/permission/mode.ts";
import { sandboxPrompts } from "../../src/octocode/permission/sandbox/prompts.ts";
import { type HostAnswer, type SandboxPrompts, SrtCommandSandbox } from "../../src/octocode/permission/sandbox/srt.ts";
import { commandDenials, type ViolationStore } from "../../src/octocode/permission/sandbox/violations.ts";
import { fakeCtx, fakeHost } from "./fake-host.ts";
import { tmp } from "./helpers.ts";

/**
 * The adapter against a fake sandbox library, so what Octocode does with the library's answers runs on every host: its
 * dependency warnings (S3: Linux without the seccomp helper lets a command reach any Unix socket), the private ranges a
 * hostname may not resolve into when the proxy connects (S10, DNS rebinding) and the pins a host allowed as private
 * gets, and stopping the library when the session ends (a print run would otherwise never exit).
 */
const fake = vi.hoisted(() => {
	type Ask = (target: { host: string; port: number | undefined }) => Promise<unknown>;
	type Config = { network: Record<string, unknown> & { allowedDomains: string[] } };
	const state = {
		warnings: [] as string[],
		starts: [] as Array<{ config: Config; ask: Ask }>,
		config: undefined as Config | undefined,
		resets: 0,
	};
	const store = {
		getViolationsForCommand: () => [],
		subscribe: (listener: (violations: unknown[]) => void) => (listener([]), () => undefined),
		getCount: () => 0,
		getTotalCount: () => 0,
	};
	const SandboxManager = {
		checkDependencies: () => ({ errors: [], warnings: state.warnings }),
		initialize: async (config: Config, ask: Ask) => {
			state.config = config;
			state.starts.push({ config, ask });
		},
		getConfig: () => state.config,
		updateConfig: (next: Config) => {
			state.config = next;
		},
		wrapWithSandboxArgv: async (command: string, shell: string) => ({ argv: [shell, "-c", command], env: {} }),
		registerCommandNetworkLists: () => undefined,
		unregisterCommandNetworkLists: () => undefined,
		cleanupAfterCommand: () => undefined,
		getSandboxViolationStore: () => store,
		reset: async () => {
			state.resets += 1;
			state.config = undefined;
		},
	};
	return { state, module: { SandboxManager } };
});
vi.mock("@octocodeai/octocode-sandbox-runtime", () => fake.module);

const platform = Object.getOwnPropertyDescriptor(process, "platform")!;
// macOS's start path: Linux adds a real bubblewrap trial run, which this file does not exercise.
beforeAll(() => Object.defineProperty(process, "platform", { ...platform, value: "darwin" }));
afterAll(() => Object.defineProperty(process, "platform", platform));
/** Launches a test made, ended after it as their commands would end. */
const launches: Array<{ release(): void }> = [];
// Each test starts the library afresh, so it reads that test's warnings.
afterEach(async () => {
	for (const launch of launches.splice(0)) launch.release();
	await new SrtCommandSandbox(() => undefined).close();
	fake.state.warnings = [];
});

const SECCOMP = "seccomp not available - unix socket access not restricted";
const policy = (cwd: string) => ({ allowWrite: [cwd], denyWrite: [], denyRead: [] });
const request = (cwd = tmp()) => ({ shell: "/bin/sh", shellArgs: ["-c"], viaStdin: false, command: "true", cwd });
/** `sandbox.wrap` of one command, recorded in `launches`. */
async function wrap(sandbox: SrtCommandSandbox) {
	const launch = await sandbox.wrap(request());
	if (launch) launches.push(launch);
	return launch;
}

function prompts(overrides: Partial<SandboxPrompts> = {}): SandboxPrompts & { weakerAsks: string[][] } {
	const weakerAsks: string[][] = [];
	return {
		weakerAsks,
		host: async () => ({ allow: false, reason: "no" }),
		unavailable: async () => false,
		weaker: async (warnings) => (weakerAsks.push(warnings), true),
		...overrides,
	};
}

function session(
	mode: PermissionMode,
	selects: string[],
	lookup?: (name: string) => Promise<Array<{ address: string }>>,
) {
	const permission = new Permission({ api: fakeHost().api, env: { [PERMISSION_ENV]: mode }, isSubagent: false });
	const ctx = fakeCtx({ cwd: tmp(), hasUI: true, ui: { selects } });
	permission.start(ctx);
	const asked: string[] = [];
	const select = ctx.ui.select;
	ctx.ui.select = async (title: string, choices: string[]) => {
		asked.push(title.split("\n")[0] ?? "");
		return select(title, choices);
	};
	return { ctx, asked, prompts: sandboxPrompts(permission, ctx, lookup ? { lookup } : {}) };
}

describe("a sandbox the library warns is weaker than it should be", () => {
	it("asks once per session, then runs the session's commands in it", async () => {
		fake.state.warnings = [SECCOMP];
		const asks = prompts();
		const sandbox = new SrtCommandSandbox(policy, { prompts: asks });
		expect(await wrap(sandbox)).toBeDefined();
		expect(await wrap(sandbox)).toBeDefined();
		expect(asks.weakerAsks).toEqual([[SECCOMP]]);
	});

	it("refuses every command after a no, and without asking when sandbox.allowUnsandboxed is false or nothing can ask", async () => {
		fake.state.warnings = [SECCOMP];
		const asks = prompts({ weaker: async (warnings) => (asks.weakerAsks.push(warnings), false) });
		const sandbox = new SrtCommandSandbox(policy, { prompts: asks });
		await expect(sandbox.wrap(request())).rejects.toThrow(
			/weaker than it should be: seccomp not available.*not allowed for this session/,
		);
		await expect(sandbox.wrap(request())).rejects.toThrow(/not allowed for this session/);
		expect(asks.weakerAsks).toHaveLength(1);
		const strict = prompts();
		await expect(
			new SrtCommandSandbox(policy, { prompts: strict, allowsUnsandboxed: false }).wrap(request()),
		).rejects.toThrow(/seccomp not available.*sandbox.allowUnsandboxed is false/);
		expect(strict.weakerAsks).toEqual([]);
		await expect(new SrtCommandSandbox(policy).wrap(request())).rejects.toThrow(/fix what the warning names/);
	});

	it("starts without asking when the library warns of nothing", async () => {
		const asks = prompts();
		expect(await wrap(new SrtCommandSandbox(policy, { prompts: asks }))).toBeDefined();
		expect(asks.weakerAsks).toEqual([]);
	});

	it("is a warning and a shell.unsandboxed question in the session, which bypass allows unasked", async () => {
		const full = session("full", [ALLOW_ONCE]);
		expect(await full.prompts.weaker([SECCOMP])).toBe(true);
		expect(full.asked).toEqual(["Run this session's shell commands in the weaker sandbox?"]);
		expect(JSON.stringify(full.ctx.ui)).toContain(`The command sandbox is weaker than it should be: ${SECCOMP}`);
		const bypass = session("bypass", []);
		expect(await bypass.prompts.weaker([SECCOMP])).toBe(true);
		expect(bypass.asked).toEqual([]);
	});
});

describe("a hostname that resolves into the private network when the proxy connects", () => {
	const guard = (answer: string) =>
		createResolvedAddressGuard({
			...(fake.state.config?.network as object),
			resolve: (_name, _options, callback) =>
				callback(null, [{ address: answer, family: answer.includes(":") ? 6 : 4 }]),
		});
	const ask = (host: string, port: number) => fake.state.starts.at(-1)!.ask({ host, port });

	it("is refused unless it was allowed as private: an answer asked about as public cannot be re-pointed", async () => {
		await wrap(new SrtCommandSandbox(policy, { prompts: prompts() }));
		const denied = fake.state.starts.at(-1)!.config.network.deniedResolvedAddresses;
		expect(denied).toEqual(
			expect.arrayContaining(["10.0.0.0/8", "172.16.0.0/12", "192.168.0.0/16", "100.64.0.0/10", "fc00::/7"]),
		);
		expect(guard("10.0.0.5").permits("rebind.example", "10.0.0.5", 443)).toBe(false);
		expect(guard("fd12::5").permits("rebind.example", "fd12::5", 443)).toBe(false);
		expect(guard("93.184.215.14").permits("public.example", "93.184.215.14", 443)).toBe(true);
	});

	it("pins a host allowed as private to its private addresses at that port, for the session", async () => {
		const answer: HostAnswer = { allow: true, scope: "session", addresses: ["10.0.0.5", "93.184.215.14"] };
		const first = prompts({ host: async () => answer });
		await wrap(new SrtCommandSandbox(policy, { prompts: first }));
		expect(await ask("intranet.test", 8080)).toBe(true);
		expect(fake.state.config?.network.allowedDomains).toEqual(["10.0.0.5:8080"]);
		expect(guard("10.0.0.5").permits("intranet.test", "10.0.0.5", 8080)).toBe(true);
		expect(guard("10.0.0.5").permits("intranet.test", "10.0.0.5", 9090)).toBe(false);
		expect(guard("10.0.0.6").permits("rebind.example", "10.0.0.6", 8080)).toBe(false);
		// Another session's sandbox: the last session's pins no longer hold.
		new SrtCommandSandbox(policy, { prompts: prompts() });
		expect(fake.state.config?.network.allowedDomains).toEqual([]);
	});

	it("pins a host allowed once only while the commands running then run", async () => {
		const sandbox = new SrtCommandSandbox(policy, {
			prompts: prompts({ host: async () => ({ allow: true, scope: "once", addresses: ["fd12::7"] }) }),
		});
		const launch = await sandbox.wrap(request());
		expect(await ask("intranet.test", 443)).toBe(true);
		expect(fake.state.config?.network.allowedDomains).toEqual(["[fd12::7]:443"]);
		launch?.release();
		expect(fake.state.config?.network.allowedDomains).toEqual([]);
	});

	it("gets its addresses from the session's answer only when it was allowed as a private address by name", async () => {
		const resolveTo = (address: string) => async () => [{ address }];
		const target = (host: string) => ({ host, port: 8080, commands: ["curl"] });
		expect(await session("full", [], resolveTo("10.0.0.5")).prompts.host(target("intranet.test"))).toEqual({
			allow: true,
			scope: "once",
			addresses: ["10.0.0.5"],
		});
		expect(await session("full", [], resolveTo("93.184.215.14")).prompts.host(target("public.test"))).toEqual({
			allow: true,
			scope: "once",
		});
		expect(await session("full", [], resolveTo("10.0.0.5")).prompts.host(target("10.0.0.9"))).toEqual({
			allow: true,
			scope: "once",
		});
	});
});

describe("the library at the end of a session", () => {
	it("stops at once when nothing sandboxed runs, and starts again for the next command", async () => {
		const sandbox = new SrtCommandSandbox(policy, { prompts: prompts() });
		const launch = await sandbox.wrap(request());
		launch?.release();
		const { resets } = fake.state;
		const starts = fake.state.starts.length;
		await sandbox.close();
		expect(fake.state.resets).toBe(resets + 1);
		expect(await wrap(sandbox)).toBeDefined();
		expect(fake.state.starts).toHaveLength(starts + 1);
	});

	it("stops when the last sandboxed process ends, when one still runs at the end of the session", async () => {
		const sandbox = new SrtCommandSandbox(policy, { prompts: prompts() });
		const server = await sandbox.wrap(request());
		const { resets } = fake.state;
		await sandbox.close();
		expect(fake.state.resets).toBe(resets);
		server?.release();
		await vi.waitFor(() => expect(fake.state.resets).toBe(resets + 1));
	});
});

describe("a refusal note's denials", () => {
	function store(lines: string[], { count = lines.length, total = lines.length } = {}): ViolationStore {
		return {
			getViolationsForCommand: () => lines.map((line) => ({ line })),
			subscribe: (listener) => (listener([]), () => undefined),
			getCount: () => count,
			getTotalCount: () => total,
		};
	}
	const write = (index: number) => `bash(1) deny(1) file-write-create /x/${index}`;

	it("lists at most 20 lines, then how many more", async () => {
		const lines = Array.from({ length: 25 }, (_, index) => write(index));
		const noted = await commandDenials(store(lines), "id", { wait: false, since: 0 });
		expect(noted).toHaveLength(21);
		expect(noted.at(-1)).toBe("… and 5 more");
	});

	it("says when the store dropped reports from while the command ran", async () => {
		const dropped = store([write(1)], { count: 100, total: 160 });
		expect((await commandDenials(dropped, "id", { wait: false, since: 40 })).at(-1)).toMatch(
			/20 from while this command ran were dropped/,
		);
		expect(await commandDenials(dropped, "id", { wait: false, since: 60 })).toEqual([write(1)]);
		// Without a line or a suspected refusal there is no note to add it to.
		expect(await commandDenials(store([], { count: 100, total: 160 }), "id", { wait: false, since: 0 })).toEqual([]);
		expect(
			await commandDenials(store([], { count: 100, total: 160 }), "id", { wait: true, waitMs: 10, since: 0 }),
		).toEqual([expect.stringMatching(/60 from while this command ran were dropped/)]);
	});
});

import fs from "node:fs";
import path from "node:path";
import { fauxAssistantMessage } from "@octocodeai/octocode-ai";
import { afterAll, afterEach, describe, expect, it } from "vitest";
import { PERMISSION_ENV } from "@octocodeai/octocode-common/env";
import type { ToolCallEvent } from "../../src/core/features/index.ts";
import { Permission } from "../../src/octocode/permission/ask.ts";
import { ALLOW_ONCE, sessionOption } from "../../src/octocode/permission/ask/text.ts";
import { classify } from "../../src/octocode/permission/gate/classify.ts";
import type { PermissionMode } from "../../src/octocode/permission/mode.ts";
import { sandboxPrompts } from "../../src/octocode/permission/sandbox/prompts.ts";
import { SrtCommandSandbox } from "../../src/octocode/permission/sandbox/srt.ts";
import { commandDenials } from "../../src/octocode/permission/sandbox/violations.ts";
import { foregroundOperations } from "../../src/octocode/files/bash-run.ts";
import { type CommandSandbox, setCommandSandbox } from "../../src/utils/command-sandbox.ts";
import { getShellEnv, resolveBashShell, spawnShell } from "../../src/utils/shell.ts";
import { nativeCall } from "./e2e-calls.ts";
import { disposeSessions, headless, restoreEnv, say } from "./e2e-headless.ts";
import { fakeCtx, fakeHost } from "./fake-host.ts";
import { tmp } from "./helpers.ts";

/**
 * Violations and the unsandboxed escape (S5) through a real headless session in `full` mode: a refused write is named
 * in the result, `sandbox: false` asks (and a headless session has no one to ask, so it is refused as needing
 * approval), and `sandbox.allowUnsandboxed: false` refuses it without asking.
 */
const outsideDirs: string[] = [];

afterEach(() => {
	disposeSessions();
	setCommandSandbox(undefined);
	for (const dir of outsideDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});
afterAll(restoreEnv);

const writer = (target: string) => `node -e "require('fs').writeFileSync(process.argv[1],'1')" '${target}'`;

async function start(sandbox: object) {
	// Outside the workspace and outside the system temporary folders the policy opens.
	const outside = fs.mkdtempSync(path.join("/private/var/tmp", "octocode-e2e-sandbox-"));
	outsideDirs.push(outside);
	const session = await headless({
		env: { OCTOCODE_PERMISSION: "full" },
		setup: ({ root }) => {
			fs.mkdirSync(path.join(root, "agent"), { recursive: true });
			fs.writeFileSync(path.join(root, "agent", "settings.json"), JSON.stringify({ sandbox }));
		},
	});
	return { ...session, outside };
}

async function oneCall(run: Awaited<ReturnType<typeof start>>["run"], input: Record<string, unknown>) {
	const [, after] = await run("go", [
		() => fauxAssistantMessage([nativeCall("bash", input)], { stopReason: "toolUse" }),
		say("done"),
	]);
	return after[0]?.text ?? "";
}

function session(mode: PermissionMode, selects: string[]) {
	const cwd = tmp();
	const permission = new Permission({ api: fakeHost().api, env: { [PERMISSION_ENV]: mode }, isSubagent: false });
	const ctx = fakeCtx({ cwd, hasUI: true, ui: { selects } });
	permission.start(ctx);
	const asked: string[] = [];
	const select = ctx.ui.select;
	ctx.ui.select = async (title: string, choices: string[]) => {
		asked.push(title.split("\n")[0] ?? "");
		return select(title, choices);
	};
	return { cwd, ctx, permission, asked };
}

/** A store like srt's: `add` stores a line for a command and notifies the listeners. */
function fakeStore() {
	const events: { line: string; command: string }[] = [];
	const listeners = new Set<(violations: unknown[]) => void>();
	return {
		listeners,
		add(command: string, line: string) {
			events.push({ command, line });
			for (const listener of listeners) listener(events);
		},
		getViolationsForCommand: (command: string) => events.filter((event) => event.command === command),
		subscribe(listener: (violations: unknown[]) => void) {
			listeners.add(listener);
			listener(events);
			return () => listeners.delete(listener);
		},
	};
}

describe("waiting for a command's denials", () => {
	const write = "bash(1) deny(1) file-write-create /Users/x/file";

	it("ends as soon as a relevant line for the command arrives, and stops listening", async () => {
		const store = fakeStore();
		const started = Date.now();
		const lines = commandDenials(store, "id-a", { wait: true, waitMs: 5000 });
		store.add("id-b", write);
		store.add("id-a", "bash(1) deny(1) sysctl-read kern.osversion");
		setTimeout(() => store.add("id-a", write), 50);
		expect(await lines).toEqual([write]);
		expect(Date.now() - started).toBeLessThan(2000);
		expect(store.listeners.size).toBe(0);
	});

	it("returns a line already stored without waiting, and nothing after the bound when none arrives", async () => {
		const store = fakeStore();
		store.add("id-a", write);
		expect(await commandDenials(store, "id-a", { wait: true, waitMs: 5000 })).toEqual([write]);
		expect(await commandDenials(store, "id-c", { wait: true, waitMs: 50 })).toEqual([]);
		expect(store.listeners.size).toBe(0);
	});

	it("reads once, without listening, when nothing suggests a refusal", async () => {
		const store = fakeStore();
		const lines = commandDenials(store, "id-a", { wait: false });
		expect(store.listeners.size).toBe(0);
		store.add("id-a", write);
		expect(await lines).toEqual([]);
	});
});

describe("a failed sandboxed command's result", () => {
	/** A sandbox that runs the command as is and reports `lines` as its denials, recording each `wait` it was asked with. */
	function install(lines: string[]) {
		const waits: boolean[] = [];
		const sandbox: CommandSandbox = {
			allowsUnsandboxed: true,
			wrap: async ({ shell, shellArgs, command }) => ({
				file: shell,
				args: [...shellArgs, command],
				env: {},
				release: () => undefined,
				denials: async (wait) => (waits.push(wait), lines),
			}),
		};
		setCommandSandbox(sandbox);
		return waits;
	}
	async function exec(command: string) {
		let output = "";
		const { exitCode } = await foregroundOperations({}, () => undefined).exec(command, tmp(), {
			onData: (chunk) => (output += chunk),
			env: getShellEnv(),
		});
		return { exitCode, output };
	}

	it("says the sandbox may have refused it when the output shows a refusal and no denial arrived in time", async () => {
		const waits = install([]);
		const { exitCode, output } = await exec("echo 'touch: /x: Operation not permitted' >&2; exit 1");
		expect(exitCode).toBe(1);
		expect(waits).toEqual([true]);
		expect(output).toContain("may have been refused by the sandbox");
		expect(output).toContain("sandbox: false (asks the user)");
	});

	it("sees a refusal split across two output chunks", async () => {
		const waits = install([]);
		await exec("printf 'curl: (56) CONNECT tunnel failed, resp'; sleep 0.2; printf 'onse 403'; exit 56");
		expect(waits).toEqual([true]);
	});

	it("names the denials when they arrive", async () => {
		install(["bash(1) deny(1) file-write-create /x"]);
		const { output } = await exec("echo 'EPERM' >&2; exit 1");
		expect(output).toContain("The sandbox refused:\n  bash(1) deny(1) file-write-create /x");
		expect(output).not.toContain("may have been refused");
	});

	it("does not wait, and adds nothing, for a failure that shows no refusal; a success is not read at all", async () => {
		const waits = install([]);
		const failed = await exec("echo 'no such file' >&2; exit 3");
		expect(failed.exitCode).toBe(3);
		expect(failed.output).not.toContain("sandbox");
		expect(waits).toEqual([false]);
		await exec("echo 'Permission denied'");
		expect(waits).toEqual([false]);
	});
});

describe("sandbox: false asks shell.unsandboxed", () => {
	const call = (command: string, cwd: string) =>
		classify(
			{ toolName: "bash", toolCallId: command, input: { command, sandbox: false } } as unknown as ToolCallEvent,
			{ cwd },
		);

	it("asks in full mode, remembers only the exact command, and is not covered by allowing all shell commands", async () => {
		setCommandSandbox(new SrtCommandSandbox(() => undefined));
		const selects: string[] = [];
		const { cwd, ctx, permission, asked } = session("full", selects);
		const first = call("git pull", cwd);
		expect(first?.action).toBe("shell.unsandboxed");
		selects.push(sessionOption(first?.grant?.label ?? ""));
		expect((await permission.check(ctx, first!)).allowed).toBe(true);
		expect((await permission.check(ctx, call("git pull", cwd)!)).allowed).toBe(true);
		expect(asked).toHaveLength(1);
		expect((await permission.check(ctx, call("git pull --rebase", cwd)!)).allowed).toBe(false);
		expect(asked).toHaveLength(2);
	});

	it("runs unasked only in bypass, and is an ordinary shell call when no sandbox is installed", async () => {
		setCommandSandbox(new SrtCommandSandbox(() => undefined));
		const { cwd, ctx, permission, asked } = session("bypass", []);
		expect((await permission.check(ctx, call("make", cwd)!)).allowed).toBe(true);
		expect(asked).toEqual([]);
		setCommandSandbox(undefined);
		expect(call("make", cwd)?.action).toBe("shell");
	});
});

describe("a sandbox that cannot start", () => {
	const platform = Object.getOwnPropertyDescriptor(process, "platform")!;
	afterEach(() => Object.defineProperty(process, "platform", platform));
	const unsupported = () => Object.defineProperty(process, "platform", { ...platform, value: "aix" });
	const run = async (cwd: string) => {
		const child = await spawnShell(resolveBashShell(), "echo ran", { cwd, env: getShellEnv() });
		let output = "";
		child.stdout?.on("data", (chunk: Buffer) => (output += chunk));
		await new Promise((resolve) => child.once("close", resolve));
		return output.trim();
	};

	it("warns, then asks shell.unsandboxed once for the session", async () => {
		const { cwd, ctx, permission, asked } = session("full", [ALLOW_ONCE]);
		const prompts = sandboxPrompts(permission, ctx);
		setCommandSandbox(new SrtCommandSandbox(() => ({ allowWrite: [cwd], denyWrite: [], denyRead: [] }), { prompts }));
		unsupported();
		expect(await run(cwd)).toBe("ran");
		expect(await run(cwd)).toBe("ran");
		expect(asked).toEqual(["Run this session's shell commands without the sandbox?"]);
		expect(JSON.stringify(ctx.ui)).toContain("The command sandbox cannot start");
	});

	it("refuses every command after a no, and without asking when sandbox.allowUnsandboxed is false", async () => {
		let asks = 0;
		const prompts = {
			host: async () => ({ allow: false as const, reason: "" }),
			unavailable: async () => (asks++, false),
		};
		const policy = (cwd: string) => ({ allowWrite: [cwd], denyWrite: [], denyRead: [] });
		setCommandSandbox(new SrtCommandSandbox(policy, { prompts }));
		unsupported();
		await expect(run(tmp())).rejects.toThrow(/not allowed for this session/);
		await expect(run(tmp())).rejects.toThrow(/not allowed for this session/);
		expect(asks).toBe(1);
		setCommandSandbox(new SrtCommandSandbox(policy, { prompts, allowsUnsandboxed: false }));
		await expect(run(tmp())).rejects.toThrow(/sandbox.allowUnsandboxed is false/);
		expect(asks).toBe(1);
	});
});

describe.runIf(process.platform === "darwin")("bash with sandbox.mode on: violations and sandbox: false", () => {
	it("names the path of a refused write in the result", async () => {
		const { outside, run } = await start({ mode: "on" });
		// The first sandboxed command starts the library's log monitor, which takes a moment to see denials.
		await oneCall(run, { command: "sleep 1" });
		// A shell redirect: macOS reports every refusal of the shell's own writes, while a node process's reports go
		// missing for its first launches (seen with node 26), and the result then only says the sandbox may have refused it.
		const text = await oneCall(run, { command: `echo 1 > '${path.join(outside, "x")}'` });
		expect(text).toContain("The sandbox refused:");
		expect(text).toContain(path.join(fs.realpathSync(outside), "x"));
		expect(text).toContain("sandbox: false (asks the user)");
		expect(fs.existsSync(path.join(outside, "x"))).toBe(false);
	});

	it("asks before running a command with sandbox: false, even in full mode", async () => {
		const { outside, run } = await start({ mode: "on" });
		const text = await oneCall(run, { command: writer(path.join(outside, "x")), sandbox: false });
		expect(text).toContain("Not run, needs approval");
		expect(fs.existsSync(path.join(outside, "x"))).toBe(false);
	});

	it("refuses sandbox: false without asking when sandbox.allowUnsandboxed is false", async () => {
		const { outside, run } = await start({ mode: "on", allowUnsandboxed: false });
		const text = await oneCall(run, { command: writer(path.join(outside, "x")), sandbox: false });
		expect(text).toContain("sandbox.allowUnsandboxed setting is false");
		expect(text).not.toContain("needs approval");
		expect(fs.existsSync(path.join(outside, "x"))).toBe(false);
	});
});

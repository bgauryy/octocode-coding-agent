import { EventEmitter } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type * as ChildProcess from "node:child_process";
import type { ChildRun } from "../../src/octocode/subagents/process/run-phase.ts";
import type { RelayHost } from "../../src/octocode/subagents/relay.ts";
import { runChild } from "../../src/octocode/subagents/process/run-child.ts";
import { superviseChild } from "../../src/octocode/subagents/process/supervise.ts";

const mocks = vi.hoisted(() => ({
	spawn: vi.fn(),
	prepareTree: vi.fn(),
	stopTree: vi.fn(),
	leftBehind: vi.fn(),
	untrack: vi.fn(),
	resources: vi.fn(),
	removeResources: vi.fn(),
	nonce: vi.fn(),
}));

vi.mock("node:child_process", async (original) => ({
	...(await original<typeof ChildProcess>()),
	spawn: mocks.spawn,
}));
vi.mock("../../src/config.ts", async (original) => ({
	...(await original<Record<string, unknown>>()),
	getCliInvocation: () => ({ command: "fixture", prefix: [] }),
}));
vi.mock("../../src/utils/process-tree.ts", async (original) => ({
	...(await original<Record<string, unknown>>()),
	prepareTree: mocks.prepareTree,
	adoptTree: vi.fn(),
}));
vi.mock("../../src/utils/shell.ts", async (original) => ({
	...(await original<Record<string, unknown>>()),
	leadsProcessGroup: () => false,
	trackDetachedChildPid: vi.fn(),
	untrackDetachedChildPid: mocks.untrack,
}));
vi.mock("../../src/octocode/shared/process.ts", async (original) => ({
	...(await original<Record<string, unknown>>()),
	stopTree: mocks.stopTree,
}));
vi.mock("../../src/octocode/shared/shell-groups.ts", async (original) => ({
	...(await original<Record<string, unknown>>()),
	SHELL_GROUPS_FILE_ENV: "OCTOCODE_SHELL_GROUPS_FILE",
	stopShellGroups: () => Promise.resolve(),
}));
vi.mock("../../src/octocode/subagents/budget-history.ts", () => ({
	requestBudgetHistory: async () => ({ limit: 0, requests: 0 }),
}));
vi.mock("../../src/octocode/subagents/process/left-behind.ts", () => ({ leftBehind: mocks.leftBehind }));
vi.mock("../../src/octocode/subagents/process/env.ts", async (original) => ({
	...(await original<Record<string, unknown>>()),
	subagentProcessEnv: () => ({}),
	writeNonceFile: mocks.nonce,
}));
vi.mock("../../src/octocode/subagents/process/handoff-files.ts", () => ({
	prepareChildResourceFiles: mocks.resources,
	removeChildResourceFiles: mocks.removeResources,
}));

function gate<T>() {
	let resolve!: (value: T) => void;
	const promise = new Promise<T>((done) => {
		resolve = done;
	});
	return { promise, resolve };
}

class Child extends EventEmitter {
	pid = 424242;
	stdin = new PassThrough();
	stdout = new PassThrough();
	stderr = new PassThrough();
	commands: Array<Record<string, unknown>> = [];

	constructor() {
		super();
		this.stdin.on("data", (chunk: Buffer) => this.commands.push(JSON.parse(chunk.toString())));
	}

	event(event: Record<string, unknown>) {
		this.stdout.write(`${JSON.stringify(event)}\n`);
	}

	exit() {
		this.emit("exit", 0, null);
		this.emit("close", 0, null);
	}
}

let root: string;
let child: Child;
const prepared = {
	command: "fixture",
	prefix: [],
	history: { limit: 0, requests: 0 },
	nonce: "secret",
	nonceFile: undefined,
	rolePromptFile: undefined,
	resources: {},
};
const permission: RelayHost["permission"] = {
	allows: () => false,
	relayedAllow: vi.fn(),
	adopt: vi.fn(),
	relayNote: vi.fn(),
};

function run(extra: Partial<ChildRun> = {}): ChildRun {
	return {
		task: "report back",
		args: [],
		cwd: root,
		identity: { id: "admission-race", scratch: root },
		onProgress: vi.fn(),
		...extra,
	};
}

beforeEach(() => {
	vi.useFakeTimers();
	vi.resetAllMocks();
	root = fs.mkdtempSync(path.join(os.tmpdir(), "octocode-admission-race-"));
	child = new Child();
	mocks.spawn.mockReturnValue(child);
	mocks.prepareTree.mockResolvedValue(undefined);
	mocks.stopTree.mockResolvedValue(undefined);
	mocks.leftBehind.mockResolvedValue(false);
	mocks.resources.mockReturnValue({});
	mocks.nonce.mockReturnValue(path.join(root, "nonce"));
});

afterEach(() => {
	child.stdin.destroy();
	child.stdout.destroy();
	child.stderr.destroy();
	vi.useRealTimers();
	fs.rmSync(root, { recursive: true, force: true });
});

describe("subagent admission and teardown interleavings", () => {
	it("starts nothing when cancellation precedes process preparation", async () => {
		const controller = new AbortController();
		controller.abort();
		await expect(runChild(run({ signal: controller.signal }))).rejects.toThrow("Subagent cancelled");
		expect(mocks.prepareTree).not.toHaveBeenCalled();
		expect(mocks.spawn).not.toHaveBeenCalled();
	});

	it("starts nothing when cancellation wins asynchronous process preparation", async () => {
		const preparing = gate<void>();
		const entered = gate<void>();
		mocks.prepareTree.mockImplementation(() => {
			entered.resolve();
			return preparing.promise;
		});
		const controller = new AbortController();
		const work = runChild(run({ signal: controller.signal }));
		const rejected = expect(work).rejects.toThrow("Subagent cancelled");
		await entered.promise;
		controller.abort();
		preparing.resolve();
		await rejected;
		expect(mocks.resources).not.toHaveBeenCalled();
		expect(mocks.spawn).not.toHaveBeenCalled();
	});

	it("starts nothing when the final permission handoff cancels admission and releases its files", async () => {
		const controller = new AbortController();
		const release = vi.fn();
		mocks.spawn.mockImplementation(() => {
			queueMicrotask(() => child.exit());
			return child;
		});
		await expect(
			runChild(
				run({
					signal: controller.signal,
					host: {
						permission,
						vouch: () => {
							controller.abort();
							return release;
						},
					},
				}),
			),
		).rejects.toThrow("Subagent cancelled");
		expect(mocks.spawn).not.toHaveBeenCalled();
		expect(release).toHaveBeenCalledExactlyOnceWith();
		expect(mocks.removeResources).toHaveBeenCalledExactlyOnceWith({});
	});

	it("stops once when cancellation wins before the abort listener attaches", async () => {
		const controller = new AbortController();
		mocks.spawn.mockImplementation(() => {
			controller.abort();
			return child;
		});
		const work = superviseChild(run({ signal: controller.signal }), prepared);
		const rejected = expect(work).rejects.toThrow("Subagent cancelled");
		child.exit();
		await rejected;
		expect(mocks.stopTree).toHaveBeenCalledTimes(1);
		expect(child.commands).toEqual([]);
		expect(vi.getTimerCount()).toBe(0);
	});

	it("does not send an admitted task after the child exits while its pipes remain open", async () => {
		const ready = gate<void>();
		const output = vi.fn();
		const work = superviseChild(run({ ready: () => ready.promise, host: { permission, output } }), prepared);
		child.emit("exit", 0, null);
		ready.resolve();
		await vi.advanceTimersByTimeAsync(0);
		expect(child.commands).toEqual([]);
		expect(output).not.toHaveBeenCalled();
		child.emit("close", 0, null);
		await work;
		expect(vi.getTimerCount()).toBe(0);
	});

	it("waits for the single stop when completion races cancellation and keeps the completed report", async () => {
		const stopping = gate<void>();
		mocks.stopTree.mockReturnValue(stopping.promise);
		const controller = new AbortController();
		const settled = vi.fn();
		const work = superviseChild(run({ signal: controller.signal, settled }), prepared);
		const resolved = vi.fn();
		void work.then(resolved);
		child.event({ type: "agent_start" });
		child.event({
			type: "message_end",
			message: { role: "assistant", content: [{ type: "text", text: "done. Completed report" }], stopReason: "stop" },
		});
		controller.abort();
		child.event({ type: "agent_settled" });
		child.exit();
		await vi.advanceTimersByTimeAsync(0);
		expect(resolved).not.toHaveBeenCalled();
		expect(mocks.stopTree).toHaveBeenCalledTimes(1);
		stopping.resolve();
		await expect(work).resolves.toMatchObject({ text: "done. Completed report" });
		expect(settled).toHaveBeenCalledTimes(1);
		expect(resolved).toHaveBeenCalledTimes(1);
		expect(vi.getTimerCount()).toBe(0);
	});

	it("waits for late descendant inspection and its stop before releasing process ownership", async () => {
		const inspection = gate<boolean>();
		const stopping = gate<void>();
		mocks.leftBehind.mockReturnValue(inspection.promise);
		mocks.stopTree.mockReturnValue(stopping.promise);
		const ready = gate<void>();
		const output = vi.fn();
		const work = superviseChild(run({ ready: () => ready.promise, host: { permission, output } }), prepared);
		const resolved = vi.fn();
		void work.then(resolved);
		child.exit();
		inspection.resolve(true);
		await vi.advanceTimersByTimeAsync(0);
		expect(mocks.stopTree).toHaveBeenCalledTimes(1);
		expect(resolved).not.toHaveBeenCalled();
		expect(mocks.untrack).not.toHaveBeenCalled();
		stopping.resolve();
		await work;
		ready.resolve();
		await vi.advanceTimersByTimeAsync(0);
		expect(resolved).toHaveBeenCalledTimes(1);
		expect(mocks.untrack).toHaveBeenCalledExactlyOnceWith(child.pid);
		expect(child.commands).toEqual([]);
		expect(output).not.toHaveBeenCalled();
		expect(vi.getTimerCount()).toBe(0);
	});
});

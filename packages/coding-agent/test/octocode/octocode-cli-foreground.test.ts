import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type * as ChildProcess from "node:child_process";
import type { ExtensionCommandContext } from "../../src/core/features/index.ts";
import type * as Resolve from "../../src/octocode/cli/resolve.ts";
import { foregroundChildActive } from "../../src/utils/foreground-child.ts";

/** A child process the test drives: `finish` ends it as the CLI exiting would; `kill` ends it as a signal. */
class FakeChild extends EventEmitter {
	stdout = new PassThrough();
	stderr = new PassThrough();
	exitCode: number | null = null;
	signalCode: NodeJS.Signals | null = null;
	kill = vi.fn(() => {
		this.signalCode = "SIGTERM";
		this.end(null);
		return true;
	});
	end(code: number | null): void {
		if (code !== null) this.exitCode = code;
		this.stdout.end();
		this.stderr.end();
		this.emit("exit", code);
		this.emit("close", code);
	}
}

const children: FakeChild[] = [];
const spawnMock = vi.fn(() => {
	const child = new FakeChild();
	children.push(child);
	return child;
});

vi.mock("node:child_process", async (importOriginal) => ({
	...(await importOriginal<typeof ChildProcess>()),
	spawn: spawnMock,
}));
vi.mock("../../src/octocode/cli/resolve.ts", async (importOriginal) => ({
	...(await importOriginal<typeof Resolve>()),
	resolveOctocodeCli: () => ({ bin: "/fake/octocode.js", version: "0.0.0" }),
}));

const { octocodeCommand } = await import("../../src/octocode/cli/command.ts");

type Factory = (tui: unknown, theme: unknown, keys: unknown, done: (value: unknown) => void) => unknown;

/** A terminal UI whose `custom` builds the component, as interactive mode does; `slotTaken` resolves it at once, as when another dialog replaces it. */
function terminal(options: { slotTaken?: boolean } = {}) {
	const tui = { stop: vi.fn(), start: vi.fn(), requestRender: vi.fn() };
	const notify = vi.fn();
	const inputs: Array<(data: string) => { consume?: boolean } | undefined> = [];
	const custom = vi.fn(
		(factory: Factory) =>
			new Promise((resolve) => {
				factory(tui, {}, {}, resolve);
				if (options.slotTaken) resolve(undefined);
			}),
	);
	const ui = {
		notify,
		custom,
		setStatus: vi.fn(),
		onTerminalInput: (handler: (data: string) => { consume?: boolean } | undefined) => {
			inputs.push(handler);
			return () => inputs.splice(inputs.indexOf(handler), 1);
		},
	};
	const ctx = { hasUI: true, cwd: process.cwd(), ui } as unknown as ExtensionCommandContext;
	return { ctx, tui, notify, inputs };
}

const started = () => vi.waitFor(() => expect(children).toHaveLength(1));

/**
 * Makes this process own a terminal, as an interactive Octocode does: stdin and stdout are TTYs and stdin has a raw
 * mode. `press` sends a key, as the user returning to Octocode after the CLI exits.
 */
function ownTerminal() {
	const stdin = process.stdin as NodeJS.ReadStream & { isRaw: boolean };
	const saved = { inTTY: stdin.isTTY, outTTY: process.stdout.isTTY, setRawMode: stdin.setRawMode };
	const setRawMode = vi.fn(() => stdin);
	Object.assign(stdin, { isTTY: true, setRawMode });
	Object.assign(process.stdout, { isTTY: true });
	vi.spyOn(stdin, "resume").mockImplementation(() => stdin);
	vi.spyOn(stdin, "pause").mockImplementation(() => stdin);
	vi.spyOn(process.stdout, "write").mockImplementation(() => true);
	return {
		setRawMode,
		press: () => vi.waitFor(() => expect(stdin.emit("data", Buffer.from("x"))).toBe(true)),
		restore: () => {
			Object.assign(stdin, { isTTY: saved.inTTY, setRawMode: saved.setRawMode });
			Object.assign(process.stdout, { isTTY: saved.outTTY });
		},
	};
}

describe("/octocode on the terminal", () => {
	let tty: ReturnType<typeof ownTerminal>;
	beforeEach(() => {
		tty = ownTerminal();
	});
	afterEach(() => {
		tty.restore();
		children.length = 0;
		vi.restoreAllMocks();
	});

	it("runs the arguments exactly as typed on the inherited terminal, with no alias or subcommand table", async () => {
		const { ctx } = terminal();

		const running = octocodeCommand.handler(`auth login --json '{"a": 1}'`, ctx);
		await started();
		expect(spawnMock).toHaveBeenLastCalledWith(
			expect.any(String),
			["/fake/octocode.js", "auth", "login", "--json", '{"a": 1}'],
			expect.objectContaining({ stdio: "inherit" }),
		);
		children[0].end(0);
		await tty.press();
		await running;

		const bare = octocodeCommand.handler("", ctx);
		await vi.waitFor(() => expect(children).toHaveLength(2));
		expect(spawnMock).toHaveBeenLastCalledWith(expect.any(String), ["/fake/octocode.js"], expect.anything());
		children[1].end(0);
		await tty.press();
		await bare;
	});

	it("holds the terminal for the CLI, so its Ctrl+C is not a shutdown, and resumes the TUI after a key once it exits", async () => {
		const { ctx, tui, notify } = terminal();

		const running = octocodeCommand.handler("config", ctx);
		await started();
		expect(tui.stop).toHaveBeenCalledOnce();
		expect(foregroundChildActive()).toBe(true);

		children[0].end(0);
		await vi.waitFor(() => expect(tty.setRawMode).toHaveBeenCalledWith(true));
		expect(tui.start).not.toHaveBeenCalled();
		await tty.press();
		await running;

		expect(foregroundChildActive()).toBe(false);
		expect(tui.start).toHaveBeenCalledOnce();
		expect(tui.requestRender).toHaveBeenCalledWith(true);
		expect(notify).toHaveBeenCalledWith("octocode config exited with 0.", "info");
	});

	it("stops the CLI when the command is aborted, and resumes the TUI without waiting for a key", async () => {
		const abort = new AbortController();
		const { ctx, tui } = terminal();
		Object.assign(ctx, { signal: abort.signal });

		const running = octocodeCommand.handler("auth login", ctx);
		await started();
		abort.abort();
		await running;

		expect(children[0].kill).toHaveBeenCalledOnce();
		expect(tui.start).toHaveBeenCalledOnce();
		expect(foregroundChildActive()).toBe(false);
	});

	it("releases the terminal once when the CLI fails to start, even if close follows the error", async () => {
		vi.spyOn(process.stderr, "write").mockImplementation(() => true);
		const { ctx, tui } = terminal();

		const running = octocodeCommand.handler("config", ctx);
		await started();
		children[0].emit("error", new Error("spawn ENOENT"));
		children[0].emit("close", null);
		await tty.press();
		await running;

		expect(foregroundChildActive()).toBe(false);
		expect(tui.start).toHaveBeenCalledOnce();
	});

	it("reports the CLI's exit when another dialog takes the slot while it runs, and restores the TUI once", async () => {
		const { ctx, tui, notify } = terminal({ slotTaken: true });

		const running = octocodeCommand.handler("config", ctx);
		await started();
		await new Promise((resolve) => setTimeout(resolve, 20));
		expect(notify).not.toHaveBeenCalled();
		expect(tui.start).not.toHaveBeenCalled();

		children[0].end(3);
		await tty.press();
		await running;

		expect(notify).toHaveBeenCalledWith("octocode config exited with 3.", "warning");
		expect(tui.start).toHaveBeenCalledOnce();
	});
});

describe("/octocode capturing output", () => {
	afterEach(() => {
		children.length = 0;
	});

	it("keeps at most 20 KB while the output streams, and says it was cut", async () => {
		const { ctx, notify } = terminal();

		const running = octocodeCommand.handler("localSearch x", ctx);
		await started();
		for (let i = 0; i < 50; i += 1) children[0].stdout.write(Buffer.alloc(1000, "a"));
		children[0].end(0);
		await running;

		const [text, level] = notify.mock.calls[0] as [string, string];
		expect(text.startsWith("a".repeat(20_000))).toBe(true);
		expect(text).not.toContain("a".repeat(20_001));
		expect(text).toContain("[output cut at 20 KB]");
		expect(level).toBe("info");
	});

	it("Esc stops the CLI and reports the run as cancelled", async () => {
		const { ctx, notify, inputs } = terminal();

		const running = octocodeCommand.handler("localSearch x", ctx);
		await started();
		expect(inputs[0]("\x1b")).toEqual({ consume: true });
		await running;

		expect(children[0].kill).toHaveBeenCalledOnce();
		expect(inputs).toHaveLength(0);
		expect(notify).toHaveBeenCalledWith("octocode localSearch x was cancelled.", "warning");
	});

	it("Octocode exiting stops a running CLI", async () => {
		const { ctx } = terminal();
		const before = process.listenerCount("exit");

		const running = octocodeCommand.handler("localSearch x", ctx);
		await started();
		const stop = process.listeners("exit").at(-1) as () => void;
		stop();
		await running;

		expect(children[0].kill).toHaveBeenCalledOnce();
		expect(process.listenerCount("exit")).toBe(before);
	});
});

import { expect, it, vi } from "vitest";
import { fileURLToPath } from "node:url";
import { DebugSession } from "../../src/octocode/debug/session.ts";
import { registerDebugTool } from "../../src/octocode/debug/tool.ts";
import { fakeCtx, fakeHost } from "./fake-host.ts";

const fixture = fileURLToPath(new URL("./fixtures/dap-adapter.mjs", import.meta.url));
const NO_EXCEPTIONS = { available: [], enabled: [], unknown: [] };

it("does not launch an adapter for an already cancelled call", async () => {
	const fake = fakeHost();
	registerDebugTool(fake.api);
	const launch = vi.spyOn(DebugSession, "launch").mockRejectedValue(new Error("unexpected adapter launch"));
	const reason = new Error("cancelled before execution");
	try {
		await expect(
			fake.tools
				.get("debug")!
				.execute(
					"cancelled-launch",
					{ action: "launch", adapter: "fake-adapter", launch: { program: "x" } },
					AbortSignal.abort(reason),
					undefined,
					fakeCtx({ cwd: process.cwd() }),
				),
		).rejects.toThrow(reason);
		expect(launch).not.toHaveBeenCalled();
	} finally {
		launch.mockRestore();
	}
});

it("answers launch without an adapter with the adapter recipes and starts nothing", async () => {
	const fake = fakeHost();
	registerDebugTool(fake.api);
	const tool = fake.tools.get("debug")!;
	// The recipes are not in the declaration sent with every request; the launch help carries them.
	for (const adapter of ["lldb-dap", "debugpy", "js-debug"]) expect(tool.description).toContain(adapter);
	expect(tool.description).not.toContain("dapDebugServer.js");
	const launch = vi.spyOn(DebugSession, "launch").mockRejectedValue(new Error("unexpected adapter launch"));
	try {
		const result = await tool.execute(
			"help",
			{ action: "launch" },
			undefined,
			undefined,
			fakeCtx({ cwd: process.cwd() }),
		);
		const text = (result.content[0] as { text: string }).text;
		expect(text).toMatch(/^Nothing was launched\./);
		for (const fact of [
			'adapter "xcrun", adapterArgs ["lldb-dap"]',
			'adapterArgs ["-m","debugpy.adapter"]',
			"subProcess: false",
			'"<js-debug>/src/dapDebugServer.js","0","127.0.0.1"], tcp true',
			'outputCapture: "std"',
			'exceptions ["all"] for ES modules',
			"32 adapterArgs, 32 breakpoint files, 100 lines per file, 16 exception filters",
		])
			expect(text).toContain(fact);
		expect(launch).not.toHaveBeenCalled();
		// With an adapter but no launch arguments the call is refused and points back at the help.
		await expect(
			tool.execute(
				"no-args",
				{ action: "launch", adapter: "node" },
				undefined,
				undefined,
				fakeCtx({ cwd: process.cwd() }),
			),
		).rejects.toThrow(/launch without adapter shows the recipes/);
	} finally {
		launch.mockRestore();
	}
});

it("replaces a naturally ended session on the next launch", async () => {
	const fake = fakeHost();
	registerDebugTool(fake.api);
	const ctx = fakeCtx({ cwd: process.cwd() });
	const tool = fake.tools.get("debug")!;
	const params = { action: "launch", adapter: process.execPath, launch: { program: "fixture" } } as const;
	try {
		const first = await tool.execute(
			"first",
			{ ...params, adapterArgs: [fixture, "--terminate-after-config"] },
			undefined,
			undefined,
			ctx,
		);
		// The launch waits for the end and reports it, with the program's last output and exit code.
		expect(JSON.parse(first.content[0].text)).toMatchObject({ state: "ended", exitCode: 3 });
		await expect(tool.execute("next", { action: "next", generation: 0 }, undefined, undefined, ctx)).rejects.toThrow(
			"Debug session ended",
		);
		await expect(
			tool.execute("second", { ...params, adapterArgs: [fixture] }, undefined, undefined, ctx),
		).resolves.toMatchObject({ content: [{ type: "text" }] });
	} finally {
		await tool.execute("terminate", { action: "terminate" }, undefined, undefined, ctx);
	}
});

it.each(["session_shutdown", "session_before_switch", "session_before_fork"])(
	"expires and closes a pending launch on %s",
	async (event) => {
		const fake = fakeHost();
		registerDebugTool(fake.api);
		const ctx = fakeCtx({ cwd: process.cwd() });
		let finish: (value: Awaited<ReturnType<typeof DebugSession.launch>>) => void = () => undefined;
		let launchSignal: AbortSignal | undefined;
		const close = vi.fn();
		const terminate = vi.fn(async () => undefined);
		const launch = vi.spyOn(DebugSession, "launch").mockImplementation((_input, signal) => {
			launchSignal = signal;
			return new Promise((resolve) => {
				finish = resolve;
			});
		});
		try {
			const running = fake.tools
				.get("debug")!
				.execute(
					"launch-1",
					{ action: "launch", adapter: "fake-adapter", launch: { program: "x" } },
					undefined,
					undefined,
					ctx,
				);
			await vi.waitFor(() => expect(launch).toHaveBeenCalledOnce());
			await fake.emit(event, {}, ctx);
			expect(launchSignal?.aborted).toBe(true);
			finish({ session: { close, terminate } as unknown as DebugSession, breakpoints: [], exceptions: NO_EXCEPTIONS });
			await expect(running).rejects.toThrow("expired");
			// The launched program may already run, so it is ended through the adapter before the adapter stops.
			expect(terminate).toHaveBeenCalledOnce();
			expect(close).toHaveBeenCalledOnce();
		} finally {
			launch.mockRestore();
		}
	},
);

it("terminate aborts an in-flight launch and rejects a concurrent second launch", async () => {
	const fake = fakeHost();
	registerDebugTool(fake.api);
	const ctx = fakeCtx({ cwd: process.cwd() });
	let finish: (value: Awaited<ReturnType<typeof DebugSession.launch>>) => void = () => undefined;
	const close = vi.fn();
	const terminate = vi.fn(async () => undefined);
	const launch = vi.spyOn(DebugSession, "launch").mockImplementation(
		() =>
			new Promise((resolve) => {
				finish = resolve;
			}),
	);
	try {
		const tool = fake.tools.get("debug")!;
		const params = { action: "launch", adapter: "fake-adapter", launch: { program: "x" } } as const;
		const running = tool.execute("launch-1", params, undefined, undefined, ctx);
		await vi.waitFor(() => expect(launch).toHaveBeenCalledOnce());
		await expect(tool.execute("launch-2", params, undefined, undefined, ctx)).rejects.toThrow(
			"already active or starting",
		);
		const terminated = await tool.execute("terminate", { action: "terminate" }, undefined, undefined, ctx);
		expect(terminated.content[0].text).toContain("cancelled");
		finish({ session: { close, terminate } as unknown as DebugSession, breakpoints: [], exceptions: NO_EXCEPTIONS });
		await expect(running).rejects.toThrow("expired");
		expect(terminate).toHaveBeenCalledOnce();
		expect(close).toHaveBeenCalledOnce();
	} finally {
		launch.mockRestore();
	}
});

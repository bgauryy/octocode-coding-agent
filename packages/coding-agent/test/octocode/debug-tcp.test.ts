import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";
import { DebugSession } from "../../src/octocode/debug/session.ts";

const fixture = fileURLToPath(new URL("./fixtures/dap-tcp-adapter.mjs", import.meta.url));
const launch = (flags: string[] = []) =>
	DebugSession.launch({
		adapter: process.execPath,
		adapterArgs: [fixture, ...flags],
		cwd: process.cwd(),
		tcp: true,
		launch: { type: "pwa-node", program: "/w/app.ts" },
		breakpoints: [{ source: "/w/app.ts", lines: [3] }],
		exceptions: ["uncaught"],
	});

describe("debug TCP adapters with child sessions", () => {
	it("adopts the startDebugging child, inspects its stop and reports its exit", async () => {
		const { session, exceptions } = await launch();
		try {
			expect(exceptions.enabled).toEqual(["uncaught"]);
			const stop = (await session.action("output", {})) as { generation: number; output: string };
			// The child received the breakpoints (it stops on line 3) and the exception filters.
			expect(stop).toMatchObject({
				state: "stopped",
				reason: "breakpoint",
				threadId: 7,
				frame: { id: 1001, source: "/w/app.ts", line: 3 },
			});
			expect(stop.output).toContain("child exceptions: uncaught");
			expect(stop.output).not.toContain("client cannot start children");
			const scopes = await session.action("scopes", { generation: stop.generation, frameId: 1001 });
			expect(scopes).toMatchObject({ scopes: [{ variablesReference: 2001 }] });
			await expect(
				session.action("variables", { generation: stop.generation, variablesReference: 2001 }),
			).resolves.toMatchObject({ variables: [{ name: "answer", value: "42" }] });
			// Breakpoint changes reach the child, whose answer is the verified one.
			await expect(session.action("breakpoints", { source: "/w/app.ts", lines: [3, 4] })).resolves.toEqual({
				breakpoints: [
					{ verified: true, line: 3 },
					{ verified: true, line: 4 },
				],
			});
			await expect(session.action("continue", { generation: stop.generation })).resolves.toMatchObject({
				state: "ended",
				exitCode: 0,
				output: expect.stringContaining("done"),
			});
		} finally {
			await session.terminate();
		}
	});
	it("pauses a running child session", async () => {
		const { session } = await launch(["--run"]);
		try {
			// The child connects asynchronously after the launch; pause targets it once it exists.
			const paused = await vi.waitFor(() => session.action("pause", {}), { timeout: 3_000, interval: 50 });
			expect(paused).toMatchObject({ state: "stopped", reason: "pause", threadId: 7, frame: { id: 1001 } });
		} finally {
			await session.terminate();
		}
		expect(session.state).toBe("ended");
	});
	it("stops child sessions before the root, so the adapter confirms promptly", async () => {
		const { session } = await launch();
		await expect(session.action("output", {})).resolves.toMatchObject({ state: "stopped", threadId: 7 });
		const started = Date.now();
		await expect(session.terminate()).resolves.toBeUndefined();
		expect(Date.now() - started).toBeLessThan(3_000);
		expect(session.state).toBe("ended");
	});
	it("fails fast with the adapter's output when it exits before printing a listening address", async () => {
		await expect(
			DebugSession.launch({
				adapter: process.execPath,
				adapterArgs: ["-e", "console.log('no server here'); process.exit(3)"],
				cwd: process.cwd(),
				tcp: true,
				launch: { type: "pwa-node" },
			}),
		).rejects.toThrow(/exited \(3\) before printing a loopback listening address: no server here/);
	});
});

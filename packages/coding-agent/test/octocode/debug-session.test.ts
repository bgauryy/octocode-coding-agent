import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { DebugSession } from "../../src/octocode/debug/session.ts";

const fixture = fileURLToPath(new URL("./fixtures/dap-adapter.mjs", import.meta.url));

describe("optional DAP session", () => {
	it("fails promptly if the adapter exits before initialized", async () => {
		const started = Date.now();
		await expect(
			DebugSession.launch({
				adapter: process.execPath,
				adapterArgs: [fixture, "--exit-before-initialized"],
				cwd: process.cwd(),
				launch: { program: "fixture" },
			}),
		).rejects.toThrow(/adapter exited|closed before initialized/);
		expect(Date.now() - started).toBeLessThan(2_000);
	});
	it("aborts promptly while waiting for initialized", async () => {
		const abort = new AbortController();
		const started = Date.now();
		const launch = DebugSession.launch(
			{
				adapter: process.execPath,
				adapterArgs: [fixture, "--omit-initialized"],
				cwd: process.cwd(),
				launch: { program: "fixture" },
			},
			abort.signal,
		);
		setTimeout(() => abort.abort(), 150);
		await expect(launch).rejects.toThrow(/aborted/);
		expect(Date.now() - started).toBeLessThan(2_000);
	});
	it("closes its adapter when the debuggee terminates", async () => {
		const { session } = await DebugSession.launch({
			adapter: process.execPath,
			adapterArgs: [fixture, "--terminate-after-config"],
			cwd: process.cwd(),
			launch: { program: "fixture" },
		});
		try {
			await expect.poll(() => session.state).toBe("ended");
			expect(session.protocol.child?.killed).toBe(true);
		} finally {
			session.close();
		}
	});
	it("keeps the final output and exit code after the debuggee ends", async () => {
		const { session } = await DebugSession.launch({
			adapter: process.execPath,
			adapterArgs: [fixture, "--terminate-after-config"],
			cwd: process.cwd(),
			launch: { program: "fixture" },
		});
		try {
			await expect(session.action("output", {})).resolves.toMatchObject({
				state: "ended",
				exitCode: 3,
				output: expect.stringContaining("bye"),
			});
			await expect(session.action("stack", { generation: session.generation })).rejects.toThrow("ended");
		} finally {
			session.close();
		}
	});
	it("waits for the next stop after a resume and names the top frame", async () => {
		const { session } = await DebugSession.launch({
			adapter: process.execPath,
			adapterArgs: [fixture],
			cwd: process.cwd(),
			launch: { program: "fixture" },
			breakpoints: [{ source: "fixture.js", lines: [7] }],
		});
		try {
			const first = (await session.action("output", {})) as { generation: number };
			expect(first).toMatchObject({ state: "stopped", reason: "breakpoint", threadId: 1, frame: { id: 11, line: 7 } });
			const step = (await session.action("next", { generation: first.generation })) as { generation: number };
			expect(step).toMatchObject({ state: "stopped", reason: "step", frame: { id: 11 } });
			expect(step.generation).toBeGreaterThan(first.generation);
			// The stop's frame is usable without a separate stack call.
			await expect(session.action("scopes", { generation: step.generation, frameId: 11 })).resolves.toMatchObject({
				scopes: [{ variablesReference: 22 }],
			});
		} finally {
			await session.terminate();
		}
	});
	it("treats an adapter that ends before answering terminate as terminated", async () => {
		const { session } = await DebugSession.launch({
			adapter: process.execPath,
			adapterArgs: [fixture, "--end-before-terminate-response"],
			cwd: process.cwd(),
			launch: { program: "fixture" },
		});
		await expect(session.terminate()).resolves.toBeUndefined();
		expect(session.state).toBe("ended");
	});
	it("rejects a stack response from a stop superseded while the request was in flight", async () => {
		const { session } = await DebugSession.launch({
			adapter: process.execPath,
			adapterArgs: [fixture, "--stale-stack"],
			cwd: process.cwd(),
			launch: { program: "fixture" },
		});
		try {
			for (let attempt = 0; attempt < 50 && session.state !== "stopped"; attempt++)
				await new Promise((resolve) => setTimeout(resolve, 10));
			const generation = session.generation;
			await expect(session.action("stack", { generation })).rejects.toThrow("Stale stop generation");
			await expect(session.action("scopes", { generation: session.generation, frameId: 11 })).rejects.toThrow(
				"Frame ID",
			);
		} finally {
			await session.terminate();
		}
	});
	it("launches, configures breakpoints, scopes handles to a stop, and terminates", async () => {
		const { session, breakpoints } = await DebugSession.launch({
			adapter: process.execPath,
			adapterArgs: [fixture],
			cwd: process.cwd(),
			launch: { program: "fixture" },
			breakpoints: [{ source: "fixture.js", lines: [7] }],
		});
		try {
			expect(breakpoints).toEqual([{ source: "fixture.js", breakpoints: [{ verified: true, line: 7 }] }]);
			for (let attempt = 0; attempt < 50 && session.state !== "stopped"; attempt++)
				await new Promise((resolve) => setTimeout(resolve, 10));
			expect(session.state).toBe("stopped");
			const generation = session.generation;
			const stack = (await session.action("stack", { generation })) as { frames: Array<{ id: number }> };
			expect(stack.frames[0]?.id).toBe(11);
			const scopes = (await session.action("scopes", { generation, frameId: 11 })) as {
				scopes: Array<{ variablesReference: number }>;
			};
			expect(scopes.scopes[0]?.variablesReference).toBe(22);
			const variables = await session.action("variables", { generation, variablesReference: 22 });
			expect(variables).toMatchObject({ variables: [{ value: "unexpected" }] });
			await expect(session.action("scopes", { generation, frameId: 999 })).rejects.toThrow("Frame ID");
			await session.action("next", { generation });
			await expect(session.action("variables", { generation, variablesReference: 22 })).rejects.toThrow(
				"Stale stop generation",
			);
			await expect(session.action("evaluate", { generation })).rejects.toThrow();
		} finally {
			await session.terminate();
		}
		expect(session.state).toBe("ended");
	});
});

import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { DebugSession } from "../../src/octocode/debug/session.ts";

const fixture = fileURLToPath(new URL("./fixtures/dap-adapter.mjs", import.meta.url));
const launch = (flags: string[], exceptions?: string[]) =>
	DebugSession.launch({
		adapter: process.execPath,
		adapterArgs: [fixture, ...flags],
		cwd: process.cwd(),
		launch: { program: "fixture" },
		exceptions,
	});

describe("debug pause and exception stops", () => {
	it("pauses a running program and reports where it stopped", async () => {
		const { session } = await launch(["--run"]);
		try {
			expect(session.state).toBe("running");
			await expect(session.action("pause", {})).resolves.toMatchObject({
				state: "stopped",
				reason: "pause",
				threadId: 1,
				frame: { id: 11, line: 7 },
			});
		} finally {
			await session.terminate();
		}
	});
	it("refuses pause unless the program is running", async () => {
		const { session } = await launch([]);
		try {
			await expect(session.action("output", {})).resolves.toMatchObject({ state: "stopped" });
			await expect(session.action("pause", {})).rejects.toThrow("pause needs a running program; it is stopped");
		} finally {
			await session.terminate();
		}
	});
	it("enables only advertised exception filters and stops with the exception text", async () => {
		const { session, exceptions } = await launch(["--throw"], ["uncaught", "bogus"]);
		try {
			expect(exceptions).toEqual({ available: ["uncaught", "raised"], enabled: ["uncaught"], unknown: ["bogus"] });
			await expect(session.action("output", {})).resolves.toMatchObject({
				state: "stopped",
				reason: "exception",
				text: "Error: boom",
				frame: { id: 11 },
				exception: { id: "Error", description: "boom", message: "Error: boom" },
			});
		} finally {
			await session.terminate();
		}
	});
	it("sends no exception filters unless asked", async () => {
		const { session, exceptions } = await launch(["--throw"]);
		try {
			expect(exceptions.enabled).toEqual([]);
			await expect(session.action("output", {})).resolves.toMatchObject({ reason: "breakpoint" });
		} finally {
			await session.terminate();
		}
	});
});

import { spawn } from "node:child_process";
import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { DapProtocol } from "../../src/octocode/debug/protocol.ts";

const fixture = fileURLToPath(new URL("./fixtures/dap-adapter.mjs", import.meta.url));

describe("bounded DAP stdio protocol", () => {
	it("stops dispatching buffered frames after a close event", () => {
		const child = Object.assign(new EventEmitter(), {
			stdin: new PassThrough(),
			stdout: new PassThrough(),
			stderr: new PassThrough(),
			exitCode: 0,
			killed: false,
		}) as unknown as ChildProcessWithoutNullStreams;
		const protocol = new DapProtocol(child);
		let stopped = false;
		protocol.on("terminated", () => protocol.close());
		protocol.on("stopped", () => {
			stopped = true;
		});
		const frame = (event: string) => {
			const body = Buffer.from(JSON.stringify({ type: "event", event }));
			return Buffer.concat([Buffer.from(`Content-Length: ${body.length}\r\n\r\n`), body]);
		};
		child.stdout.emit("data", Buffer.concat([frame("terminated"), frame("stopped")]));
		expect(stopped).toBe(false);
	});
	it("correlates requests and rejects reverse requests without executing them", async () => {
		const protocol = new DapProtocol(spawn(process.execPath, [fixture], { stdio: "pipe" }));
		try {
			const [a, b] = await Promise.all([protocol.request("initialize"), protocol.request("threads")]);
			expect(a.command).toBe("initialize");
			expect(b.command).toBe("threads");
		} finally {
			protocol.close();
		}
	});

	it("bounds an oversized adapter frame and rejects pending calls", async () => {
		const protocol = new DapProtocol(spawn(process.execPath, [fixture, "--malformed"], { stdio: "pipe" }));
		try {
			await expect(protocol.request("initialize")).rejects.toThrow("Content-Length");
		} finally {
			protocol.close();
		}
	});

	it("rejects a response whose command does not match its pending request", async () => {
		const protocol = new DapProtocol(spawn(process.execPath, [fixture, "--wrong-command"], { stdio: "pipe" }));
		try {
			await expect(protocol.request("initialize")).rejects.toThrow("command mismatch");
		} finally {
			protocol.close();
		}
	});

	it("aborts a pending request and cleans up the owned process", async () => {
		const protocol = new DapProtocol(spawn(process.execPath, [fixture, "--hang"], { stdio: "pipe" }));
		const abort = new AbortController();
		const waiting = protocol.request("initialize", {}, abort.signal);
		abort.abort();
		await expect(waiting).rejects.toThrow("aborted");
		protocol.close();
		expect(protocol.child?.killed).toBe(true);
	});
});

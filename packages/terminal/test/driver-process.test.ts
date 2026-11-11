import { setTimeout as delay } from "node:timers/promises";
import { describe, expect, it, vi } from "vitest";
import { DriverProcess } from "../src/driver-process.ts";

function killOwnedProcess(pid: number | undefined): void {
	if (!pid || !Number.isInteger(pid)) return;
	try {
		process.kill(pid, "SIGKILL");
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
	}
}

function driver(script: string): DriverProcess {
	return new DriverProcess(
		{ command: process.execPath, args: ["-e", script], cwd: process.cwd(), env: process.env },
		{ startMs: 2000, stallMs: 2000 },
	);
}

async function settlesPromptly<T>(promise: Promise<T>): Promise<T | "timeout"> {
	const timer = new AbortController();
	try {
		return await Promise.race([promise, delay(250, "timeout" as const, { signal: timer.signal })]);
	} finally {
		timer.abort();
	}
}

describe("completion driver resource limits", () => {
	it("settles cancellation while shell startup is still waiting", async () => {
		const shell = driver("setInterval(() => {}, 1000)");
		try {
			const abort = new AbortController();
			const request = shell.request("git ", abort.signal);
			abort.abort();
			expect(await settlesPromptly(request)).toBeUndefined();
		} finally {
			shell.close();
		}
	});

	it("settles readiness immediately when disposed before READY", async () => {
		const shell = driver("setInterval(() => {}, 1000)");
		shell.close();
		expect(await settlesPromptly(shell.whenReady())).toBe(false);
	});

	it("closes a driver producing an oversized unterminated line", async () => {
		const shell = driver(`
			console.log("\\x1eREADY");
			process.stdin.once("data", () => process.stdout.write("x".repeat(128 * 1024)));
			setInterval(() => {}, 1000);
		`);
		try {
			expect(await shell.whenReady()).toBe(true);
			expect(await settlesPromptly(shell.request("x", new AbortController().signal))).toBeUndefined();
			expect(shell.isClosed).toBe(true);
		} finally {
			shell.close();
		}
	});

	it("bounds the number of completion matches", async () => {
		const shell = driver(`
			console.log("\\x1eREADY");
			process.stdin.once("data", () => {
				let output = "";
				for (let i = 0; i < 10_001; i++) output += "1\\tvalue" + i + "\\tdesc\\t\\n";
				process.stdout.write(output + "1\\t\\x1e\\n");
			});
		`);
		try {
			const result = await shell.request("x", new AbortController().signal);
			expect(result === undefined).toBe(true);
			expect(shell.isClosed).toBe(true);
		} finally {
			shell.close();
		}
	});

	it("drops canceled output and still answers the next request", async () => {
		const shell = driver(`
			const { createInterface } = require("node:readline");
			console.log("\\x1eREADY");
			createInterface({ input: process.stdin }).on("line", (line) => {
				const [id, text] = line.split("\\t");
				if (text === "cancel") return;
				let output = "";
				for (let i = 0; i < 10_001; i++) output += "1\\tvalue" + i + "\\tdesc\\t\\n";
				process.stdout.write(output + "1\\t\\x1e\\n" + id + "\\tanswer\\t\\t\\n" + id + "\\t\\x1e\\n");
			});
		`);
		try {
			expect(await shell.whenReady()).toBe(true);
			const abort = new AbortController();
			const canceled = shell.request("cancel", abort.signal);
			await delay(0);
			abort.abort();
			expect(await canceled).toBeUndefined();
			expect(await shell.request("next", new AbortController().signal)).toEqual([
				{ value: "answer", description: "", flags: "" },
			]);
			expect(shell.isClosed).toBe(false);
		} finally {
			shell.close();
		}
	});

	it("bounds retained text even below the match-count limit", async () => {
		const shell = driver(`
			console.log("\\x1eREADY");
			process.stdin.once("data", () => {
				process.stdout.write(("1\\t" + "x".repeat(32 * 1024) + "\\n").repeat(40) + "1\\t\\x1e\\n");
			});
		`);
		try {
			const result = await shell.request("x", new AbortController().signal);
			expect(result === undefined).toBe(true);
			expect(shell.isClosed).toBe(true);
		} finally {
			shell.close();
		}
	});

	it.skipIf(process.platform === "win32")("terminates a completion shell that ignores graceful shutdown", async () => {
		const shell = driver(`
			process.on("SIGHUP", () => {});
			process.on("SIGTERM", () => {});
			console.log("\\x1eREADY");
			process.stdin.once("data", () => console.log("1\\t" + process.pid + "\\t\\t\\n1\\t\\x1e"));
			setInterval(() => {}, 1000);
		`);
		let pid: number | undefined;
		try {
			const result = await shell.request("pid", new AbortController().signal);
			pid = Number(result?.[0].value);
			expect(Number.isInteger(pid) && pid > 0).toBe(true);
			shell.close();
			await vi.waitFor(
				() => {
					expect(() => process.kill(pid!, 0)).toThrow(expect.objectContaining({ code: "ESRCH" }));
				},
				{ timeout: 1500 },
			);
		} finally {
			shell.close();
			killOwnedProcess(pid);
		}
	});
});

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test, vi } from "vitest";
import { RpcClient } from "../src/modes/rpc/rpc-client.ts";

const tempDirs: string[] = [];

function writeChildScript(contents: string): string {
	const dir = mkdtempSync(join(tmpdir(), "octocode-rpc-client-exit-"));
	tempDirs.push(dir);
	const path = join(dir, "child.mjs");
	writeFileSync(path, contents);
	return path;
}

afterEach(() => {
	for (const dir of tempDirs.splice(0)) {
		rmSync(dir, { recursive: true, force: true });
	}
});

describe("RpcClient request timeouts", () => {
	test("waits for long-running commands while short requests still time out", async () => {
		const client = new RpcClient({ cliPath: writeChildScript("process.stdin.resume();") });
		await client.start();
		vi.useFakeTimers();
		try {
			const commands = client.getCommands();
			const compact = client.compact();
			const compactSettled = vi.fn();
			compact.then(compactSettled, compactSettled);
			const commandsFailed = expect(commands).rejects.toThrow(/Timeout waiting for response to get_commands/);
			await vi.advanceTimersByTimeAsync(31_000);
			await commandsFailed;
			expect(compactSettled).not.toHaveBeenCalled();
		} finally {
			vi.useRealTimers();
			await client.stop().catch(() => undefined);
		}
	});
});

describe("RpcClient child process failures", () => {
	test("rejects an in-flight request when the child process exits", async () => {
		const client = new RpcClient({
			cliPath: writeChildScript(`
process.stdin.once("data", () => {
	process.exit(43);
});
process.stdin.resume();
`),
		});

		await client.start();

		await expect(client.getCommands()).rejects.toThrow(/Agent process exited \(code=43 signal=null\)/);
	});
});

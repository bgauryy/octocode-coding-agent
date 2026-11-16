import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const drainModule = fileURLToPath(new URL("../../src/main/drain-stdio.ts", import.meta.url));
const BYTES = 300_000;

/** A child that writes `BYTES` to a pipe, drains, and exits the way `runSubcommand` does. */
function child() {
	const source = `import { drainStdio } from ${JSON.stringify(drainModule)};
process.stdout.write("x".repeat(${BYTES}));
await drainStdio(1000);
process.exit(0);`;
	return spawn(process.execPath, ["--input-type=module", "-e", source], { stdio: ["ignore", "pipe", "inherit"] });
}

describe("drainStdio before process.exit", () => {
	it("delivers every byte to a slow reader", async () => {
		const proc = child();
		proc.stdout.pause();
		await new Promise((resolve) => setTimeout(resolve, 300));
		let received = 0;
		proc.stdout.on("data", (chunk: Buffer) => (received += chunk.length));
		proc.stdout.resume();
		await new Promise((resolve) => proc.once("close", resolve));
		expect(received).toBe(BYTES);
	});

	it("exits within the bound when nobody reads", async () => {
		const proc = child();
		proc.stdout.pause();
		const started = Date.now();
		await new Promise((resolve) => proc.once("exit", resolve));
		expect(Date.now() - started).toBeLessThan(1500 + 1000);
		proc.stdout.destroy();
	});
});

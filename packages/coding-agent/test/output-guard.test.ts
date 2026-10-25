import { spawnSync } from "node:child_process";
import { expect, it } from "vitest";

const guard = new URL("../src/core/output-guard.ts", import.meta.url).href;
const failedWriter = `process.stdout.write = (_text, callback) => {
  callback(Object.assign(new Error("closed"), { code: "EPIPE" }));
  return false;
};`;

function run(source: string) {
	const result = spawnSync(process.execPath, ["--input-type=module", "--eval", source], {
		encoding: "utf8",
		timeout: 5_000,
	});
	return result;
}

it("retains exit-on-write-failure for existing fire-and-forget stdout callers", () => {
	const result = run(`${failedWriter}
const { writeRawStdout } = await import(${JSON.stringify(guard)});
writeRawStdout("reply");
setTimeout(() => process.stderr.write("unexpected continuation"), 100);`);
	expect(result.error).toBeUndefined();
	expect(result.status).toBe(1);
	expect(result.stderr).toBe("");
});

it("lets an awaiting protocol owner clean up after an EPIPE without replaying queued writes", () => {
	const result = run(`let attempts = 0;
process.stdout.write = (_text, callback) => {
  attempts++;
  callback(Object.assign(new Error("closed"), { code: "EPIPE" }));
  return false;
};
const { writeRawStdoutAsync } = await import(${JSON.stringify(guard)});
const first = await writeRawStdoutAsync("reply").catch((error) => error.code);
const second = await writeRawStdoutAsync("later reply").catch((error) => error.code);
await new Promise((resolve) => setTimeout(resolve, 20));
process.stderr.write(JSON.stringify({ first, second, attempts, cleanedUp: true }));`);
	expect(result.error).toBeUndefined();
	expect(result.status).toBe(0);
	expect(JSON.parse(result.stderr)).toEqual({ first: "EPIPE", second: "EPIPE", attempts: 1, cleanedUp: true });
});

it("retries transient stdout backpressure while retaining ordering and flushing", () => {
	const result = run(`const writes = [];
process.stdout.write = (text, callback) => {
  writes.push(text);
  queueMicrotask(() => callback(writes.length === 1 ? Object.assign(new Error("retry"), { code: "EAGAIN" }) : undefined));
  return false;
};
const { writeRawStdout, writeRawStdoutAsync, flushRawStdout } = await import(${JSON.stringify(guard)});
writeRawStdout("first");
await writeRawStdoutAsync("second");
await flushRawStdout();
process.stderr.write(JSON.stringify(writes));`);
	expect(result.error).toBeUndefined();
	expect(result.status).toBe(0);
	expect(JSON.parse(result.stderr)).toEqual(["first", "first", "second", ""]);
});

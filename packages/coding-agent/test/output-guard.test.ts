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

it("gives a registered owner the failure of a fire-and-forget write, then stops waiting on or writing to stdout", () => {
	const result = run(`let attempts = 0;
process.stdout.write = (_text, callback) => {
  attempts++;
  callback(Object.assign(new Error("closed"), { code: "EPIPE" }));
  return false;
};
const { writeRawStdout, onRawStdoutFailure, waitForRawStdoutBackpressure, flushRawStdout } = await import(${JSON.stringify(guard)});
const failures = [];
onRawStdoutFailure((error) => failures.push(error.code));
writeRawStdout("reply");
await waitForRawStdoutBackpressure();
await flushRawStdout();
await new Promise((resolve) => setTimeout(resolve, 20));
process.stderr.write(JSON.stringify({ failures, attempts }));`);
	expect(result.error).toBeUndefined();
	expect(result.status).toBe(0);
	expect(JSON.parse(result.stderr)).toEqual({ failures: ["EPIPE"], attempts: 1 });
});

it("gives a registered owner the stream's error event, which would otherwise crash the process", () => {
	const result = run(`const { onRawStdoutFailure, flushRawStdout } = await import(${JSON.stringify(guard)});
const failures = [];
onRawStdoutFailure((error) => failures.push(error.message));
process.stdout.emit("error", new Error("write EPIPE"));
await flushRawStdout();
process.stderr.write(JSON.stringify(failures));`);
	expect(result.error).toBeUndefined();
	expect(result.status).toBe(0);
	expect(JSON.parse(result.stderr)).toEqual(["write EPIPE"]);
});

it("reports whether a write is on its way", () => {
	const result = run(`let finish;
process.stdout.write = (_text, callback) => {
  finish = callback;
  return false;
};
const { writeRawStdout, isRawStdoutWritePending } = await import(${JSON.stringify(guard)});
const before = isRawStdoutWritePending();
writeRawStdout("reply");
const during = isRawStdoutWritePending();
await new Promise((resolve) => setTimeout(resolve, 5));
finish();
await new Promise((resolve) => setTimeout(resolve, 5));
process.stderr.write(JSON.stringify({ before, during, after: isRawStdoutWritePending() }));`);
	expect(result.status).toBe(0);
	expect(JSON.parse(result.stderr)).toEqual({ before: false, during: true, after: false });
});

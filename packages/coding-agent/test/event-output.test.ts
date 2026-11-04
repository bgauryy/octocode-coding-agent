import { spawnSync } from "node:child_process";
import { expect, it } from "vitest";

const guard = new URL("../src/core/output-guard.ts", import.meta.url).href;
const output = new URL("../src/modes/event-output.ts", import.meta.url).href;

/** Runs `body` with a stdout whose writes finish only when `drain()` is called; it reports `writes` as JSON on stderr. */
function run(body: string) {
	const result = spawnSync(
		process.execPath,
		[
			"--input-type=module",
			"--eval",
			`const writes = [];
const callbacks = [];
process.stdout.write = (text, callback) => {
  writes.push(JSON.parse(text));
  callbacks.push(callback);
  return false;
};
const tick = () => new Promise((resolve) => setTimeout(resolve, 1));
const drain = async () => {
  for (let idle = 0; idle < 5; idle++) {
    await tick();
    while (callbacks.length) { callbacks.shift()(); idle = 0; await tick(); }
  }
};
const { writeRawStdout } = await import(${JSON.stringify(guard)});
const { createEventOutput, waitForEventBackpressure } = await import(${JSON.stringify(output)});
const out = createEventOutput((event) => writeRawStdout(JSON.stringify(event)));
const update = (toolCallId, n) => ({ type: "tool_execution_update", toolCallId, n });
${body}
process.stderr.write(JSON.stringify(writes));`,
		],
		{ encoding: "utf8", timeout: 5_000 },
	);
	expect(result.error).toBeUndefined();
	expect(result.status, result.stderr).toBe(0);
	return JSON.parse(result.stderr) as Array<Record<string, unknown>>;
}

it("keeps only the latest update of each call while a write is pending", () => {
	const writes = run(`out({ type: "tool_execution_start", toolCallId: "a" });
for (let n = 0; n < 500; n++) out(update("a", n));
out(update("b", 1));
await drain();`);
	expect(writes).toEqual([{ type: "tool_execution_start", toolCallId: "a" }, update("a", 499), update("b", 1)]);
});

it("writes an update at once when nothing is pending", () => {
	const writes = run(`out(update("a", 1));
await drain();
out(update("a", 2));
await drain();`);
	expect(writes).toEqual([update("a", 1), update("a", 2)]);
});

it("never writes a held update after its call's end, and keeps other calls in order before the next event", () => {
	const writes = run(`out({ type: "turn_start" });
out(update("a", 1));
out(update("b", 1));
out({ type: "tool_execution_end", toolCallId: "a" });
await drain();`);
	expect(writes).toEqual([{ type: "turn_start" }, update("b", 1), { type: "tool_execution_end", toolCallId: "a" }]);
});

it("does not hold a run or a snapshot on an update, and still waits for every other event", () => {
	const writes = run(`out({ type: "turn_start" });
let updateDone = false;
let endDone = false;
void waitForEventBackpressure({ type: "tool_execution_update", toolCallId: "a" }).then(() => { updateDone = true; });
void waitForEventBackpressure({ type: "tool_execution_end", toolCallId: "a" }).then(() => { endDone = true; });
await tick();
writeRawStdout(JSON.stringify({ updateDone, endDone }));
await drain();`);
	expect(writes[1]).toEqual({ updateDone: true, endDone: false });
});

function update(toolCallId: string, n: number) {
	return { type: "tool_execution_update", toolCallId, n };
}

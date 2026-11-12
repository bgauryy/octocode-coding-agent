// Child for terminal-output-pressure.test.ts: paints frames into a PTY that is not read, with essential writes between
// them, and reports its timer, its largest queue and its recovery on the health descriptor.
import { writeSync } from "node:fs";
import { TerminalOutput } from "../../src/terminal/output.ts";

const CAP = 64 * 1024;
const health = (message: string) => writeSync(Number(process.env.OUTPUT_HEALTH_FD), `${message}\n`);
const output = new TerminalOutput();
output.setFrameCap(CAP);
let recovered = 0;
let essentials = 0;
let maxPending = 0;
let ticks = 0;
const note = () => {
	maxPending = Math.max(maxPending, output.pendingBytes);
};
output.setRecovery(() => {
	recovered++;
	output.write(`<FULL${recovered}>`, "frame");
	health(`recovered:${recovered}`);
});
health(`cap:${CAP}`);
const timer = setInterval(() => health(`tick:${++ticks}`), 50);
const frames = setInterval(() => {
	output.write("f".repeat(20_000), "frame");
	note();
}, 5);
const restore = setInterval(() => {
	output.write(`<E${++essentials}>`);
	note();
}, 100);
setTimeout(async () => {
	clearInterval(frames);
	clearInterval(restore);
	output.write("<END>");
	note();
	health(`max:${maxPending}`);
	health(`essentials:${essentials}`);
	health(`dropped:${output.getTelemetry().droppedFrameBytes}`);
	if (!(await output.drain(10_000))) throw new Error("output did not drain");
	await new Promise((resolve) => setTimeout(resolve, 50));
	clearInterval(timer);
	health("done");
}, 2500);

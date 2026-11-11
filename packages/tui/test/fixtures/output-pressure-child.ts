import { writeSync } from "node:fs";
import { TerminalOutput } from "../../src/terminal/output.ts";

const health = (message: string) => writeSync(Number(process.env.OUTPUT_HEALTH_FD), `${message}\n`);
const output = new TerminalOutput();
let ticks = 0;
const timer = setInterval(() => health(`tick:${++ticks}`), 25);
health(`tty:${process.stdout.isTTY}`);
health("start");
output.write("x".repeat(1024 * 1024));
output.write("end");
health(`returned:${output.pendingBytes}`);
health(`deadline:${await output.drain(50)}`);
if (!(await output.drain(5000))) throw new Error("output did not drain");
clearInterval(timer);
health("drained");

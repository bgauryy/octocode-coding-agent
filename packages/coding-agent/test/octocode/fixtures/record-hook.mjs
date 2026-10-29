// Command-hook stand-in: appends "<tag>\t<event>\t<tool>" to the log named by argv[2] and prints nothing.
import { appendFileSync, readFileSync } from "node:fs";

const [log, tag] = process.argv.slice(2);
let input = {};
try {
	input = JSON.parse(readFileSync(0, "utf8") || "{}");
} catch {}
appendFileSync(log, `${tag}\t${input.hook_event_name ?? "?"}\t${input.tool_name ?? ""}\n`);

// Command-hook stand-in. argv: <out dir> <mode>. Writes its stdin JSON to "<out dir>/<event>-<n>.json", then:
//   allow  exits 0 with no output      block  prints a reason on stderr and exits 2
//   deny   exits 0 with a JSON permissionDecision "deny"      json-block  exits 2 with a JSON reason and a different stderr
//   exit1-deny  exits 1 with a JSON permissionDecision "deny" (Claude reads the JSON on any exit but 2)
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const [dir, mode = "allow"] = process.argv.slice(2);
mkdirSync(dir, { recursive: true });
const text = readFileSync(0, "utf8");
const event = JSON.parse(text || "{}").hook_event_name ?? "unknown";
const count = readdirSync(dir).filter((name) => name.startsWith(`${event}-`)).length;
writeFileSync(join(dir, `${event}-${count}.json`), text);
const decision = (reason) =>
	JSON.stringify({ hookSpecificOutput: { hookEventName: event, permissionDecision: "deny", permissionDecisionReason: reason } });
if (mode === "block") {
	process.stderr.write("blocked-by-fixture-stderr");
	process.exit(2);
}
if (mode === "deny") process.stdout.write(decision("denied-by-fixture-json"));
if (mode === "json-block") {
	process.stdout.write(decision("blocked-by-fixture-json-reason"));
	process.stderr.write("stderr-that-loses");
	process.exit(2);
}
if (mode === "exit1-deny") {
	process.stdout.write(decision("denied-by-exit1-json"));
	process.exit(1);
}

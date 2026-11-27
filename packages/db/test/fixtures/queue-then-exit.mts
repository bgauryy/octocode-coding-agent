import fs from "node:fs";
import path from "node:path";
import { getFileStamp } from "../../../common/src/paths.ts";
import { drainDbWriters, sharedMirrorWriter } from "../../src/api.ts";

// Queues a transcript save on the shared mirror writer, then ends the process with `process.exit` as a quit does.
const [dir, mode] = process.argv.slice(2);
const id = "s-exit";
const file = path.join(dir, `${id}.jsonl`);
const header = JSON.stringify({ type: "session", version: 3, id, timestamp: "x", cwd: "/r/exit" });
const record = { id: `${id}-0`, parentId: null, type: "custom", json: JSON.stringify({ type: "custom", id: `${id}-0`, parentId: null }) };
fs.writeFileSync(file, `${header}\n${record.json}\n`);
const writer = sharedMirrorWriter({
	file: path.join(dir, "exit.db"),
	mirrorFile: path.join(dir, "exit.transcripts.db"),
	archiveDir: path.join(dir, "archive"),
	privateParent: false,
});
void writer.submit({
	kind: "save",
	sessionId: id,
	file: fs.realpathSync(file),
	stamp: getFileStamp(file),
	header,
	records: [record],
	workspace: { id: "ws-exit", root: "/r/exit", name: "exit", binding: "1:1" },
});
if (mode === "drain") await drainDbWriters();
process.exit(0);

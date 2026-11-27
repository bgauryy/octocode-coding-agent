import fs from "node:fs";
import path from "node:path";
import { openDatabase } from "../../src/api.ts";

const [file, release] = process.argv.slice(2);
const agent = openDatabase({ file, mirrorFile: `${file}.mirror`, archiveDir: path.join(path.dirname(file), "archive"), privateParent: false });
try {
	agent.transaction(() => {
		process.stdout.write("held\n");
		const deadline = Date.now() + 5_000;
		while (!fs.existsSync(release)) {
			if (Date.now() > deadline) throw new Error("Write-lock fixture deadline");
			Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 5);
		}
	});
} finally {
	agent.close();
}

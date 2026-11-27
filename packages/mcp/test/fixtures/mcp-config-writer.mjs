import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { addMcpServerConfig } from "../../src/config-write.ts";

const [file, name, release, hold] = process.argv.slice(2);
const originalRead = fs.readFileSync;
let paused = false;
fs.readFileSync = function (target, ...args) {
	const result = originalRead(target, ...args);
	if (hold === "hold" && String(target) === file && !paused && new Error().stack?.includes("editMcpServers")) {
		paused = true;
		process.send?.({ phase: "read" });
		const deadline = Date.now() + 5_000;
		while (!fs.existsSync(release)) {
			if (Date.now() > deadline) throw new Error("Config writer fixture barrier timed out");
			Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 5);
		}
	}
	return result;
};
syncBuiltinESMExports();

let result;
try {
	addMcpServerConfig(file, name, { command: "node", enabled: false, defaultActive: false }, { replace: false });
	result = { phase: "result", ok: true };
} catch (error) {
	result = { phase: "result", ok: false, code: error.code, message: error.message };
	process.exitCode = 1;
}
process.send?.(result, () => process.disconnect());

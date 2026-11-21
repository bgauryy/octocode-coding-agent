#!/usr/bin/env node
/**
 * Compares the tools the installed Cua Driver offers with the list Octocode was written against
 * (`packages/mcp/test/fixtures/desktop/tools.json`), and says what a drift means for the `desktop` preset
 * (`packages/mcp/src/presets/desktop/index.ts`): a new tool defaults to a declared, full-size tool, and a removed one is a
 * stale entry. It starts `cua-driver mcp` (which starts the Cua daemon), so it is a manual check, not part of the suites.
 *
 *   node scripts/check-desktop-tools.mjs            exit 1 when the installed Driver differs from the fixture
 *   node scripts/check-desktop-tools.mjs --update   record the installed Driver's tools as the new fixture
 */
import { spawn, spawnSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const fixture = path.resolve(
	path.dirname(fileURLToPath(import.meta.url)),
	"../packages/mcp/test/fixtures/desktop/tools.json",
);
const update = process.argv.includes("--update");

const version = spawnSync(process.env.OCTOCODE_CUA_DRIVER_PATH || "cua-driver", ["--version"], { encoding: "utf8" });
if (version.status !== 0) {
	console.log("cua-driver is not installed or not on PATH: nothing to compare.");
	process.exit(0);
}
const driverVersion = version.stdout.trim().replace(/^cua-driver\s+/, "");

function listTools() {
	return new Promise((resolve, reject) => {
		const child = spawn(process.env.OCTOCODE_CUA_DRIVER_PATH || "cua-driver", ["mcp"], {
			stdio: ["pipe", "pipe", "ignore"],
		});
		let buffer = "";
		const replies = new Map();
		child.stdout.on("data", (chunk) => {
			buffer += chunk;
			for (let at = buffer.indexOf("\n"); at >= 0; at = buffer.indexOf("\n")) {
				const line = buffer.slice(0, at);
				buffer = buffer.slice(at + 1);
				if (line.trim()) {
					const message = JSON.parse(line);
					if (message.id) replies.set(message.id, message);
				}
			}
		});
		const send = (message) => child.stdin.write(`${JSON.stringify(message)}\n`);
		send({
			jsonrpc: "2.0",
			id: 1,
			method: "initialize",
			params: {
				protocolVersion: "2025-06-18",
				capabilities: {},
				clientInfo: { name: "check-desktop-tools", version: "1" },
			},
		});
		setTimeout(() => {
			send({ jsonrpc: "2.0", method: "notifications/initialized" });
			send({ jsonrpc: "2.0", id: 2, method: "tools/list" });
		}, 1500);
		setTimeout(() => {
			child.kill();
			const tools = replies.get(2)?.result?.tools;
			if (!tools) reject(new Error("cua-driver mcp did not answer tools/list within 6 seconds"));
			else resolve(tools);
		}, 6000);
	});
}

const live = (await listTools())
	.map((tool) => ({
		name: tool.name,
		readOnlyHint: tool.annotations?.readOnlyHint === true,
		destructiveHint: tool.annotations?.destructiveHint === true,
	}))
	.sort((a, b) => a.name.localeCompare(b.name));

if (update) {
	writeFileSync(fixture, `${JSON.stringify({ driverVersion, tools: live }, null, "\t")}\n`);
	console.log(
		`Recorded ${live.length} tools of Cua Driver ${driverVersion} in ${path.relative(process.cwd(), fixture)}.`,
	);
	process.exit(0);
}

const recorded = JSON.parse(readFileSync(fixture, "utf8"));
const known = new Set(recorded.tools.map((tool) => tool.name));
const now = new Set(live.map((tool) => tool.name));
const added = [...now].filter((name) => !known.has(name));
const removed = [...known].filter((name) => !now.has(name));
const hints = live
	.filter((tool) => {
		const before = recorded.tools.find((entry) => entry.name === tool.name);
		return before && (before.readOnlyHint !== tool.readOnlyHint || before.destructiveHint !== tool.destructiveHint);
	})
	.map((tool) => tool.name);

if (added.length + removed.length + hints.length === 0) {
	console.log(
		`Cua Driver ${driverVersion} matches the recorded tools (${live.length}, recorded against ${recorded.driverVersion}).`,
	);
	process.exit(0);
}
console.log(`Cua Driver ${driverVersion} differs from the tools recorded against ${recorded.driverVersion}:`);
if (added.length) console.log(`  new (declared in full until classified): ${added.join(", ")}`);
if (removed.length) console.log(`  removed (stale entries in the preset): ${removed.join(", ")}`);
if (hints.length) console.log(`  annotations changed (re-check permission treatment): ${hints.join(", ")}`);
console.log(
	"Classify each in packages/mcp/src/presets/desktop/index.ts (declared, onDemand or hidden), then run with --update.",
);
process.exit(1);

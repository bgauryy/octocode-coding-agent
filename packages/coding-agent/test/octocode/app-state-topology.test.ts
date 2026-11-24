import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * The state topology of RFC 2026-11-23-app-state: zustand vanilla stores scoped to a session or a host, React bindings
 * only in React surfaces, and no store that persists itself (durable facts go through `packages/db` or the session file,
 * written by their owner; the application state store notifies on every streamed delta, so a persisted store would write
 * per token).
 */

const packagesDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");

const walk = (dir: string): string[] =>
	fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
		const full = path.join(dir, entry.name);
		if (entry.isDirectory()) return entry.name === "node_modules" || entry.name === "dist" ? [] : walk(full);
		return /\.(?:ts|tsx|mts)$/.test(entry.name) && !entry.name.endsWith(".generated.ts") ? [full] : [];
	});

const sources = fs
	.readdirSync(packagesDir, { withFileTypes: true })
	.filter((entry) => entry.isDirectory() && fs.existsSync(path.join(packagesDir, entry.name, "src")))
	.flatMap((entry) => walk(path.join(packagesDir, entry.name, "src")))
	.map((file) => ({
		file: path.relative(packagesDir, file).split(path.sep).join("/"),
		text: fs.readFileSync(file, "utf8"),
	}));

const importing = (pattern: RegExp) => sources.filter(({ text }) => pattern.test(text)).map(({ file }) => file);

describe("application state topology", () => {
	it("scans every workspace's sources", () => {
		expect(importing(/from\s+["']zustand\/vanilla["']/).length).toBeGreaterThan(5);
	});

	it("never lets a store persist itself", () => {
		expect(importing(/["']zustand\/middleware(?:\/[^"']*)?["']/)).toEqual([]);
	});

	it("binds stores to React only in the React surfaces", () => {
		const react = importing(/from\s+["']zustand["']/);
		expect(react.filter((file) => !file.startsWith("webview/src/"))).toEqual([]);
	});

	// A module-level store is one per process, so it would hold one session's facts for every session the process hosts
	// (an ACP host runs several). T5 scoped the last two (the permission chip and the live agents) per session: a new
	// entry needs a fact that is truly process-wide.
	it("adds no process-wide store", () => {
		const moduleStores = sources
			.filter(({ text }) => /^(?:export )?const \w+ = createStore\b/m.test(text))
			.map(({ file }) => file)
			.sort();
		expect(moduleStores).toEqual([]);
	});
});

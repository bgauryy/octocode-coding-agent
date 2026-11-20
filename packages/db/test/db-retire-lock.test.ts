import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { type AgentDb, openDatabase } from "../src/db.ts";
import { COORDINATION_FILE, type FileKind } from "../src/schema.ts";
import { CARRY_META_KEY } from "../src/carry-over.ts";
import { loadSqlite } from "../src/sqlite.ts";
import { tmp } from "./helpers.ts";

const { DatabaseSync } = loadSqlite();
const newer: FileKind = { ...COORDINATION_FILE, version: COORDINATION_FILE.version + 1 };

const open = (file: string, kind?: FileKind): AgentDb =>
	openDatabase(
		{
			file,
			mirrorFile: `${file}.transcripts`,
			archiveDir: path.join(path.dirname(file), "archive"),
			privateParent: false,
		},
		kind,
	);

const keys = (file: string): string[] => {
	const db = new DatabaseSync(file, { readOnly: true });
	try {
		return (db.prepare("SELECT key FROM meta ORDER BY key").all() as Array<{ key: string }>).map((row) => row.key);
	} finally {
		db.close();
	}
};

/** A closed database at the current version holding one meta row, replacing whatever file was there. */
function writeOld(file: string, key: string): void {
	for (const suffix of ["", "-wal", "-shm"]) fs.rmSync(`${file}${suffix}`, { force: true });
	const agent = open(file);
	agent.db.prepare("INSERT INTO meta (key, value) VALUES (?, 'x')").run(key);
	agent.close();
}

const retiredFiles = (file: string) =>
	fs
		.readdirSync(path.dirname(file))
		.filter((name) => name.startsWith(`${path.basename(file)}.v`) && /\.retired(\.\d+(-\d+)?)?$/.test(name));

describe("retiring an older agent database", () => {
	it("keeps every file when the same version is retired twice", () => {
		const file = path.join(tmp(), "workspaces.db");
		writeOld(file, "first");
		open(file, newer).close();
		writeOld(file, "second");
		open(file, newer).close();
		writeOld(file, "third");
		open(file, newer).close();
		const retired = retiredFiles(file);
		expect(retired).toHaveLength(3);
		const held = retired.map((name) => keys(path.join(path.dirname(file), name)).join());
		expect(held.sort()).toEqual(["first", "second", "third"]);
		// The first keeps the plain name; nothing is overwritten.
		expect(keys(`${file}.v${COORDINATION_FILE.version}.retired`)).toEqual(["first"]);
		expect(fs.existsSync(`${file}.lock`)).toBe(false);
	});

	it("leaves a file that another process retired and recreated alone, even when several open it at once", async () => {
		const dir = tmp();
		const file = path.join(dir, "workspaces.db");
		writeOld(file, "old");
		const gate = path.join(dir, "go");
		const script = path.join(dir, "child.ts");
		const root = path.resolve(import.meta.dirname, "../src");
		fs.writeFileSync(
			script,
			`import fs from "node:fs";
import { openDatabase } from ${JSON.stringify(path.join(root, "db.ts"))};
import { COORDINATION_FILE } from ${JSON.stringify(path.join(root, "schema.ts"))};
const [file, gate, name] = process.argv.slice(2);
const kind = { ...COORDINATION_FILE, version: COORDINATION_FILE.version + 1 };
while (!fs.existsSync(gate)) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 2);
const renames = [];
const rename = fs.renameSync;
fs.renameSync = (from, to) => { renames.push(String(from)); return rename(from, to); };
const agent = openDatabase({ file, mirrorFile: file + ".transcripts", archiveDir: file + "-archive", privateParent: false }, kind);
agent.db.prepare("INSERT INTO meta (key, value) VALUES (?, 'x')").run(name);
agent.close();
console.log(JSON.stringify(renames.filter((from) => from === file).length));
`,
		);
		const names = ["a", "b", "c", "d"];
		const runs = names.map(
			(name) =>
				new Promise<number>((resolve, reject) => {
					let out = "";
					let err = "";
					const child = spawn(process.execPath, [script, file, gate, name], { stdio: ["ignore", "pipe", "pipe"] });
					child.stdout.on("data", (chunk) => (out += String(chunk)));
					child.stderr.on("data", (chunk) => (err += String(chunk)));
					child.on("error", reject);
					child.on("exit", (code) =>
						code === 0 ? resolve(Number(out.trim())) : reject(new Error(err || `exit ${code}`)),
					);
				}),
		);
		await new Promise((resolve) => setTimeout(resolve, 500));
		fs.writeFileSync(gate, "");
		const renames = await Promise.all(runs);
		// One opener moved the old file; the others found the new one and kept it. The mover recorded what it carried over.
		expect(renames.reduce((sum, count) => sum + count, 0)).toBe(1);
		expect(keys(file)).toEqual([...names, CARRY_META_KEY].sort());
		const retired = retiredFiles(file);
		expect(retired).toHaveLength(1);
		expect(keys(path.join(dir, retired[0]))).toEqual(["old"]);
	}, 30_000);
});

describe("an older agent database in use", () => {
	it("is refused and left untouched while another connection holds it", () => {
		const file = path.join(tmp(), "workspaces.db");
		writeOld(file, "live");
		const holder = open(file);
		try {
			expect(() => open(file, newer)).toThrow(/in use by .*left untouched/);
			expect(retiredFiles(file)).toEqual([]);
			expect(keys(file)).toEqual(["live"]);
			holder.db.prepare("INSERT INTO meta (key, value) VALUES ('more', 'x')").run();
		} finally {
			holder.close();
		}
		expect(keys(file)).toEqual(["live", "more"]);
	});

	it("is retired once the holder closes", () => {
		const file = path.join(tmp(), "workspaces.db");
		writeOld(file, "idle");
		const holder = open(file);
		expect(() => open(file, newer)).toThrow();
		holder.close();
		open(file, newer).close();
		expect(retiredFiles(file)).toHaveLength(1);
	});
});

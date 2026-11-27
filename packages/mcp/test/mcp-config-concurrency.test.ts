import { fork, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { addMcpServerConfig } from "../src/config-write.ts";

const fixture = fileURLToPath(new URL("./fixtures/mcp-config-writer.mjs", import.meta.url));
const resolver = fileURLToPath(new URL("../../coding-agent/scripts/source-resolver.ts", import.meta.url));
const roots: string[] = [];
const children: ChildProcess[] = [];

afterEach(() => {
	for (const child of children.splice(0)) if (child.exitCode === null) child.kill("SIGKILL");
	for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

function writer(root: string, file: string, name: string, hold = false) {
	const child = fork(fixture, [file, name, path.join(root, "release"), hold ? "hold" : "run"], {
		execArgv: ["--no-warnings", "--import", resolver],
		env: { HOME: root, USERPROFILE: root, PATH: process.env.PATH },
		stdio: ["ignore", "pipe", "pipe", "ipc"],
	});
	children.push(child);
	let result: { ok: boolean; code?: string; message?: string } | undefined;
	let stderr = "";
	child.stderr?.on("data", (chunk) => (stderr += chunk));
	let read!: () => void;
	const didRead = new Promise<void>((resolve) => (read = resolve));
	child.on("message", (message: { phase: string; ok: boolean; code?: string; message?: string }) => {
		if (message.phase === "read") read();
		else if (message.phase === "result") result = message;
	});
	const exited = new Promise<number | null>((resolve) => child.once("exit", resolve));
	return { didRead, exited, result: () => result, stderr: () => stderr };
}

describe("MCP configuration writes across processes", () => {
	it("creates a missing target directory through a dangling config symlink", () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "mcp-config-concurrency-"));
		roots.push(root);
		const file = path.join(root, "mcp.json");
		const target = path.join(root, "new-directory", "mcp.json");
		fs.symlinkSync(target, file);
		addMcpServerConfig(file, "new", { command: "node" });
		expect(JSON.parse(fs.readFileSync(target, "utf8")).mcpServers.new.command).toBe("node");
		expect(fs.lstatSync(file).isSymbolicLink()).toBe(true);
	});

	it.each([false, true])("never loses a successful addition during contention (symlink alias: %s)", async (alias) => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "mcp-config-concurrency-"));
		roots.push(root);
		const file = path.join(root, "mcp.json");
		fs.writeFileSync(file, JSON.stringify({ keep: "metadata", mcpServers: { existing: { command: "node" } } }));
		const secondFile = alias ? path.join(root, "alias.json") : file;
		if (alias) fs.symlinkSync(file, secondFile);
		const first = writer(root, file, "first", true);
		await Promise.race([
			first.didRead,
			first.exited.then((code) => {
				throw new Error(`Held writer exited before reading (${code}): ${first.stderr()}`);
			}),
		]);
		const second = writer(root, secondFile, "second");
		await second.exited;
		fs.writeFileSync(path.join(root, "release"), "release held writer");
		expect(await first.exited, first.stderr()).toBe(0);
		expect(first.result()).toMatchObject({ ok: true });
		const saved = JSON.parse(fs.readFileSync(file, "utf8"));
		const successful = ["existing", "first", ...(second.result()?.ok ? ["second"] : [])].sort();
		expect(Object.keys(saved.mcpServers).sort()).toEqual(successful);
		if (!second.result()?.ok) expect(second.result(), second.stderr()).toMatchObject({ ok: false, code: "ELOCKED" });
		expect(saved.keep).toBe("metadata");
		if (alias) expect(fs.lstatSync(secondFile).isSymbolicLink()).toBe(true);
		expect(fs.existsSync(`${file}.lock`)).toBe(false);
	});
});

import { afterEach, expect, it } from "vitest";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { registerDebugTool } from "../../src/octocode/debug/tool.ts";
import { fakeCtx, fakeHost } from "./fake-host.ts";

const fixture = fileURLToPath(new URL("./fixtures/dap-adapter.mjs", import.meta.url));
const dirs: string[] = [];
const pids: number[] = [];

afterEach(() => {
	for (const pid of pids.splice(0)) {
		try {
			process.kill(pid, "SIGKILL");
		} catch {}
	}
	for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const alive = (pid: number) => {
	try {
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
};

async function launched(flags: string[]) {
	const dir = mkdtempSync(join(tmpdir(), "octocode-dap-shutdown-"));
	dirs.push(dir);
	const record = join(dir, "requests.log");
	const pidFile = join(dir, "debuggee.pid");
	const fake = fakeHost();
	registerDebugTool(fake.api);
	const ctx = fakeCtx({ cwd: process.cwd() });
	const result = await fake.tools.get("debug")!.execute(
		"launch",
		{
			action: "launch",
			adapter: process.execPath,
			adapterArgs: [fixture, `--record=${record}`, `--debuggee=${pidFile}`, ...flags],
			launch: { program: "fixture" },
		},
		undefined,
		undefined,
		ctx,
	);
	expect(JSON.parse(result.content[0].text)).toMatchObject({ state: "stopped" });
	const pid = Number(readFileSync(pidFile, "utf8"));
	pids.push(pid);
	expect(alive(pid)).toBe(true);
	const requests = () => readFileSync(record, "utf8").trim().split("\n");
	return { fake, ctx, pid, requests };
}

it.each(["session_shutdown", "session_before_switch", "session_before_fork"])(
	"asks the adapter to terminate the debuggee on %s before stopping it",
	async (event) => {
		const { fake, ctx, pid, requests } = await launched([]);
		await fake.emit(event, {}, ctx);
		expect(requests()).toContain("terminate");
		await expect.poll(() => alive(pid)).toBe(false);
	},
);

it("falls back to disconnect with terminateDebuggee when the adapter has no terminate request", async () => {
	const { fake, ctx, pid, requests } = await launched(["--no-terminate-request"]);
	await fake.emit("session_shutdown", {}, ctx);
	expect(requests()).toContain("disconnect:true");
	expect(requests()).not.toContain("terminate");
	await expect.poll(() => alive(pid)).toBe(false);
});

it("does not let an adapter that never answers hold up shutdown", async () => {
	const { fake, ctx, requests } = await launched(["--ignore-stop"]);
	const started = Date.now();
	await fake.emit("session_shutdown", {}, ctx);
	expect(Date.now() - started).toBeLessThan(5_000);
	expect(requests()).toContain("terminate");
});

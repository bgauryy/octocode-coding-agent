import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { reapOrphanGroups, recordProcessGroup } from "@octocodeai/octocode-common/process-group-records";
import { ENV_AGENT_DIR } from "../../src/config.ts";
import { reapForegroundGroups } from "../../src/octocode/files/bash-groups.ts";
import { groupAlive, processAlive } from "../../src/octocode/shared/process.ts";

const posix = process.platform !== "win32";
const made: string[] = [];
const groups: number[] = [];
const savedAgentDir = process.env[ENV_AGENT_DIR];

afterEach(() => {
	for (const pid of groups.splice(0))
		try {
			process.kill(-pid, "SIGKILL");
		} catch {
			/* Already gone. */
		}
	for (const dir of made.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
	if (savedAgentDir === undefined) delete process.env[ENV_AGENT_DIR];
	else process.env[ENV_AGENT_DIR] = savedAgentDir;
});

function tmp(): string {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bash-owners-"));
	made.push(dir);
	return dir;
}

async function until(check: () => boolean, ms = 5_000): Promise<void> {
	const deadline = Date.now() + ms;
	while (!check()) {
		if (Date.now() > deadline) throw new Error("timed out");
		await new Promise((resolve) => setTimeout(resolve, 50));
	}
}

/** A process group of its own that sleeps: `pid` leads it. */
function sleeper(): number {
	const child = spawn("/bin/sh", ["-c", "sleep 60 & wait"], { detached: true, stdio: "ignore" });
	child.unref();
	groups.push(child.pid!);
	return child.pid!;
}

describe.runIf(posix)("foreground bash groups of an Octocode that was SIGKILLed", () => {
	it("are recorded while the command runs and stopped by the next start", async () => {
		const agentDir = tmp();
		const marker = path.join(agentDir, "shell.pid");
		const script = path.join(agentDir, "run.ts");
		const module = new URL("../../src/octocode/files/bash-run.ts", import.meta.url).href;
		fs.writeFileSync(
			script,
			`import { foregroundOperations } from ${JSON.stringify(module)};\n` +
				`await foregroundOperations({}, () => undefined).exec(${JSON.stringify(`echo $$ > ${JSON.stringify(marker)}; sleep 60`)}, ${JSON.stringify(agentDir)}, { onData() {} });\n`,
		);
		const resolver = new URL("../../scripts/source-resolver.ts", import.meta.url).href;
		const owner = spawn(process.execPath, ["--no-warnings", "--import", resolver, script], {
			env: { ...process.env, [ENV_AGENT_DIR]: agentDir },
			stdio: "ignore",
		});
		const records = path.join(agentDir, "bash-group-owners");
		await until(() => fs.existsSync(marker) && fs.existsSync(records) && fs.readdirSync(records).length > 0, 10_000);
		const shell = Number(fs.readFileSync(marker, "utf8").trim());
		groups.push(shell);
		owner.kill("SIGKILL");
		await until(() => owner.exitCode !== null || owner.signalCode !== null);
		expect(groupAlive(shell)).toBe(true);

		process.env[ENV_AGENT_DIR] = agentDir;
		const reaped = await reapForegroundGroups();
		expect(reaped).toEqual([expect.objectContaining({ pid: shell, stopped: true })]);
		await until(() => !groupAlive(shell));
		expect(fs.readdirSync(records)).toEqual([]);
	}, 30_000);
});

describe.runIf(posix)("reaping recorded groups", () => {
	it("keeps the group of a live owner, even another Octocode's", async () => {
		const dir = tmp();
		const pid = sleeper();
		await recordProcessGroup(dir, pid, "live owner");
		expect(await reapOrphanGroups(dir)).toEqual([]);
		expect(groupAlive(pid)).toBe(true);
		expect(fs.readdirSync(dir)).toHaveLength(1);
	});

	it("keeps a group whose leader pid now names another process", async () => {
		const dir = tmp();
		const pid = sleeper();
		await recordProcessGroup(dir, pid, "reused");
		const file = path.join(dir, fs.readdirSync(dir)[0]);
		const record = JSON.parse(fs.readFileSync(file, "utf8"));
		// The owner is gone (a pid that cannot be running) and the leader's start differs: a reused pid.
		const dead = spawnSync(process.execPath, ["-e", "process.stdout.write(String(process.pid))"], { encoding: "utf8" });
		record.owner = { pid: Number(dead.stdout), started: "1" };
		record.started = String(Number(record.started) - 100);
		fs.writeFileSync(file, JSON.stringify(record));
		expect(processAlive(Number(dead.stdout))).toBe(false);
		expect(await reapOrphanGroups(dir)).toEqual([]);
		expect(groupAlive(pid)).toBe(true);
	});
});

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { afterAll, expect, test } from "vitest";
import { killEverything, sandbox, script, startEndpoint, until } from "../octocode/e2e-real-process-harness.ts";

const LEAK = path.resolve(import.meta.dirname, "../../../../.octocode/tmp/leak");
const OUT = path.join(LEAK, "combined");
const PROMPTS = Number(process.env.LEAK_PROMPTS ?? 50);
afterAll(() => killEverything());

const snaps = () => fs.readdirSync(OUT).filter((f) => f.endsWith(".heapsnapshot"));
/** CPU seconds of a process (user+sys), from ps. */
const cpuOf = (pid: number): number => {
	const t = execFileSync("ps", ["-o", "time=", "-p", String(pid)]).toString().trim();
	const parts = t.split(":").map(Number);
	return parts.reduce((acc, v) => acc * 60 + v, 0);
};

test("combined profile", async () => {
	fs.mkdirSync(OUT, { recursive: true });
	const endpoint = await startEndpoint();
	const box = sandbox(endpoint);
	box.env.LEAK_DIR = path.join(OUT, "samples");
	box.env.PROFILE_MS = "5000";
	box.env.NODE_OPTIONS = [
		"--expose-gc",
		`--import ${path.join(LEAK, "heap-sampler.mjs")}`,
		"--heapsnapshot-signal=SIGUSR2",
		`--diagnostic-dir=${OUT}`,
		"--cpu-prof",
		`--cpu-prof-dir=${path.join(OUT, "cpu")}`,
	].join(" ");
	const run = box.start(["--mode", "rpc"], { stdin: "pipe" });
	await until(() => run.stdout().includes('"rpc_ready"'), "rpc_ready", 180000);
	const pid = run.process.pid!;
	// Incremental: scan only output added since the last check.
	const TOKEN = '"type":"agent_settled"';
	let pos = 0;
	let settled = 0;
	const poll = () => {
		const out = run.stdout();
		for (let at = out.indexOf(TOKEN, pos); at !== -1; at = out.indexOf(TOKEN, pos)) {
			settled++;
			pos = at + TOKEN.length;
		}
		pos = Math.max(pos, out.length - TOKEN.length);
		return settled;
	};
	const snapshot = async (label: string) => {
		const before = new Set(snaps());
		run.process.kill("SIGUSR2");
		await until(() => snaps().some((f) => !before.has(f)), "snapshot file", 300000);
		const file = snaps().find((f) => !before.has(f))!;
		let last = -1;
		for (;;) {
			await new Promise((r) => setTimeout(r, 3000));
			const size = fs.statSync(path.join(OUT, file)).size;
			if (size > 0 && size === last) break;
			last = size;
		}
		fs.renameSync(path.join(OUT, file), path.join(OUT, `${label}.heapsnapshot`));
	};
	const rows: string[] = [];
	const testCpu0 = process.cpuUsage();
	for (let n = 1; n <= PROMPTS; n++) {
		const steps = Array.from({ length: 15 }, (_, i) => ({
			tool: "bash",
			args: { command: `echo p${n}-${i} && seq 1 2000 | tail -1` },
		}));
		const before = poll();
		const bytes0 = run.stdout().length;
		const t0 = Date.now();
		const cli0 = cpuOf(pid);
		run.process.stdin!.write(
			`${JSON.stringify({ id: `p${n}`, type: "prompt", message: script([...steps, { text: `prompt ${n} done` }]) })}\n`,
		);
		try {
			await until(() => poll() > before, "agent_settled", 180000);
		} catch (error) {
			fs.writeFileSync(path.join(OUT, "stall.out"), `${run.stdout().slice(-4000)}\n---stderr\n${run.stderr().slice(-3000)}`);
			throw error;
		}
		const tc = process.cpuUsage(testCpu0);
		rows.push(
			JSON.stringify({
				n,
				ms: Date.now() - t0,
				stdoutBytes: run.stdout().length - bytes0,
				cliCpuS: +(cpuOf(pid) - cli0).toFixed(2),
				testCpuS: +((tc.user + tc.system) / 1e6).toFixed(2),
				endpointRequests: endpoint.requests.length,
			}),
		);
		fs.writeFileSync(path.join(OUT, "prompts.jsonl"), `${rows.join("\n")}\n`);
		if (n === 10) await snapshot("after10");
		if (n === PROMPTS) await snapshot(`after${PROMPTS}`);
	}
	run.process.kill("SIGINT");
	await until(() => run.process.exitCode !== null || run.process.signalCode !== null, "exit", 60000);
	expect(snaps().length).toBe(2);
}, 3_000_000);

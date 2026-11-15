import fs from "node:fs";
import path from "node:path";
import { expect, it, vi } from "vitest";
import { HEADLESS_ARGS, headlessTurn } from "../../src/octocode/external/runner-headless.ts";
import { processAlive, processStartTimeAsync, sameProcessAsync } from "../../src/octocode/shared/process.ts";
import * as descendants from "../../src/octocode/shared/process-descendants.ts";
import * as processes from "../../src/octocode/shared/process.ts";
import { tmp } from "./helpers.ts";

it("does not start a runner cancelled while its process tree is being prepared", async () => {
	const prepared = Promise.withResolvers<void>();
	const preparation = vi.spyOn(processes, "prepareTree").mockReturnValue(prepared.promise);
	const controller = new AbortController();
	const onStart = vi.fn();
	const cwd = tmp("octocode-headless-cancel-prepare-");
	const reply = headlessTurn({
		runner: "claude-code",
		command: process.execPath,
		args: ["-e", "process.stdin.resume()", "--"],
		cwd,
		sessionCwd: cwd,
		text: "cancelled task",
		signal: controller.signal,
		onActivity: () => undefined,
		awake: () => undefined,
		onStart,
	});
	void reply.catch(() => undefined);
	try {
		controller.abort(new Error("cancelled during preparation"));
		prepared.resolve();
		await expect(reply).rejects.toThrow("cancelled during preparation");
		expect(onStart).not.toHaveBeenCalled();
	} finally {
		prepared.resolve();
		await reply.catch(() => undefined);
		preparation.mockRestore();
	}
});

it.skipIf(process.platform === "win32")(
	"retains a detached helper created by the task before the headless CLI exits",
	async () => {
		const cwd = tmp("octocode-headless-ownership-");
		const script = path.join(cwd, "peer.cjs");
		const journal = path.join(cwd, "helper.json");
		const release = path.join(cwd, "release");
		const eof = path.join(cwd, "eof");
		fs.writeFileSync(
			script,
			`
const fs = require("node:fs");
const { spawn } = require("node:child_process");
const streaming = process.argv.includes("--input-format");
let task = "", started = false;
function run() {
  if (started) return; started = true;
  const helper = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { detached: true, stdio: "ignore" });
  helper.unref();
  fs.writeFileSync(${JSON.stringify(journal)}, JSON.stringify({ root: process.pid, helper: helper.pid }));
  const wait = setInterval(() => {
    if (!fs.existsSync(${JSON.stringify(release)})) return;
    clearInterval(wait);
    process.stdout.write(JSON.stringify({ type: "result", subtype: "success", result: "owned reply" }) + "\\n", () => {
      if (!streaming) process.exit(0);
    });
  }, 5);
}
process.stdin.on("data", chunk => { task += chunk; if (streaming && task.includes("\\n")) run(); });
process.stdin.on("end", () => { fs.writeFileSync(${JSON.stringify(eof)}, "eof"); if (streaming) process.exit(0); else run(); });
`,
		);
		const controller = new AbortController();
		const captured = Promise.withResolvers<void>();
		const finishCapture = Promise.withResolvers<void>();
		const realCapture = descendants.descendantRows;
		const capture = vi.spyOn(descendants, "descendantRows").mockImplementation(async (pid) => {
			const rows = await realCapture(pid);
			captured.resolve();
			await finishCapture.promise;
			return rows;
		});
		const reply = headlessTurn({
			runner: "claude-code",
			command: process.execPath,
			args: [script, ...HEADLESS_ARGS],
			cwd,
			sessionCwd: cwd,
			text: "create the helper",
			signal: controller.signal,
			onActivity: () => undefined,
			awake: () => undefined,
		});
		void reply.catch(() => undefined);
		let helper: number | undefined;
		let identity: string | undefined;
		try {
			await expect.poll(() => fs.existsSync(journal)).toBe(true);
			const owned = JSON.parse(fs.readFileSync(journal, "utf8")) as { root: number; helper: number };
			helper = owned.helper;
			identity = await processStartTimeAsync(helper);
			expect(identity).toBeDefined();
			fs.writeFileSync(release, "finish");
			await captured.promise;
			expect(processAlive(owned.root)).toBe(true);
			expect(fs.existsSync(eof)).toBe(false);
			finishCapture.resolve();
			expect((await reply).text).toBe("owned reply");
			expect(fs.existsSync(eof)).toBe(true);
			expect(processAlive(helper)).toBe(false);
		} finally {
			finishCapture.resolve();
			controller.abort();
			await reply.catch(() => undefined);
			capture.mockRestore();
			if (helper && identity && (await sameProcessAsync(helper, identity))) process.kill(helper, "SIGKILL");
			if (helper) await expect.poll(() => processAlive(helper)).toBe(false);
		}
	},
);

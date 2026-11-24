import fs from "node:fs";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import type * as NativeConfig from "../../src/config.ts";
import { processAlive } from "../../src/octocode/shared/process.ts";
import { runSubagent } from "../../src/octocode/subagents/process.ts";
import { exitReason, USER_STOP } from "../../src/octocode/subagents/process/outcome.ts";
import { tmp } from "./helpers.ts";
import { reportOf, setup, useScriptedChild } from "./subagent-tool-harness.ts";

vi.mock("../../src/config.ts", async (original) => ({
	...(await original<typeof NativeConfig>()),
	getCliInvocation: () => ({ command: process.execPath, prefix: [process.argv[1]] }),
}));

useScriptedChild({ trustTemp: true });

describe("runSubagent", () => {
	it.skipIf(process.platform === "win32")(
		"settles a cancelled run only once its tree is gone, including a detached helper the child left running",
		async () => {
			const controller = new AbortController();
			let helper = 0;
			const run = runSubagent({
				task: "detached helper",
				args: [],
				cwd: tmp(),
				identity: { id: "a-helper" },
				signal: controller.signal,
				onProgress: ({ activity }) => {
					const pid = Number(
						/"helper":(\d+)/.exec(activity ?? "")?.[1] ?? /helper[^\d]*(\d+)/.exec(activity ?? "")?.[1],
					);
					if (pid) helper = pid;
				},
			});
			await vi.waitFor(() => expect(helper).toBeGreaterThan(0));
			try {
				controller.abort();
				await expect(run).rejects.toThrow("Subagent cancelled");
				expect(processAlive(helper)).toBe(false);
			} finally {
				try {
					process.kill(helper, "SIGKILL");
				} catch {
					/* Already exited. */
				}
			}
		},
		20_000,
	);

	describe.skipIf(process.platform === "win32")("after a natural exit", () => {
		// A stand-in `octocode` that answers, leaves a holder in its own process group (like an MCP or dev server) and exits.
		const withScript = async (body: string, run: (holderFile: string) => Promise<void>) => {
			const dir = tmp();
			const holderFile = path.join(dir, "holder.pid");
			const script = path.join(dir, "octocode");
			fs.writeFileSync(script, `const { spawn } = require('node:child_process');\n${body}`);
			const before = process.argv[1];
			process.argv[1] = script;
			process.env.TEST_HOLDER_FILE = holderFile;
			try {
				await run(holderFile);
			} finally {
				process.argv[1] = before!;
				delete process.env.TEST_HOLDER_FILE;
				try {
					process.kill(Number(fs.readFileSync(holderFile, "utf8")), "SIGKILL");
				} catch {
					/* Gone, or never started. */
				}
			}
		};
		const holder = `
      const holder = spawn(process.execPath, ['-e', 'setInterval(() => undefined, 1000)'], { stdio: 'ignore' });
      holder.unref();
      require('node:fs').writeFileSync(process.env.TEST_HOLDER_FILE, String(holder.pid));
      const usage = { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { total: 0 } };
      process.stdout.write(JSON.stringify({ type: 'message_end', message: { role: 'assistant', content: [{ type: 'text', text: 'DONE' }], usage, stopReason: 'stop' } }) + '\\n');
    `;

		it("stops what the child left in its process group before the run settles", async () => {
			await withScript(holder, async (holderFile) => {
				const outcome = await runSubagent({
					task: "go",
					args: [],
					cwd: tmp(),
					identity: { id: "a-holder" },
					onProgress: () => undefined,
				});
				expect(outcome.text).toBe("DONE");
				// The run has settled: the holder it left behind is already gone, so a worktree removal now races nothing.
				expect(processAlive(Number(fs.readFileSync(holderFile, "utf8")))).toBe(false);
			});
		}, 20_000);
	});

	it("terminates the child when recording its launch fails", async () => {
		let pid = 0;
		await expect(
			runSubagent({
				task: "slow launch",
				args: [],
				cwd: tmp(),
				identity: { id: "a-launch-failure" },
				onProgress: () => undefined,
				onSpawn: (childPid) => {
					pid = childPid;
					throw new Error("cannot record launch");
				},
			}),
		).rejects.toThrow("cannot record launch");
		try {
			expect(() => process.kill(pid, 0)).toThrow();
		} finally {
			try {
				process.kill(pid, "SIGKILL");
			} catch {
				/* Already exited. */
			}
		}
	});

	it("rejects oversized unterminated events instead of buffering them without limit", async () => {
		await expect(
			runSubagent({
				task: "oversized",
				args: [],
				cwd: tmp(),
				identity: { id: "a-oversized" },
				onProgress: () => undefined,
			}),
		).rejects.toThrow(/JSON event exceeds/);
	});

	it("bounds the returned report while preserving the complete text in scratch", async () => {
		const scratch = tmp();
		const outcome = await runSubagent({
			task: "long report",
			args: [],
			cwd: tmp(),
			identity: { id: "a-bounded", scratch },
			onProgress: () => undefined,
		});
		expect(Buffer.byteLength(outcome.text)).toBeLessThan(9 * 1024);
		expect(outcome.text).toContain("Full report:");
		expect(fs.readFileSync(path.join(scratch, "report.md"), "utf8")).toMatch(/the end$/);
	});

	it("keeps the pointer to the saved partial report in a crash error, however long the narration was", async () => {
		const scratch = tmp();
		const error = await runSubagent({
			task: "long narrate then crash",
			args: [],
			cwd: tmp(),
			identity: { id: "a-crash", scratch },
			onProgress: () => undefined,
		}).then(
			() => undefined,
			(e: Error) => e,
		);
		// The pattern is split at the trim marker only so this source does not contain Octocode's own output placeholder.
		const head = /^Subagent exited with code 3: segfault\nLast progress: progress detail .*\n\[Output trimmed: /;
		const tail = /[^\]]+\]\nFull partial report: .*partial-report\.md/;
		expect(error?.message).toMatch(new RegExp(head.source + tail.source, "s"));
		expect(fs.readFileSync(path.join(scratch, "partial-report.md"), "utf8")).toMatch(/the end$/);
	});

	it("streams the gist of its thinking and keeps thoughts and narration as steps", async () => {
		const seen: Array<{ step?: string; thinking?: string; activity?: string }> = [];
		const outcome = await runSubagent({
			task: "think aloud",
			args: [],
			cwd: tmp(),
			identity: { id: "a-think" },
			onProgress: ({ step, thinking, activity }) =>
				seen.push({
					...(step ? { step } : {}),
					...(thinking !== undefined ? { thinking } : {}),
					...(activity ? { activity } : {}),
				}),
		});
		expect(outcome.text).toBe("THE ANSWER");
		expect(seen.filter((update) => Object.keys(update).length > 0)).toEqual([
			{ thinking: "Locating the bug" },
			{ thinking: "The token refresh runs twice." },
			{ step: "✻ Check the lock" },
			{ step: "› Let me read src/auth.ts" },
			{ thinking: "" },
			{ activity: "→ read src/auth.ts" },
			{ thinking: "" },
			// The answer to the one question about the outcome word its report lacks.
			{ thinking: "" },
		]);
	});

	it("rejects at once when already aborted", async () => {
		const controller = new AbortController();
		controller.abort();
		await expect(
			runSubagent({
				task: "x",
				args: [],
				cwd: tmp(),
				identity: { id: "a-0000" },
				signal: controller.signal,
				onProgress: () => undefined,
			}),
		).rejects.toThrow("Subagent cancelled");
	});

	it("reports the child pid and parses a final line without a newline", async () => {
		const pids: number[] = [];
		const outcome = await runSubagent({
			task: "report",
			args: [],
			cwd: tmp(),
			identity: { id: "a-0001", goal: "t", workspace: "/w" },
			onProgress: () => undefined,
			onSpawn: (pid) => pids.push(pid),
		});
		expect(pids).toHaveLength(1);
		expect(reportOf(outcome.text).id).toBe("a-0001");
		expect(outcome.usage.input).toBe(100);
	});

	it("propagates the latest outcome to foreground and background results", async () => {
		const s = setup();
		const foreground = await s.run({ task: "changed outcome" });
		expect(foreground.details.outcome).toBe("blocked");
		expect(foreground.details.reportArtifact).toEqual({ sha256: expect.stringMatching(/^[a-f0-9]{64}$/) });
		expect(foreground.content[0].text).toMatch(/^Subagent (\S+) reported blocked · ran on [^\n]+ · cite as report:\1:/);
		await s.run({ task: "changed outcome", background: true });
		await vi.waitFor(() => expect(s.sent).toHaveLength(1));
		expect(s.sent[0].message.details.outcome).toBe("blocked");
		expect(s.sent[0].message.details.reportArtifact).toEqual(foreground.details.reportArtifact);
		expect(s.sent[0].message.content).toContain("reported blocked");
	});

	it("keeps the report when a late notice wakes the child after it answered", async () => {
		const outcome = await runSubagent({
			task: "late notice",
			args: [],
			cwd: tmp(),
			identity: { id: "a-0003" },
			onProgress: () => undefined,
		});
		expect(outcome.text).toBe("FULL REPORT\n\n---\n\nThat job was my coverage rerun; findings unchanged.");
		expect(outcome.error).toBeUndefined();
	});

	it("propagates a failed follow-up while preserving the prior report", async () => {
		const outcome = await runSubagent({
			task: "late failure",
			args: [],
			cwd: tmp(),
			identity: { id: "a-0004" },
			onProgress: () => undefined,
		});
		expect(outcome.text).toBe("FULL REPORT\n\n---\n\n(A later follow-up turn failed: overloaded)");
		expect(outcome.error).toBe("overloaded");
	});

	it("never keeps a failed draft as a report section", async () => {
		const outcome = await runSubagent({
			task: "steered draft",
			args: [],
			cwd: tmp(),
			identity: { id: "a-0005" },
			onProgress: () => undefined,
		});
		expect(outcome.text).toBe("FINAL REPORT");
		expect(outcome.error).toBeUndefined();
	});

	it.skipIf(process.platform === "win32")(
		"settles shortly after the child exits even when an escaped grandchild holds its pipes open",
		async () => {
			const started = Date.now();
			const outcome = await runSubagent({
				task: "orphan holder",
				args: [],
				cwd: tmp(),
				identity: { id: "a-orphan" },
				onProgress: () => undefined,
			});
			expect(outcome.text).toBe("ORPHAN REPORT");
			expect(Date.now() - started).toBeLessThan(5_000);
		},
		15_000,
	);

	it("keeps running when the progress callback throws", async () => {
		const outcome = await runSubagent({
			task: "report",
			args: [],
			cwd: tmp(),
			identity: { id: "a-0002" },
			onProgress: () => {
				throw new Error("render gone");
			},
		});
		expect(reportOf(outcome.text).id).toBe("a-0002");
	});
});

describe("subagent watchdog and exits", () => {
	/**
	 * Starts `task`, waits until the child shows it is busy (its first progress), lets `ms` pass on a fake clock for the
	 * watchdog (its interval and `Date`; the child and its pipes stay real), then aborts and returns how the run ended.
	 * A watchdog stop rejects with "Subagent stopped", so the outcome says whether it fired before the abort.
	 */
	const runThenAbort = async (task: string, id: string, ms: number, limits: { idleMs: number; busyMs: number }) => {
		vi.useFakeTimers({ toFake: ["setInterval", "clearInterval", "Date"] });
		try {
			const controller = new AbortController();
			let busy!: () => void;
			const started = new Promise<void>((resolve) => {
				busy = resolve;
				return undefined;
			});
			const run = runSubagent({
				task,
				args: [],
				cwd: tmp(),
				identity: { id },
				signal: controller.signal,
				onProgress: () => busy(),
				limits,
			});
			const outcome = Promise.allSettled([run]);
			await started;
			await vi.advanceTimersByTimeAsync(ms);
			vi.useRealTimers();
			controller.abort();
			return (await outcome)[0];
		} finally {
			vi.useRealTimers();
		}
	};

	it("treats a child settling after its answer as busy: no watchdog stop, and the answer stays", async () => {
		// Four idle limits pass while it settles. The answer was complete before the abort: it is kept, and says the run did not settle.
		expect(
			await runThenAbort("answer then stalled shutdown", "a-shutdown", 1_200, { idleMs: 300, busyMs: 60_000 }),
		).toMatchObject({
			status: "fulfilled",
			value: { text: "COMPLETED REPORT", error: "Subagent cancelled before its run settled" },
		});
	});

	it("kills a child that emits nothing for the idle limit and says what it last did", async () => {
		await expect(
			runSubagent({
				task: "hang",
				args: [],
				cwd: tmp(),
				identity: { id: "a-hang" },
				onProgress: () => undefined,
				limits: {
					idleMs: 300,
					busyMs: 60_000,
				},
			}),
		).rejects.toThrow(
			/^Subagent stopped: no output for .*; last activity: started, .* ago\. Its process tree was killed\.$/,
		);
	});

	it("never stops a child for a silent running tool (the tool has its own deadline) nor for its run time", async () => {
		expect(await runThenAbort("slow tool", "a-slow", 1_500, { idleMs: 300, busyMs: 60_000 })).toMatchObject({
			status: "rejected",
			reason: { message: "Subagent cancelled" },
		});
	});

	it("stops a busy child once a call runs past its own deadline (busyMs when it declares none)", async () => {
		// On the watchdog's fake clock, like runThenAbort: the idle limit counts from spawn, so on a real clock a child that
		// takes longer than `idleMs` to start (a loaded machine) is stopped as idle before its tool call is ever seen.
		vi.useFakeTimers({ toFake: ["setInterval", "clearInterval", "Date"] });
		try {
			let busy!: () => void;
			const started = new Promise<void>((resolve) => {
				busy = resolve;
				return undefined;
			});
			const run = runSubagent({
				task: "slow tool",
				args: [],
				cwd: tmp(),
				identity: { id: "a-slow-hung" },
				onProgress: () => busy(),
				limits: { idleMs: 200, busyMs: 200 },
			});
			const outcome = Promise.allSettled([run]);
			await started;
			await vi.advanceTimersByTimeAsync(1_000); // past the call's deadline (busyMs + idleMs) and a watchdog tick
			vi.useRealTimers();
			const settled = (await outcome)[0];
			expect(settled.status).toBe("rejected");
			expect((settled as PromiseRejectedResult).reason.message).toMatch(
				/^Subagent stopped: → bash sleep 60 ran past its own deadline; last output .* ago\. Its process tree was killed\.$/,
			);
		} finally {
			vi.useRealTimers();
		}
	});

	it.skipIf(process.platform === "win32")(
		"gives a stop the user asked for a short grace: a child ignoring SIGTERM is killed in about a second",
		async () => {
			const controller = new AbortController();
			let ignoring!: () => void;
			const ignores = new Promise<void>((resolve) => {
				ignoring = resolve;
				return undefined;
			});
			const run = runSubagent({
				task: "stubborn",
				args: [],
				cwd: tmp(),
				identity: { id: "a-stubborn" },
				signal: controller.signal,
				onProgress: () => ignoring(),
			});
			// The child reported that it ignores SIGTERM: only now is a stop a test of the grace.
			await ignores;
			const started = Date.now();
			controller.abort(USER_STOP);
			await expect(run).rejects.toThrow("Subagent cancelled");
			expect(Date.now() - started).toBeLessThan(3_000);
		},
		10_000,
	);

	it('names the signal that killed a child instead of "code null"', () => {
		expect(exitReason(null, "SIGTERM")).toBe("was killed by SIGTERM");
		expect(exitReason(3, null)).toBe("exited with code 3");
	});

	it("lets /agents kill stop a foreground run without aborting the turn", async () => {
		const s = setup();
		const running = s.run({ task: "slow foreground" });
		let id = "";
		await vi.waitFor(async () => {
			await s.commands.get("agents").handler("kill", s.ctx);
			id = /Running: (\S+)/.exec(s.ctx.ui.notes.at(-1)!.message)?.[1] ?? "";
			expect(id).not.toBe("");
		});
		await s.commands.get("agents").handler(`kill ${id}`, s.ctx);
		await expect(running).rejects.toThrow(`Subagent ${id} was stopped by the user.`);
	}, 15_000);
});

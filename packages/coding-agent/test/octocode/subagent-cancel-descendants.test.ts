import fs from "node:fs";
import path from "node:path";
import { expect, it, vi } from "vitest";
import type * as NativeConfig from "../../src/config.ts";
import type * as ProcessTable from "../../src/octocode/shared/process-table.ts";
import { processAlive } from "../../src/octocode/shared/process.ts";
import { runSubagent } from "../../src/octocode/subagents/process.ts";
import { tmp } from "./helpers.ts";

const observed = vi.hoisted(() => ({ root: 0, helper: 0, samples: [] as ProcessTable.ProcessRow[][] }));

vi.mock("../../src/config.ts", async (original) => ({
	...(await original<typeof NativeConfig>()),
	getCliInvocation: () => ({ command: process.execPath, prefix: [process.argv[1]] }),
}));
vi.mock("../../src/octocode/shared/process-table.ts", async (original) => {
	const real = await original<typeof ProcessTable>();
	return {
		...real,
		readProcessTable: async () => {
			const table = await real.readProcessTable();
			if (observed.helper && table) observed.samples.push([...table.rows.values()]);
			return table;
		},
	};
});

it.skipIf(process.platform === "win32").each(["abort", "natural", "abrupt"] as const)(
	"%s: retains ownership of detached descendants until cleanup",
	async (mode) => {
		observed.root = 0;
		observed.helper = 0;
		observed.samples = [];
		const cwd = tmp("octocode-abort-descendants-");
		const script = path.join(cwd, "child.cjs");
		const events = path.join(cwd, "events.log");
		fs.writeFileSync(
			script,
			`
const fs = require("node:fs"), {spawn} = require("node:child_process");
const emit = event => process.stdout.write(JSON.stringify(event) + "\\n");
let buffer = "";
process.stdin.setEncoding("utf8").on("data", chunk => {
 buffer += chunk;
 for (let at; (at = buffer.indexOf("\\n")) >= 0;) {
  const command = JSON.parse(buffer.slice(0, at)); buffer = buffer.slice(at + 1);
  if (command.type === "prompt") {
   emit({type:"response", command:"prompt", success:true, data:{disposition:"started"}});
   emit({type:"agent_start"});
   const helper = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {detached:true, stdio:"ignore"});
   helper.unref();
	   helper.once("spawn", async () => {
	    if (${mode === "abrupt"}) {
	     const {recordShellGroup} = await import(${JSON.stringify(new URL("../../src/octocode/shared/shell-groups.ts", import.meta.url).href)});
	     recordShellGroup(helper.pid);
	    }
    emit({type:"tool_execution_start", toolName:"bash", args:{command:"helper " + helper.pid}});
    if (command.message.includes("natural")) {
     emit({type:"message_end",message:{role:"assistant",content:[{type:"text",text:"done: finished"}],stopReason:"stop"}});
     emit({type:"agent_settled"});
    }
   });
  } else if (command.type === "abort") {
	   fs.appendFileSync(${JSON.stringify(events)}, "abort " + JSON.stringify(command) + "\\n");
   emit({type:"agent_settled", aborted:true});
	   if (!command.holdShutdown || ${mode === "abrupt"}) process.exit(0);
  }
 }
});
process.stdin.on("end", () => { fs.appendFileSync(${JSON.stringify(events)}, "stdin-end\\n"); process.exit(0); });
`,
		);
		const savedArgv = process.argv[1];
		process.argv[1] = script;
		const controller = new AbortController();
		const run = runSubagent({
			task: `work ${mode}`,
			args: [],
			cwd,
			identity: { id: "cancel-descendants" },
			signal: controller.signal,
			onSpawn: (pid) => {
				observed.root = pid;
			},
			onProgress: ({ activity }) => {
				const pid = Number(/helper[^\d]*(\d+)/.exec(activity ?? "")?.[1]);
				if (pid) observed.helper = pid;
			},
		});
		try {
			await vi.waitFor(() => expect(observed.helper).toBeGreaterThan(0), { timeout: 10_000 });
			if (mode !== "natural") {
				controller.abort();
				await expect(run).rejects.toThrow("Subagent cancelled");
			} else expect((await run).text).toContain("done: finished");
			expect(fs.readFileSync(events, "utf8")).toContain(mode === "natural" ? "stdin-end" : '"holdShutdown":true');
			if (mode !== "abrupt")
				expect(observed.samples[0]?.find((row) => row.pid === observed.helper)).toMatchObject({ ppid: observed.root });
			expect(processAlive(observed.helper)).toBe(false);
		} finally {
			if (process.env.OCTOCODE_TEST_CANCEL_EVIDENCE)
				fs.writeFileSync(
					process.env.OCTOCODE_TEST_CANCEL_EVIDENCE,
					JSON.stringify(
						{
							root: observed.root,
							helper: observed.helper,
							helperAlive: processAlive(observed.helper),
							samples: observed.samples.map((rows) =>
								rows.filter((row) => row.pid === observed.root || row.pid === observed.helper),
							),
						},
						null,
						2,
					),
				);
			controller.abort();
			await run.catch(() => undefined);
			process.argv[1] = savedArgv!;
			for (const pid of [observed.helper, observed.root]) {
				try {
					process.kill(pid, "SIGKILL");
				} catch {
					/* Already exited. */
				}
			}
			await vi.waitFor(() => expect([observed.helper, observed.root].filter(processAlive)).toEqual([]), {
				timeout: 2_000,
			});
		}
	},
	20_000,
);

import { spawn } from "node:child_process";
import { once } from "node:events";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, expect, it } from "vitest";
import { getCliInvocation } from "../src/config.ts";
import { createSandbox, QUIET_ARGS, type Sandbox } from "./helpers/feature-host-cli.ts";

let sandbox: Sandbox | undefined;
afterEach(() => sandbox?.cleanup());

/**
 * A preload that throws from a timer once the CLI has installed its crash handler: the same uncaught exception a bug
 * during startup would raise, with no hook in the product.
 */
const PRELOAD = `
const timer = setInterval(() => {
	if (process.listenerCount("uncaughtException") === 0) return;
	clearInterval(timer);
	throw new Error("forced crash sk-ant-api03-abcdefghijklmnopqrstuvwxyz0123456789\\nat secret stack");
}, 1);
`;

const MODES: { name: string; args: string[]; protocolStdout: boolean }[] = [
	{ name: "print", args: ["--print", "hello"], protocolStdout: false },
	{ name: "json", args: ["--mode", "json", "--print", "hello"], protocolStdout: false },
	{ name: "rpc", args: ["--mode", "rpc"], protocolStdout: true },
	{ name: "acp", args: ["--mode", "acp"], protocolStdout: true },
];

it.each(MODES)(
	"ends a $name run that crashes at startup with one redacted error line and exit code 1",
	async ({ args, protocolStdout }) => {
		sandbox = createSandbox();
		const preload = join(sandbox.directory, "crash-preload.mjs");
		writeFileSync(preload, PRELOAD);
		const invocation = getCliInvocation();
		const child = spawn(invocation.command, [...invocation.prefix, ...args, ...QUIET_ARGS], {
			cwd: sandbox.project,
			stdio: ["pipe", "pipe", "pipe"],
			env: {
				...sandbox.env,
				NODE_OPTIONS: `${process.env.NODE_OPTIONS ?? ""} --import ${pathToFileURL(preload).href}`.trim(),
			},
		});
		let stderr = "";
		let stdout = "";
		child.stderr.setEncoding("utf8").on("data", (chunk) => (stderr += chunk));
		child.stdout.setEncoding("utf8").on("data", (chunk) => (stdout += chunk));
		const timer = setTimeout(() => child.kill("SIGKILL"), 50_000);
		try {
			const [code] = (await once(child, "close")) as [number | null];
			expect(code).toBe(1);
			const lines = stderr.split("\n").filter((line) => line.trim() !== "");
			expect(lines).toHaveLength(1);
			expect(lines[0]).toContain("Octocode stopped on an unexpected error (uncaughtException): forced crash");
			expect(stderr).not.toContain("sk-ant-api03");
			expect(stderr).not.toContain("secret stack");
			expect(stderr).not.toMatch(/\n\s+at /);
			if (protocolStdout) {
				expect(stdout).not.toContain("Octocode stopped");
				expect(stdout).not.toContain("sk-ant-api03");
			}
		} finally {
			clearTimeout(timer);
		}
	},
	60_000,
);

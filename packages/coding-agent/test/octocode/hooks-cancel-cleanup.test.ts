import fs from "node:fs";
import path from "node:path";
import { expect, it, vi } from "vitest";
import { runHook } from "../../src/octocode/hooks/runner.ts";
import { tmp } from "./helpers.ts";

it.skipIf(process.platform === "win32")(
	"waits for a SIGTERM-resistant owned descendant before returning an aborted hook",
	async () => {
		const root = tmp("hook-cancel-cleanup-");
		const marker = path.join(root, "pid"),
			release = path.join(root, "release"),
			script = path.join(root, "child.cjs");
		const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;
		fs.writeFileSync(
			script,
			`const fs=require('node:fs');process.on('SIGTERM',()=>{});fs.writeFileSync(${JSON.stringify(marker)},String(process.pid));setInterval(()=>{if(fs.existsSync(${JSON.stringify(release)}))process.exit(0)},10);`,
		);
		const controller = new AbortController();
		const pending = runHook(
			{ command: `${quote(process.execPath)} ${quote(script)} & wait`, timeoutMs: 10000, source: "test" },
			{},
			root,
			{},
			controller.signal,
		);
		try {
			await vi.waitFor(() => expect(fs.existsSync(marker)).toBe(true));
			const pid = Number(fs.readFileSync(marker, "utf8"));
			expect(() => process.kill(pid, 0)).not.toThrow();
			controller.abort();
			expect(await pending).toMatchObject({ timedOut: false });
			expect(() => process.kill(pid, 0)).toThrow();
		} finally {
			fs.writeFileSync(release, "");
			controller.abort();
			await pending;
		}
	},
);

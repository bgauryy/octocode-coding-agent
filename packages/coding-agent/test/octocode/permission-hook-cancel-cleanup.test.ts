import fs from "node:fs";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { fixture } from "./permission-session-fixture.ts";

afterEach(() => vi.unstubAllEnvs());

it("finishes owned permission-hook shutdown before an aborted file batch returns", async () => {
	const f = await fixture("claude", { hold: true });
	try {
		const first = path.join(f.cwd, "first.txt"),
			second = path.join(f.cwd, "second.txt");
		const script = path.join(f.root, "hook.cjs"),
			ready = path.join(f.root, "second-ready");
		// The later hook requires SIGKILL; cancellation must still report no surviving owned process.
		fs.writeFileSync(
			script,
			"process.on('SIGTERM',()=>{});" +
				fs
					.readFileSync(script, "utf8")
					.replace(
						"if(true){",
						`if(JSON.parse(s).tool_input.file_path.endsWith('second.txt')){fs.writeFileSync(${JSON.stringify(ready)},String(process.pid));`,
					),
		);
		const childScript = path.join(f.root, "child-hook.cjs");
		fs.renameSync(script, childScript);
		fs.writeFileSync(
			script,
			`require('node:child_process').spawn(process.execPath, [${JSON.stringify(childScript)}], {stdio:'inherit'}).on('exit', code => { process.exitCode=code; });`,
		);
		const running = f.run("file", {
			queries: [first, second].map((target) => ({
				type: "write",
				path: target,
				content: "ORIGINAL",
				reason: "Cancellation cleanup",
			})),
		});
		await vi.waitFor(() => expect(fs.existsSync(ready)).toBe(true));
		expect(f.inputs().map((input) => input.tool_input.file_path)).toContain(first);
		expect(f.inputs().map((input) => input.tool_input.file_path)).toContain(second);
		const pid = Number(fs.readFileSync(ready, "utf8"));
		expect(() => process.kill(pid, 0)).not.toThrow();
		await f.session.abort();
		expect(() => process.kill(pid, 0)).toThrow();
		await running;
		expect(fs.existsSync(first)).toBe(false);
		expect(fs.existsSync(second)).toBe(false);
		expect(f.providerRequests).toBe(1);
		expect(() => process.kill(pid, 0)).toThrow();
	} finally {
		fs.writeFileSync(path.join(f.root, "release"), "");
		await f.close();
	}
});

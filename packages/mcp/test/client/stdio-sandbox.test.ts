import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { installMcpHost, type McpSandboxPort } from "../../src/host.ts";
import { createDefaultTransport } from "../../src/runtime.ts";
import type { McpServerEntry } from "../../src/config.ts";

const dirs: string[] = [];
// The shared test setup installs the host's real sandbox port; each test installs the one it means.
beforeEach(() => installMcpHost({ sandbox: undefined }));
afterEach(() => {
	for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

/** A stdio entry that writes `marker` when it runs, then exits. */
function entry(marker: string, sandbox?: boolean): McpServerEntry {
	return {
		name: "probe",
		config: {
			command: process.execPath,
			args: ["-e", `require("fs").writeFileSync(${JSON.stringify(marker)}, process.env.WRAPPED ?? "plain")`],
			...(sandbox === undefined ? {} : { sandbox }),
		},
	} as McpServerEntry;
}

function folder(): string {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mcp-sandbox-"));
	dirs.push(dir);
	return dir;
}

async function runToEnd(transport: ReturnType<typeof createDefaultTransport>): Promise<void> {
	const closed = new Promise<void>((resolve) => transport.onClose(resolve));
	await transport.start();
	await closed;
}

describe("a stdio server's opt-in sandbox", () => {
	it("refuses to start a server that sets sandbox: true when the host has no sandbox", async () => {
		const dir = folder();
		const marker = path.join(dir, "ran");
		await expect(createDefaultTransport(entry(marker, true), dir, undefined).start()).rejects.toThrow(
			/sets sandbox: true, but this host has no command sandbox/,
		);
		expect(fs.existsSync(marker)).toBe(false);
	});

	it("runs the launch the host's sandbox returns, in the server's folder, and releases it once the server ends", async () => {
		const dir = folder();
		const marker = path.join(dir, "ran");
		const launches: { command: string; args: readonly string[]; cwd: string }[] = [];
		let released = 0;
		const sandbox: McpSandboxPort = {
			wrapStdio: async (launch) => {
				launches.push(launch);
				return { file: launch.command, args: [...launch.args], env: { WRAPPED: "yes" }, release: () => released++ };
			},
		};
		installMcpHost({ sandbox });
		await runToEnd(createDefaultTransport(entry(marker, true), dir, undefined));
		expect(fs.readFileSync(marker, "utf8")).toBe("yes");
		expect(launches).toEqual([{ command: process.execPath, args: expect.any(Array), cwd: dir }]);
		expect(released).toBe(1);
	});

	it("does not start a server whose sandbox refuses it", async () => {
		const dir = folder();
		const marker = path.join(dir, "ran");
		installMcpHost({ sandbox: { wrapStdio: () => Promise.reject(new Error("bubblewrap not installed")) } });
		await expect(createDefaultTransport(entry(marker, true), dir, undefined).start()).rejects.toThrow(
			"bubblewrap not installed",
		);
		expect(fs.existsSync(marker)).toBe(false);
	});

	it("leaves a server without sandbox: true to run as configured", async () => {
		const dir = folder();
		let asked = 0;
		installMcpHost({
			sandbox: { wrapStdio: () => (asked++, Promise.reject(new Error("must not be asked"))) },
		});
		for (const [index, sandbox] of [undefined, false].entries()) {
			const marker = path.join(dir, `ran-${index}`);
			await runToEnd(createDefaultTransport(entry(marker, sandbox), dir, undefined));
			expect(fs.readFileSync(marker, "utf8")).toBe("plain");
		}
		expect(asked).toBe(0);
	});
});

import { type ChildProcess, spawn } from "node:child_process";
import fs from "node:fs";
import { describe, expect, it } from "vitest";
import type { CompactServerInput } from "../src/compact/index.ts";

/**
 * A drift suite against a locally installed server script. When the script is missing, one test names what is
 * missing instead of the suite vanishing: skipped on a developer machine, failed under CI, which installs and builds
 * every such server before the tests (see .github/workflows/ci.yml).
 */
export function describeWithServer(
	title: string,
	entry: string | undefined,
	missing: string,
	body: (entry: string) => void,
): void {
	describe(title, () => {
		if (entry !== undefined && fs.existsSync(entry)) return body(entry);
		if (process.env.CI) it("finds the server", () => expect.fail(`${missing}; CI must install and build it first`));
		else it.skip(`needs ${missing}`, () => {});
	});
}

/** A stdio MCP server's instructions and tool list, as a session reads them; `server` names the catalog. */
export async function catalogOf(
	server: string,
	args: readonly string[],
	env: Record<string, string> = {},
	cwd?: string,
): Promise<CompactServerInput> {
	const child: ChildProcess = spawn(process.execPath, [...args], {
		stdio: ["pipe", "pipe", "ignore"],
		env: { ...process.env, ...env },
		...(cwd ? { cwd } : {}),
	});
	const pending = new Map<number, (message: Record<string, any>) => void>();
	let buffer = "";
	child.stdout!.on("data", (chunk: Buffer) => {
		buffer += chunk.toString();
		for (let end = buffer.indexOf("\n"); end >= 0; end = buffer.indexOf("\n")) {
			const line = buffer.slice(0, end).trim();
			buffer = buffer.slice(end + 1);
			if (!line.startsWith("{")) continue;
			const message = JSON.parse(line) as Record<string, any>;
			pending.get(message.id)?.(message);
		}
	});
	const request = (id: number, method: string, params: object = {}) =>
		new Promise<Record<string, any>>((resolve) => {
			pending.set(id, resolve);
			child.stdin!.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
		});
	try {
		const init = await request(1, "initialize", {
			protocolVersion: "2025-06-18",
			capabilities: {},
			clientInfo: { name: "override-drift-test", version: "1" },
		});
		child.stdin!.write(`${JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" })}\n`);
		const list = await request(2, "tools/list");
		return {
			server,
			instructions: init.result.instructions,
			tools: list.result.tools.map(({ name, description, inputSchema, outputSchema }: Record<string, any>) => ({
				name,
				description,
				inputSchema,
				outputSchema,
			})),
		};
	} finally {
		child.kill();
	}
}

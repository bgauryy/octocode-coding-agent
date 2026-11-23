import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, expect, it } from "vitest";
import { approveFixtureMcp } from "../../coding-agent/test/octocode/guard-helpers.ts";
import { runMcpCommand } from "../src/cli.ts";
import type { McpServerEntry } from "../src/config.ts";
import { manage } from "../src/manager.ts";
import { presetEntries } from "../src/preset.ts";
import { formatStatus } from "../src/report.ts";
import { defaultPreset } from "./mcp-default-preset.ts";
import { mcpHost } from "./mcp-host-fixture.ts";

const FIXTURE = resolve(import.meta.dirname, "./client/fixtures/stdio-server.mjs");

/** In configuration order: one that connects, one switched off, one whose command does not exist. */
const servers = {
	zeta: { command: process.execPath, args: [FIXTURE] },
	alpha: { command: process.execPath, args: [FIXTURE], enabled: false },
	mid: { command: "octocode-test-missing-mcp-server" },
};
/** Servers that need the user first (the failed start), then connected ones, switched-off ones last. */
const ORDER = ["mid", "zeta", "alpha"];

const cleanup: Array<() => Promise<unknown> | void> = [];
afterEach(async () => {
	for (const step of cleanup.splice(0).reverse()) await step();
});

/** The server names of `lines` that start a server's entry (`name: ...`), in order. */
const names = (lines: string[]) =>
	lines.flatMap((line) => {
		const name = /^(\w+): /.exec(line)?.[1];
		return name && name in servers ? [name] : [];
	});

it("orders servers the same way on the /mcp page, in /mcp list and in octocode mcp list", async () => {
	const entries: McpServerEntry[] = Object.entries(servers).map(([name, config]) => ({
		name,
		config,
		source: "test",
		scope: "global",
	}));
	const host = mcpHost({ servers: entries, presets: [] });
	cleanup.push(() => host.close());
	await host.start();
	await host.prompt();
	expect(host.state.findServer("mid")?.connection?.state).toBe("failed");
	expect(host.state.findServer("zeta")?.connection?.state).toBe("connected");

	let page: string[] = [];
	await manage(
		host.state,
		{
			menu: async (build) => {
				page = build()
					.items.map((item) => item.value)
					.filter((value) => value !== "@add");
				return undefined;
			},
			status: () => {},
			redirectUrl: async () => undefined,
		},
		host.ctx,
	);

	const agentDir = mkdtempSync(join(tmpdir(), "octocode-mcp-order-"));
	cleanup.push(() => rmSync(agentDir, { recursive: true, force: true }));
	writeFileSync(join(agentDir, "mcp.json"), JSON.stringify({ mcpServers: servers }));
	const presets = [{ ...defaultPreset(), config: undefined }];
	approveFixtureMcp(agentDir, agentDir, presetEntries(presets));
	const run = async (args: string[]) => {
		const output: string[] = [];
		await runMcpCommand(args, { presets, cwd: agentDir, agentDir, log: (line) => output.push(line), error: () => {} });
		return output;
	};
	const json = JSON.parse((await run(["list", "--check", "--json"])).join("\n")) as { servers: { name: string }[] };

	expect(page).toEqual(ORDER);
	expect(names(formatStatus(host.state).split("\n"))).toEqual(ORDER);
	expect(names(await run(["list", "--check"]))).toEqual(ORDER);
	expect(json.servers.map((server) => server.name)).toEqual(ORDER);
	// Without --check nothing is connected: the switched-off server still comes last.
	expect(names(await run(["list"]))).toEqual(["mid", "zeta", "alpha"]);
});

import { spawn } from "node:child_process";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ACP_MCP_MANIFEST_ENV } from "@octocodeai/octocode-common/env";
import { acpServerHost } from "../../../coding-agent/src/main/acp-host.ts";
import { type AcpMcpServers, prepareAcpMcpServers } from "../../src/server/mcp.ts";

describe("ACP session MCP server environment", () => {
	let workspace: string;
	let prepared: AcpMcpServers | undefined;
	beforeEach(async () => {
		workspace = await realpath(await mkdtemp(join(tmpdir(), "acp-mcp-env-")));
		vi.stubEnv("OCTOCODE_CODING_AGENT_DIR", workspace);
	});
	afterEach(async () => {
		await prepared?.cleanup();
		await rm(workspace, { recursive: true, force: true });
		vi.unstubAllEnvs();
	});

	it("runs a client's stdio server with the filtered default environment plus its own entries", async () => {
		vi.stubEnv("ACP_TEST_SECRET_TOKEN", "leak");
		prepared = await prepareAcpMcpServers(
			[
				{
					name: "env-probe",
					command: process.execPath,
					args: ["-e", "process.stdout.write(JSON.stringify(process.env))"],
					env: [{ name: "OWN", value: "kept" }],
				},
			],
			workspace,
			acpServerHost,
		);
		const manifest = prepared.env[ACP_MCP_MANIFEST_ENV];
		const child = spawn(process.execPath, [join(dirname(manifest), "launcher.mjs"), manifest, "0"], {
			env: process.env,
			stdio: ["pipe", "pipe", "inherit"],
		});
		// The launcher stops the server when its stdin ends, so stdin stays open until the probe has printed.
		const out = await new Promise<string>((resolve, reject) => {
			let text = "";
			child.stdout.on("data", (chunk) => (text += chunk));
			child.once("error", reject);
			child.once("close", () => resolve(text));
		});
		const seen = JSON.parse(out) as Record<string, string>;
		expect(seen.OWN).toBe("kept");
		expect(seen.ACP_TEST_SECRET_TOKEN).toBeUndefined();
		expect(seen.PATH).toBe(process.env.PATH);
	});
});

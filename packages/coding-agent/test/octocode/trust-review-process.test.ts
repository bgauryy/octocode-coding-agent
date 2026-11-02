import { spawn } from "node:child_process";
import { once } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Readable, Writable } from "node:stream";
import { fileURLToPath, pathToFileURL } from "node:url";
import { client, methods, ndJsonStream, PROTOCOL_VERSION } from "@agentclientprotocol/sdk";
import { afterAll, describe, expect, it } from "vitest";
import { listFolderGrants } from "../../src/octocode/trust/grants.ts";
import { resolveFolderTrust } from "../../src/octocode/trust/resolve.ts";

/** Real processes: ACP refuses an untrusted folder with -32002, and concurrent writers keep one live row per folder. */
const resolver = fileURLToPath(new URL("../../scripts/source-resolver.ts", import.meta.url));
const cli = fileURLToPath(new URL("../../src/cli.ts", import.meta.url));
const grantsUrl = pathToFileURL(fileURLToPath(new URL("../../src/octocode/trust/grants.ts", import.meta.url))).href;
const roots: string[] = [];

function sandbox() {
	const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "octocode-trust-proc-")));
	roots.push(root);
	const home = path.join(root, "home");
	const project = path.join(home, "code", "app");
	fs.mkdirSync(project, { recursive: true });
	fs.mkdirSync(path.join(root, "agent"));
	const env: NodeJS.ProcessEnv = {
		...process.env,
		HOME: home,
		OCTOCODE_HOME: path.join(home, ".octocode"),
		OCTOCODE_CODING_AGENT_DIR: path.join(root, "agent"),
		OCTOCODE_AGENT_DB: path.join(root, "agent.sqlite"),
		OCTOCODE_MCP: "0",
		OCTOCODE_SKIP_VERSION_CHECK: "1",
		OCTOCODE_OFFLINE: "1",
	};
	for (const name of Object.keys(env))
		if (name === "OCTOCODE_SESSION_ID" || name.startsWith("OCTOCODE_SUBAGENT")) delete env[name];
	return { root, home, project, env, opts: { env, home } };
}

afterAll(() => {
	for (const root of roots) fs.rmSync(root, { recursive: true, force: true });
});

describe("ACP in an untrusted folder", () => {
	it("session/new and session/load fail with -32002 and name the trust command", async () => {
		const box = sandbox();
		const child = spawn(process.execPath, ["--import", resolver, cli, "--mode", "acp"], {
			cwd: box.project,
			env: box.env,
			stdio: ["pipe", "pipe", "pipe"],
		});
		const exited = once(child, "close");
		const connection = client({ name: "trust-review-test" }).connect(
			ndJsonStream(Writable.toWeb(child.stdin), Readable.toWeb(child.stdout) as ReadableStream<Uint8Array>),
		);
		try {
			await connection.agent.request(methods.agent.initialize, {
				protocolVersion: PROTOCOL_VERSION,
				clientCapabilities: {},
			});
			const failure = async (request: Promise<unknown>) =>
				request.then(
					() => undefined,
					(error: { code?: number; message?: string; data?: { command?: string } }) => error,
				);
			const created = await failure(
				connection.agent.request(methods.agent.session.new, { cwd: box.project, mcpServers: [] }),
			);
			expect(created?.code).toBe(-32002);
			expect(JSON.stringify(created)).toContain("octocode trust add");
			const loaded = await failure(
				connection.agent.request(methods.agent.session.load, {
					sessionId: "missing",
					cwd: box.project,
					mcpServers: [],
				}),
			);
			expect(loaded?.code).toBe(-32002);
		} finally {
			child.stdin.end();
			child.kill();
			await exited;
		}
		expect(resolveFolderTrust(box.project, box.opts).state).toBe("undecided");
	}, 90_000);
});

describe("the trust store under concurrent writer processes", () => {
	it("keeps one live row for a folder many processes grant at once, and every distinct folder", async () => {
		const box = sandbox();
		const shared = path.join(box.home, "code", "shared");
		const own = Array.from({ length: 6 }, (_, index) => path.join(box.home, "code", `own-${index}`));
		for (const folder of [shared, ...own]) fs.mkdirSync(folder, { recursive: true });
		const script = path.join(box.root, "writer.mjs");
		fs.writeFileSync(
			script,
			`import { grantFolder, refuseFolder } from ${JSON.stringify(grantsUrl)};
const [shared, own, home] = process.argv.slice(2);
const meta = { source: "command", surface: "cli" };
for (let round = 0; round < 5; round += 1) {
	grantFolder(shared, "folder", meta, { home });
	grantFolder(own, "folder", meta, { home });
	if (round % 2 === 1) refuseFolder(shared, meta, { home });
}
grantFolder(shared, "folder", meta, { home });
`,
		);
		const runs = own.map(async (folder) => {
			const child = spawn(process.execPath, ["--import", resolver, script, shared, folder, box.home], {
				env: box.env,
				stdio: ["ignore", "pipe", "pipe"],
			});
			let stderr = "";
			child.stderr.on("data", (chunk) => (stderr += chunk));
			const [code] = (await once(child, "close")) as [number | null];
			return { code, stderr };
		});
		for (const result of await Promise.all(runs)) expect(result, result.stderr).toMatchObject({ code: 0 });
		for (const folder of own) expect(resolveFolderTrust(folder, box.opts).state).toBe("trusted");
		expect(resolveFolderTrust(shared, box.opts).state).toBe("trusted");
		const live = listFolderGrants(box.opts).filter((row) => row.revokedAt === undefined);
		expect(live.filter((row) => row.path === shared)).toHaveLength(1);
		expect(live).toHaveLength(own.length + 1);
	}, 120_000);
});

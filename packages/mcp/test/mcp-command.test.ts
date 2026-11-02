import { octocodePreset } from "../src/presets/octocode/index.ts";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { grantFolder } from "../../coding-agent/src/octocode/trust/grants.ts";
import { runMcpCommand } from "../src/cli.ts";

const FIXTURE = resolve(import.meta.dirname, "./client/fixtures/stdio-server.mjs");

describe("octocode mcp", () => {
	const dirs: string[] = [];

	afterEach(() => {
		while (dirs.length > 0) rmSync(dirs.pop() ?? "", { recursive: true, force: true });
	});

	async function run(args: string[], servers: Record<string, unknown> | undefined, dir?: string) {
		const agentDir = dir ?? mkdtempSync(join(tmpdir(), "octocode-mcp-command-"));
		if (!dir) dirs.push(agentDir);
		if (servers) writeFileSync(join(agentDir, "mcp.json"), JSON.stringify({ mcpServers: servers }));
		const output: string[] = [];
		const exitCode = await runMcpCommand(args, {
			presets: [{ ...octocodePreset(), config: undefined }],
			cwd: agentDir,
			agentDir,
			log: (line) => output.push(line),
			error: (line) => output.push(line),
		});
		return { exitCode, output: output.join("\n"), agentDir };
	}

	const readConfig = (path: string) => JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;

	const servers = {
		fixture: { command: process.execPath, args: [FIXTURE] },
		broken: { command: "octocode-test-missing-mcp-server" },
		parked: { command: process.execPath, args: [FIXTURE], enabled: false },
		bad: { args: ["no command"] },
	};

	it("loads Octocode by default and persists control-only overrides through the CLI", async () => {
		const agentDir = mkdtempSync(join(tmpdir(), "mcp-default-cli-"));
		dirs.push(agentDir);
		const output: string[] = [];
		const options = {
			cwd: agentDir,
			agentDir,
			log: (line: string) => output.push(line),
			error: (line: string) => output.push(line),
		};
		expect(await runMcpCommand(["disable", "octocode"], options)).toBe(0);
		expect(readConfig(join(agentDir, "mcp.json"))).toEqual({ mcpServers: { octocode: { enabled: false } } });
		output.length = 0;
		expect(await runMcpCommand(["list", "--json"], options)).toBe(0);
		expect(JSON.parse(output.join("\n")).servers).toMatchObject([
			{ name: "octocode", state: "disabled", scope: "default" },
			{ name: "browser", scope: "default" },
		]);
		expect(await runMcpCommand(["enable", "octocode"], options)).toBe(0);
		expect(readConfig(join(agentDir, "mcp.json"))).toEqual({ mcpServers: { octocode: { enabled: true } } });
	});

	it("lists servers with their state, tools, and errors, and fails while anything is wrong", async () => {
		const { exitCode, output, agentDir } = await run(["list"], servers);
		expect(exitCode).toBe(1);
		expect(output).toContain("fixture: connected, 1 tool (direct, global) · enabled\n");
		expect(output).toContain("  tools: echo");
		expect(output).toContain(
			`broken: failed (direct, global) · enabled\n  octocode-test-missing-mcp-server\n  source: ${join(agentDir, "mcp.json")}\n  spawn octocode-test-missing-mcp-server ENOENT`,
		);
		expect(output).toContain("parked: disabled (direct, global)");
		expect(output).toContain("config error: ");
		expect(output).toContain('server "bad" needs either "command"');

		const ok = await run(["list"], { fixture: servers.fixture });
		expect(ok.exitCode).toBe(0);
	});

	it("sends the stored provider token to auth.provider servers, like a session does", async () => {
		const authorizations: (string | undefined)[] = [];
		const gateway = createServer((request, response) => {
			authorizations.push(request.headers.authorization);
			request.resume();
			response.writeHead(401).end();
		});
		await new Promise<void>((resolve) => gateway.listen(0, "127.0.0.1", resolve));
		const { port } = gateway.address() as AddressInfo;
		const agentDir = mkdtempSync(join(tmpdir(), "octocode-mcp-command-"));
		dirs.push(agentDir);
		writeFileSync(join(agentDir, "auth.json"), JSON.stringify({ anthropic: { type: "api_key", key: "stored-token" } }));
		try {
			const result = await run(
				["list", "--json"],
				{ gateway: { url: `http://127.0.0.1:${port}/mcp`, auth: { provider: "anthropic" } } },
				agentDir,
			);
			expect(authorizations).toEqual(["Bearer stored-token"]);
			const parsed = JSON.parse(result.output) as { servers: { state: string; error?: string }[] };
			expect(parsed.servers[0].state).toBe("needs-auth");
		} finally {
			await new Promise((resolve) => gateway.close(resolve));
		}
	});

	it("launches the local octocode server with the roots a session gives it", async () => {
		const result = await run(["list", "--json"], {
			octocode: {
				command: process.execPath,
				args: ["-e", "process.stderr.write('roots=' + process.env.ALLOWED_PATHS); process.exit(3)"],
			},
		});
		const parsed = JSON.parse(result.output) as { servers: { error?: string }[] };
		expect(parsed.servers[0].error).toContain(`roots=${result.agentDir},`);
	});

	it("prints JSON for scripts", async () => {
		const { exitCode, output } = await run(["list", "--json"], { fixture: servers.fixture, parked: servers.parked });
		expect(exitCode).toBe(0);
		const parsed = JSON.parse(output) as { servers: { name: string; state: string; tools: string[] }[] };
		expect(parsed.servers.map(({ name, state, tools }) => ({ name, state, tools }))).toEqual([
			{ name: "fixture", state: "connected", tools: ["echo"] },
			{ name: "parked", state: "disabled", tools: [] },
		]);
	});

	it("inspects one server's tool metadata without connecting unrelated servers", async () => {
		const result = await run(["tools", "fixture", "echo", "--json"], {
			fixture: servers.fixture,
			broken: servers.broken,
		});
		expect(result.exitCode).toBe(0);
		const report = JSON.parse(result.output);
		expect(report.servers).toHaveLength(1);
		expect(report.servers[0]).toMatchObject({
			name: "fixture",
			toolDetails: [{ name: "echo", exposure: "direct", inputSchema: { type: "object" } }],
		});
		expect((await run(["tools", "fixture", "unknown"], { fixture: servers.fixture })).exitCode).toBe(1);
		expect((await run(["tools", "unknown"], { fixture: servers.fixture })).exitCode).toBe(1);
		const disabled = await run(["tools", "parked", "--json"], { parked: servers.parked });
		expect(disabled.exitCode).toBe(0);
		expect(JSON.parse(disabled.output).servers[0]).toMatchObject({ state: "disabled", tools: [] });
	});

	it("shows global and workspace configuration paths without connecting or exposing credentials", async () => {
		const result = await run(["config", "--json"], {
			private: { command: "never-connect-for-config", env: { TOKEN: "private-token" } },
		});
		expect(result.exitCode).toBe(0);
		const locations = JSON.parse(result.output);
		expect(locations.globalWrite).toBe(join(result.agentDir, "mcp.json"));
		expect(locations.projectWrite).toBe(join(result.agentDir, ".octocode", "mcp.json"));
		expect(locations.projectTrusted).toBe(false);
		expect(
			locations.files
				.filter((file: { scope: string }) => file.scope === "project")
				.every((file: { ignored: boolean }) => file.ignored),
		).toBe(true);
		expect(result.output).not.toContain("private-token");
		grantFolder(result.agentDir, "folder", { source: "command", surface: "test" });
		const trusted = await run(["config"], undefined, result.agentDir);
		expect(trusted.output).not.toContain("ignored until trusted");
		expect(trusted.output).toContain("later entries override earlier ones");
	});

	it("rejects unknown servers and servers without OAuth for login and logout", async () => {
		expect(await run(["login", "nope"], servers)).toMatchObject({
			exitCode: 1,
			output: 'No MCP server named "nope". Configured: fixture, broken, parked.',
		});
		expect(await run(["logout", "fixture"], servers)).toMatchObject({
			exitCode: 1,
			output: 'MCP server "fixture" does not use OAuth. Only HTTP servers without an Authorization header do.',
		});
		expect((await run(["frobnicate"], servers)).exitCode).toBe(1);
	});

	it("enables, disables, and changes exposure without connecting or replacing transport settings", async () => {
		const initial = await run(["disable", "broken"], {
			broken: { command: "never-launch-this", env: { TOKEN: "secret" } },
		});
		expect(initial.exitCode).toBe(0);
		expect(readConfig(join(initial.agentDir, "mcp.json"))).toEqual({
			mcpServers: { broken: { command: "never-launch-this", env: { TOKEN: "secret" }, enabled: false } },
		});
		expect((await run(["exposure", "broken", "direct"], undefined, initial.agentDir)).exitCode).toBe(0);
		expect((await run(["enable", "broken"], undefined, initial.agentDir)).exitCode).toBe(0);
		expect(readConfig(join(initial.agentDir, "mcp.json"))).toEqual({
			mcpServers: { broken: { command: "never-launch-this", env: { TOKEN: "secret" } } },
		});
		const before = readFileSync(join(initial.agentDir, "mcp.json"), "utf8");
		expect((await run(["exposure", "broken", "invalid"], undefined, initial.agentDir)).exitCode).toBe(1);
		expect((await run(["disable", "missing"], undefined, initial.agentDir)).exitCode).toBe(1);
		expect(readFileSync(join(initial.agentDir, "mcp.json"), "utf8")).toBe(before);
	});

	it("requires trust for project controls and saves an override without copying secrets", async () => {
		const initial = await run(["disable", "remote", "--local"], {
			remote: { url: "https://example.test/mcp", headers: { Authorization: "secret" } },
		});
		expect(initial.exitCode).toBe(1);
		expect(initial.output).toContain("requires a trusted folder");
		grantFolder(initial.agentDir, "folder", { source: "command", surface: "test" });
		expect((await run(["disable", "remote", "--local"], undefined, initial.agentDir)).exitCode).toBe(0);
		const project = join(initial.agentDir, ".octocode", "mcp.json");
		expect(readConfig(project)).toEqual({ mcpServers: { remote: { enabled: false } } });
		expect((await run(["exposure", "remote", "hidden"], undefined, initial.agentDir)).exitCode).toBe(0);
		expect(readConfig(project)).toEqual({ mcpServers: { remote: { enabled: false, exposure: "hidden" } } });
		expect(JSON.stringify(readConfig(project))).not.toContain("secret");
	});

	it("does not reveal inline arguments or URL credentials in listing", async () => {
		const result = await run(["list", "--json"], {
			stdio: { command: "node", args: ["--token", "secret-argument"], enabled: false },
			http: { url: "https://user:password@example.test/mcp?token=secret-query", enabled: false },
		});
		expect(result.output).not.toMatch(/secret-argument|secret-query|password/);
		expect(result.exitCode).toBe(0);
	});

	it("adds stdio servers and passes options after the command through", async () => {
		const added = await run(
			["add", "--env", "A=1", "--env", "B=x=y", "files", "--", "npx", "-y", "server", "--root", "."],
			undefined,
		);
		expect(added.exitCode).toBe(0);
		expect(added.output).toContain('Added global MCP server "files"');
		expect(readConfig(join(added.agentDir, "mcp.json"))).toEqual({
			mcpServers: {
				files: { command: "npx", args: ["-y", "server", "--root", "."], env: { A: "1", B: "x=y" } },
			},
		});

		// Without `--`, options after the command belong to the command too.
		const replaced = await run(["add", "files", "node", "server.js", "--port", "1"], undefined, added.agentDir);
		expect(replaced.output).toContain('Replaced global MCP server "files"');
		expect(readConfig(join(added.agentDir, "mcp.json"))).toEqual({
			mcpServers: { files: { command: "node", args: ["server.js", "--port", "1"] } },
		});
	});

	it("adds HTTP servers and keeps other content of the file", async () => {
		const { exitCode, output, agentDir } = await run(
			[
				"add",
				"docs",
				"--url",
				"https://example.com/mcp",
				"--bearer-token-env-var",
				"DOCS_TOKEN",
				"--header",
				"X-Team=core",
				"--exposure",
				"direct",
				"--description",
				"Product docs",
			],
			{ fixture: servers.fixture },
		);
		expect(exitCode).toBe(0);
		expect(output).not.toContain("mcp login");
		expect(readConfig(join(agentDir, "mcp.json"))).toEqual({
			mcpServers: {
				fixture: servers.fixture,
				docs: {
					url: "https://example.com/mcp",
					// biome-ignore lint/suspicious/noTemplateCurlyInString: literal config value reference
					headers: { "X-Team": "core", Authorization: "Bearer ${DOCS_TOKEN}" },
					exposure: "direct",
					description: "Product docs",
				},
			},
		});

		const oauth = await run(
			[
				"add",
				"sentry",
				"--url",
				"https://mcp.sentry.dev/mcp",
				"--oauth-client-id",
				"octocode",
				"--oauth-client-name",
				"Claude Code",
			],
			undefined,
			agentDir,
		);
		expect(oauth.output).toContain("If it requires sign-in: octocode mcp login sentry");
		expect(readConfig(join(agentDir, "mcp.json")).mcpServers).toMatchObject({
			sentry: { url: "https://mcp.sentry.dev/mcp", oauth: { clientId: "octocode", clientName: "Claude Code" } },
		});
	});

	it("rejects invalid add invocations without writing", async () => {
		const cases = [
			["add", "x"],
			["add", "x", "--url", "https://example.com", "--", "cmd"],
			["add", "bad name", "--", "cmd"],
			["add", "x", "--url", "ftp://example.com"],
			["add", "x", "--env", "A=1", "--url", "https://example.com"],
			["add", "x", "--header", "A=1", "--", "cmd"],
			["add", "x", "--env", "NOVALUE", "--", "cmd"],
			["add", "x", "--exposure", "loud", "--", "cmd"],
		];
		for (const args of cases) {
			const result = await run(args, undefined);
			expect(result.exitCode, args.join(" ")).toBe(1);
			expect(existsSync(join(result.agentDir, "mcp.json"))).toBe(false);
		}
	});

	it("adds and removes project servers", async () => {
		const added = await run(["add", "-l", "local", "--", "node", "server.js"], undefined);
		expect(added.output).toContain("The folder is not trusted");
		const projectConfig = join(added.agentDir, ".octocode", "mcp.json");
		expect(readConfig(projectConfig)).toEqual({ mcpServers: { local: { command: "node", args: ["server.js"] } } });

		const wrongScope = await run(["remove", "local"], undefined, added.agentDir);
		expect(wrongScope.exitCode).toBe(1);
		expect(wrongScope.output).toContain(`It is defined in ${projectConfig}; use --local.`);

		const removed = await run(["remove", "local", "--local"], undefined, added.agentDir);
		expect(removed.exitCode).toBe(0);
		expect(removed.output).toContain('Removed project MCP server "local"');
		expect(readConfig(projectConfig)).toEqual({ mcpServers: {} });
	});

	it("removes global servers", async () => {
		const { exitCode, agentDir } = await run(["remove", "broken"], servers);
		expect(exitCode).toBe(0);
		expect(Object.keys(readConfig(join(agentDir, "mcp.json")).mcpServers as object)).toEqual([
			"fixture",
			"parked",
			"bad",
		]);
		const missing = await run(["remove", "broken"], undefined, agentDir);
		expect(missing).toMatchObject({ exitCode: 1 });
		expect(missing.output).toContain('No global MCP server named "broken"');
	});
});

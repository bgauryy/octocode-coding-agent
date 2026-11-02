import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { catalogHash, generatedDir, readGenerated, writeGenerated } from "../src/compact/index.ts";
import { runMcpCommand } from "../src/cli.ts";
import { octocodePreset } from "../src/presets/octocode/index.ts";

const STDIO_FIXTURE = resolve(import.meta.dirname, "./client/fixtures/stdio-server.mjs");
const OCTOCODE_CATALOG = resolve(import.meta.dirname, "./fixtures/compact/octocode-catalog.json");

describe("octocode mcp compact", () => {
	const dirs: string[] = [];
	afterEach(() => {
		while (dirs.length > 0) rmSync(dirs.pop() ?? "", { recursive: true, force: true });
	});

	function setup() {
		const agentDir = mkdtempSync(join(tmpdir(), "octocode-mcp-compact-"));
		dirs.push(agentDir);
		writeFileSync(
			join(agentDir, "mcp.json"),
			JSON.stringify({ mcpServers: { fixture: { command: process.execPath, args: [STDIO_FIXTURE] } } }),
		);
		const run = async (args: string[]) => {
			const output: string[] = [];
			const exitCode = await runMcpCommand(args, {
				presets: [{ ...octocodePreset(), config: undefined }],
				cwd: agentDir,
				agentDir,
				log: (line) => output.push(line),
				error: (line) => output.push(line),
			});
			return { exitCode, output: output.join("\n") };
		};
		const write = (name: string, value: unknown) => {
			const file = join(agentDir, name);
			writeFileSync(file, typeof value === "string" ? value : JSON.stringify(value));
			return file;
		};
		return { agentDir, run, write, store: generatedDir(agentDir) };
	}

	it("prints the plain file for a catalog file, without storing it", async () => {
		const { run, store } = setup();
		const { exitCode, output } = await run(["compact", "show", "octocode", "--plain", "--catalog", OCTOCODE_CATALOG]);
		expect(exitCode).toBe(0);
		expect(output).toContain("declare namespace octocode {");
		expect(output).toContain("<when>");
		expect(existsSync(store)).toBe(false);
	});

	it("generates a missing file with the preset's overrides for the catalog they were written for, then reads the stored one", async () => {
		const { run, store } = setup();
		const first = await run(["compact", "show", "octocode", "--catalog", OCTOCODE_CATALOG]);
		expect(first.exitCode).toBe(0);
		expect(first.output).not.toContain("<when>");
		const stored = readGenerated(store, "octocode");
		const catalog = JSON.parse(readFileSync(OCTOCODE_CATALOG, "utf8"));
		expect(stored?.meta.hash).toBe(catalogHash(catalog));
		expect(stored?.meta.overrides?.tools?.lspSearch).toContain("workspaceSymbol");
		const again = await run(["compact", "show", "octocode"]);
		expect(again.output).toBe(first.output);
	});

	it("renders deterministically when the catalog differs from the one the preset overrides were written for", async () => {
		const { run, write } = setup();
		const catalog = JSON.parse(readFileSync(OCTOCODE_CATALOG, "utf8"));
		catalog.tools[0].description = `${catalog.tools[0].description} Changed.`;
		const { output } = await run(["compact", "show", "octocode", "--catalog", write("changed.json", catalog)]);
		expect(output).toContain("<when>");
	});

	it("refuses a multi-server catalog file without the requested server", async () => {
		const { run, write } = setup();
		const file = write("servers.json", { servers: [{ name: "other", tools: [{ name: "t" }] }] });
		const { exitCode, output } = await run(["compact", "show", "octocode", "--plain", "--catalog", file]);
		expect(exitCode).toBe(1);
		expect(output).toContain('has no server named "octocode" (servers: other)');
		expect(output).not.toContain("function t(");
	});

	it("reads the live catalog of a configured server, stores its file and lists it as current", async () => {
		const { run, store } = setup();
		const shown = await run(["compact", "show", "fixture"]);
		expect(shown.exitCode).toBe(0);
		expect(shown.output).toContain("function echo(");
		expect(readGenerated(store, "fixture")?.text.trimEnd()).toBe(shown.output);
		const listed = await run(["compact", "list"]);
		expect(listed.output).toMatch(/^fixture {2}[0-9a-f]{12} {2}overrides: no {2}stale: no$/m);
		const offline = await run(["compact", "list", "--offline"]);
		expect(offline.output).toMatch(/^fixture {2}[0-9a-f]{12} {2}overrides: no {2}stale: unknown$/m);
	});

	it("lists a stored file as stale when the live catalog hashes differently", async () => {
		const { run, store } = setup();
		await run(["compact", "show", "fixture"]);
		const stored = readGenerated(store, "fixture")!;
		writeGenerated(store, "fixture", stored.text, { ...stored.meta, hash: "0".repeat(64) });
		const json = JSON.parse((await run(["compact", "list", "--json"])).output);
		expect(json.servers.find((row: { server: string }) => row.server === "fixture")).toMatchObject({
			hash: "000000000000",
			stale: true,
			overrides: false,
		});
	});

	it("writes a catalog file that check and apply accept in place of the live server", async () => {
		const { run, write, agentDir } = setup();
		const out = join(agentDir, "catalog.json");
		expect((await run(["compact", "catalog", "fixture", "--out", out])).exitCode).toBe(0);
		const catalog = JSON.parse(readFileSync(out, "utf8"));
		expect(catalog.tools.map((tool: { name: string }) => tool.name)).toEqual(["echo"]);
		const overrides = write("overrides.json", { tools: { echo: "Echo the text." } });
		const checked = await run(["compact", "check", "nothing-configured", "--overrides", overrides, "--catalog", out]);
		expect(checked.exitCode).toBe(0);
		expect(checked.output).toContain("| rendered file |");
		expect(checked.output).toContain("| echo |");
		expect(checked.output).toMatch(/fidelity check passed; catalog [0-9a-f]{64}/);
	});

	it("fails the check, printing each problem, and refuses to apply what fails", async () => {
		const { run, write, agentDir, store } = setup();
		const catalog = join(agentDir, "catalog.json");
		await run(["compact", "catalog", "fixture", "--out", catalog]);
		const overrides = write("bad.json", { tools: { echo: "See https://example.com/x.", missing: "No such tool." } });
		const checked = await run(["compact", "check", "fixture", "--overrides", overrides, "--catalog", catalog]);
		expect(checked.exitCode).toBe(1);
		expect(checked.output).toContain("echo: adds URL https://example.com/x.");
		expect(checked.output).toContain("override names unknown tool missing");
		const applied = await run(["compact", "apply", "fixture", "--overrides", overrides, "--catalog", catalog]);
		expect(applied.exitCode).toBe(1);
		expect(applied.output).toContain("Not applied");
		expect(readGenerated(store, "fixture")).toBeUndefined();
	});

	it("rejects overrides that are not the documented shape", async () => {
		const { run, write } = setup();
		const result = await run([
			"compact",
			"check",
			"fixture",
			"--overrides",
			write("typo.json", { tool: { echo: "x" } }),
		]);
		expect(result.exitCode).toBe(1);
		expect(result.output).toContain("unknown overrides key: tool");
		expect((await run(["compact", "check", "fixture"])).output).toContain("--overrides <file> is required");
	});

	it("applies checked overrides to the store with the model that wrote them, and the next show prints them", async () => {
		const { run, write, store } = setup();
		const overrides = write("overrides.json", { server: "Echo server.", tools: { echo: "Echo the text." } });
		const applied = await run([
			"compact",
			"apply",
			"fixture",
			"--overrides",
			overrides,
			"--optimized-by",
			"test-model",
		]);
		expect(applied.exitCode).toBe(0);
		const stored = readGenerated(store, "fixture");
		expect(stored?.meta.overrides).toEqual({ server: "Echo server.", tools: { echo: "Echo the text." } });
		expect(stored?.meta.optimizedBy).toMatchObject({ model: "test-model" });
		expect(stored?.text).toContain("/** Echo the text. */");
		const shown = await run(["compact", "show", "fixture", "--refresh"]);
		expect(shown.output).toContain("/** Echo server. */");
		expect((await run(["compact", "list"])).output).toMatch(
			/fixture {2}[0-9a-f]{12} {2}overrides: yes {2}stale: no {2}optimized by test-model/,
		);
	});

	it("names the tools whose stored overrides no longer describe the live tool", async () => {
		const { run, write, store } = setup();
		const overrides = write("overrides.json", {
			tools: { echo: "Echo the text." },
			triggers: { echo: "Use to echo." },
		});
		expect((await run(["compact", "apply", "fixture", "--overrides", overrides])).exitCode).toBe(0);
		const stored = readGenerated(store, "fixture")!;
		expect(stored.meta.toolHashes?.echo).toMatch(/^[0-9a-f]{64}$/);
		writeGenerated(store, "fixture", stored.text, { ...stored.meta, toolHashes: { echo: "0".repeat(64) } });
		const listed = await run(["compact", "list"]);
		expect(listed.output).toContain("stale overrides: echo");
		const json = JSON.parse((await run(["compact", "list", "--json"])).output);
		expect(json.servers.find((row: { server: string }) => row.server === "fixture").staleTools).toEqual(["echo"]);
	});

	it("prints checked overrides in the per-tool preset form", async () => {
		const { run, write, agentDir } = setup();
		const catalog = join(agentDir, "catalog.json");
		await run(["compact", "catalog", "fixture", "--out", catalog]);
		const overrides = write("overrides.json", {
			tools: { echo: "Echo the text." },
			triggers: { echo: "Use to echo." },
		});
		const printed = await run(["compact", "preset", "fixture", "--overrides", overrides, "--catalog", catalog]);
		expect(printed.exitCode).toBe(0);
		const preset = JSON.parse(printed.output);
		expect(preset.tools.echo).toMatchObject({ description: "Echo the text.", trigger: "Use to echo." });
		expect(preset.tools.echo.descriptionHash).toMatch(/^[0-9a-f]{16}$/);
		const bad = write("bad.json", { triggers: { echo: "Two\nlines." } });
		expect((await run(["compact", "preset", "fixture", "--overrides", bad, "--catalog", catalog])).exitCode).toBe(1);
	});

	it("reports usage for an unknown action and names the server it cannot find", async () => {
		const { run } = setup();
		expect((await run(["compact"])).exitCode).toBe(1);
		const missing = await run(["compact", "show", "nowhere"]);
		expect(missing.exitCode).toBe(1);
		expect(missing.output).toContain('No MCP server named "nowhere".');
		expect((await run(["--help"])).output).toContain("mcp compact show <server>");
	});
});

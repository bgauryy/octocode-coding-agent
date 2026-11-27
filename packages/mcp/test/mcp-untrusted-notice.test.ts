import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { fakeCtx } from "../../coding-agent/test/octocode/fake-host.ts";
import { runMcpCommand } from "../src/cli.ts";
import { hostPlugins, installMcpHost } from "../src/host.ts";
import { mcpHost } from "./mcp-host-fixture.ts";

const dirs: string[] = [];
const temp = (prefix: string) => {
	const dir = mkdtempSync(join(tmpdir(), prefix));
	dirs.push(dir);
	return dir;
};
const workspace = (withFile: boolean) => {
	const cwd = temp("octocode-mcp-untrusted-");
	if (withFile) {
		mkdirSync(join(cwd, ".octocode"));
		writeFileSync(join(cwd, ".octocode", "mcp.json"), JSON.stringify({ mcpServers: {} }));
	}
	return cwd;
};
const originalPlugins = hostPlugins();

afterEach(() => {
	installMcpHost({ plugins: originalPlugins });
	vi.unstubAllEnvs();
	while (dirs.length > 0) rmSync(dirs.pop() ?? "", { recursive: true, force: true });
});

describe("untrusted workspace mcp.json notice", () => {
	const notices = async (cwd: string, trusted: boolean, hasUI = true) => {
		const ctx = { ...fakeCtx({ cwd, hasUI }), isProjectTrusted: () => trusted };
		const mcp = mcpHost({ servers: [], startupWaitMs: 1 });
		await mcp.start(ctx);
		await mcp.close();
		return ctx.ui.notes.filter((note: { message: string }) => note.message.includes("not trusted"));
	};

	it("names the ignored file once per session start", async () => {
		vi.stubEnv("OCTOCODE_HOME", temp("octocode-mcp-untrusted-home-"));
		const cwd = workspace(true);
		const found = await notices(cwd, false);
		expect(found).toHaveLength(1);
		expect(found[0].type).toBe("warning");
		expect(found[0].message).toContain(join(cwd, ".octocode", "mcp.json"));
		expect(found[0].message).toContain("trust add");
	});

	it("stays silent when the folder is trusted", async () => {
		vi.stubEnv("OCTOCODE_HOME", temp("octocode-mcp-untrusted-home-"));
		expect(await notices(workspace(true), true)).toEqual([]);
	});

	it("stays silent when no workspace file exists", async () => {
		vi.stubEnv("OCTOCODE_HOME", temp("octocode-mcp-untrusted-home-"));
		expect(await notices(workspace(false), false)).toEqual([]);
	});
});

describe("octocode mcp list plugin servers", () => {
	it("lists servers that enabled plugins declare and their read errors", async () => {
		vi.stubEnv("OCTOCODE_HOME", temp("octocode-mcp-plugin-home-"));
		const places: unknown[] = [];
		installMcpHost({
			plugins: {
				servers: (place) => {
					places.push(place);
					return {
						servers: [{ name: "plugin:demo:docs", config: { command: "never-started", enabled: false } }],
						errors: ["plugin broken: bad manifest"],
					};
				},
			},
		});
		const output: string[] = [];
		const agentDir = temp("octocode-mcp-plugin-agent-");
		const cwd = workspace(false);
		const exitCode = await runMcpCommand(["list"], {
			presets: [],
			cwd,
			agentDir,
			log: (line) => output.push(line),
			error: (line) => output.push(line),
		});
		const text = output.join("\n");
		expect(text).toContain("plugin:demo:docs");
		expect(text).toContain("plugin broken: bad manifest");
		expect(exitCode).toBe(1);
		expect(places).toEqual([{ agentDir, cwd, projectTrusted: false }]);
	});
});

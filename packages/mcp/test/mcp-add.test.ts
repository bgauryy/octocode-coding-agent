import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { McpAddCommand } from "@octocodeai/octocode-contracts/config";
import { saveMcpDefinition } from "../src/add.ts";
import { addMcpWithUi } from "../src/add-ui.ts";
import { manage } from "../src/manager.ts";
import { mcpHost } from "./mcp-host-fixture.ts";
import { McpManagerView, type McpUi, type McpMenu } from "../src/ui.ts";
import { setKeybindings, type TUI } from "@octocodeai/octocode-tui";
import { KeybindingsManager } from "../../coding-agent/src/core/keybindings.ts";
import { initTheme, theme } from "../../coding-agent/src/theme/theme.ts";
import { globalMcpConfigPath, projectMcpConfigPath } from "../src/paths.ts";

let root: string;
let agentDir: string;
let cwd: string;
beforeEach(() => {
	root = fs.mkdtempSync(path.join(os.tmpdir(), "octocode-add-mcp-"));
	agentDir = path.join(root, "agent");
	cwd = path.join(root, "repo");
	fs.mkdirSync(agentDir);
	fs.mkdirSync(cwd);
	vi.stubEnv("HOME", root);
	vi.stubEnv("OCTOCODE_HOME", agentDir);
});
afterEach(() => {
	vi.unstubAllEnvs();
	fs.rmSync(root, { recursive: true, force: true });
});
const options = () => ({ agentDir, cwd, projectTrusted: true });
const stdio: McpAddCommand = {
	name: "example",
	scope: "global",
	transport: "stdio",
	command: "does-not-exist",
	args: ["a b", "--flag"],
	env: { TOKEN: "private-marker" },
};
const read = (file: string) => JSON.parse(fs.readFileSync(file, "utf8"));

describe("private MCP persistence", () => {
	const mode = (file: string) => fs.statSync(file).mode & 0o777;
	it("creates a private comment backup without chmodding an existing workspace directory", () => {
		const destination = projectMcpConfigPath(cwd);
		fs.mkdirSync(path.dirname(destination), { mode: 0o755 });
		fs.chmodSync(path.dirname(destination), 0o755);
		const original = '// private-marker\n{"mcpServers":{}}';
		fs.writeFileSync(destination, original, { mode: 0o644 });
		saveMcpDefinition({ ...stdio, scope: "workspace" }, options());
		expect(mode(destination)).toBe(0o600);
		expect(mode(`${destination}.bak`)).toBe(0o600);
		expect(mode(path.dirname(destination))).toBe(0o755);
		expect(fs.readFileSync(`${destination}.bak`, "utf8")).toBe(original);
	});
	it.each(["global", "workspace"] as const)(
		"creates private %s configuration without changing existing directory permissions",
		(scope) => {
			const destination = scope === "global" ? globalMcpConfigPath(agentDir) : projectMcpConfigPath(cwd);
			fs.chmodSync(cwd, 0o755);
			fs.chmodSync(agentDir, 0o755);
			saveMcpDefinition({ ...stdio, scope }, options());
			expect(mode(destination)).toBe(0o600);
			expect(mode(cwd)).toBe(0o755);
			expect(mode(agentDir)).toBe(0o755);
			if (scope === "workspace") expect(mode(path.dirname(destination))).toBe(0o700);
		},
	);
	it.each([true, false])(
		"hardens existing permissive config and backup while preserving their contents (comments=%s)",
		(comments) => {
			const destination = globalMcpConfigPath(agentDir);
			const original = `${comments ? "// preserve this comment\n" : ""}{"mcpServers":{"old":{"command":"node","env":{"TOKEN":"old-secret"}}}}`;
			fs.writeFileSync(destination, original, { mode: 0o644 });
			fs.writeFileSync(`${destination}.bak`, "existing-backup-secret", { mode: 0o644 });
			saveMcpDefinition(stdio, options());
			expect(mode(destination)).toBe(0o600);
			expect(mode(`${destination}.bak`)).toBe(0o600);
			expect(read(destination).mcpServers.old.env.TOKEN).toBe("old-secret");
			expect(fs.readFileSync(`${destination}.bak`, "utf8")).toBe(comments ? original : "existing-backup-secret");
		},
	);
});

describe("safe new MCP definitions", () => {
	it("saves stdio literally, disabled/unassigned, without starting it or modifying settings", () => {
		fs.writeFileSync(path.join(agentDir, "settings.json"), '{"model":"keep"}');
		const result = saveMcpDefinition(stdio, options());
		expect(result.saved).toBe(true);
		expect(JSON.stringify(result)).not.toContain("private-marker");
		expect(read(globalMcpConfigPath(agentDir)).mcpServers.example).toEqual({
			type: "stdio",
			command: "does-not-exist",
			args: ["a b", "--flag"],
			env: { TOKEN: "private-marker" },
			enabled: false,
			defaultActive: false,
		});
		expect(fs.readFileSync(path.join(agentDir, "settings.json"), "utf8")).toBe('{"model":"keep"}');
	});
	it("saves HTTP headers to trusted workspace only", () => {
		const command: McpAddCommand = {
			name: "remote",
			scope: "workspace",
			transport: "http",
			url: "https://example.test/mcp",
			headers: { Authorization: "private-marker" },
		};
		expect(() => saveMcpDefinition(command, { ...options(), projectTrusted: false })).toThrow(/Trust/);
		expect(fs.existsSync(projectMcpConfigPath(cwd))).toBe(false);
		saveMcpDefinition(command, options());
		expect(read(projectMcpConfigPath(cwd)).mcpServers.remote).toMatchObject({
			url: command.url,
			headers: command.headers,
			enabled: false,
			defaultActive: false,
		});
		expect(fs.existsSync(globalMcpConfigPath(agentDir))).toBe(false);
	});
	it.each([
		{ ...stdio, name: "" },
		{ ...stdio, name: "bad name" },
		{ ...stdio, name: "bad--name" },
		{ ...stdio, command: "  " },
		{ ...stdio, args: [1] },
		{ ...stdio, env: { TOKEN: 1 } },
		{ name: "remote", scope: "global", transport: "http", url: "file:///private-marker" },
		{ name: "remote", scope: "global", transport: "http", url: " " },
	])("refuses invalid definitions without writes or diagnostic secret echoes", (command) => {
		expect(() => saveMcpDefinition(command as McpAddCommand, options())).toThrow();
		expect(fs.existsSync(globalMcpConfigPath(agentDir))).toBe(false);
	});
	it("rejects same-name and namespace collisions across scopes without replacing either entry", () => {
		saveMcpDefinition({ ...stdio, name: "my-server" }, options());
		const before = fs.readFileSync(globalMcpConfigPath(agentDir), "utf8");
		for (const name of ["my-server", "my_server"])
			expect(() => saveMcpDefinition({ ...stdio, name, scope: "workspace" }, options())).toThrow(/already exists/);
		expect(fs.readFileSync(globalMcpConfigPath(agentDir), "utf8")).toBe(before);
		expect(fs.existsSync(projectMcpConfigPath(cwd))).toBe(false);
	});
	it("refuses malformed destination and does not echo its contents", () => {
		fs.writeFileSync(globalMcpConfigPath(agentDir), "private-marker invalid JSON");
		expect(() => saveMcpDefinition(stdio, options())).toThrow(/Could not save/);
		try {
			saveMcpDefinition(stdio, options());
		} catch (error) {
			expect(String(error)).not.toContain("private-marker");
		}
		expect(fs.readFileSync(globalMcpConfigPath(agentDir), "utf8")).toBe("private-marker invalid JSON");
	});
});

function ui(choices: (string | undefined)[], inputs: (string | undefined)[]) {
	const menus: McpMenu[] = [];
	const port: McpUi = {
		menu: async (build) => {
			menus.push(build());
			return choices.shift();
		},
		input: vi.fn(async () => inputs.shift()),
		status: () => {},
		redirectUrl: async () => undefined,
	};
	return { port, menus };
}
describe("terminal add", () => {
	it("literal input submits an empty value and resolves cancellation/disposal without a value", async () => {
		initTheme("dark");
		const bindings = new KeybindingsManager();
		setKeybindings(bindings);
		const view = new McpManagerView({ requestRender: vi.fn() } as unknown as TUI, theme, bindings);
		const empty = view.input("Name", "", "Literal input");
		view.handleInput("\r");
		await expect(empty).resolves.toBe("");
		const cancel = view.input("Name", "draft", "Literal input");
		view.handleInput("\x1b");
		await expect(cancel).resolves.toBeUndefined();
		const disposed = view.input("Name", "draft", "Literal input");
		view.dispose();
		await expect(disposed).resolves.toBeUndefined();
	});
	it("offers Add MCP with an empty registry and cancelling writes nothing", async () => {
		const host = mcpHost({ cwd, servers: [], presets: [] });
		await host.start();
		const { port, menus } = ui([undefined], []);
		await manage(host.state, port, host.ctx);
		expect(menus[0].items.some((item) => item.label === "Add MCP")).toBe(true);
		expect(fs.existsSync(globalMcpConfigPath(agentDir))).toBe(false);
		await host.close();
	});
	it.each(["stdio", "http"])("saves a guided %s definition without opening a transport", async (transport) => {
		const createTransport = vi.fn();
		const host = mcpHost({ cwd, servers: [], presets: [], createTransport });
		await host.start();
		const { port } = ui(
			["field", "global", transport, "save", "done"],
			transport === "stdio"
				? ["", "guided", "nonexistent", '["a b"]', "{}"]
				: ["", "guided", "https://example.test/mcp", "{}"],
		);
		await addMcpWithUi(host.state, port);
		expect(read(globalMcpConfigPath(agentDir)).mcpServers.guided.enabled).toBe(false);
		expect(createTransport).not.toHaveBeenCalled();
		await host.close();
	});
	it("preserves input after invalid JSON and cancels without writes", async () => {
		const host = mcpHost({ cwd, servers: [], presets: [] });
		await host.start();
		const { port, menus } = ui(
			["field", "global", "stdio", "save", "edit"],
			["", "draft", "node", "not JSON", "{}", undefined],
		);
		await addMcpWithUi(host.state, port);
		expect(menus.some((menu) => menu.error)).toBe(true);
		expect(port.input).toHaveBeenLastCalledWith("Add MCP — Server name", "draft", expect.any(String));
		expect(fs.existsSync(globalMcpConfigPath(agentDir))).toBe(false);
		await host.close();
	});
});

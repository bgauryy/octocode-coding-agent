import fs from "node:fs";
import path from "node:path";
import { createEventBus } from "@octocodeai/octocode-agent-core";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { blockedReason } from "../../src/core/extensibility/switch.ts";
import { configDiscovery, discoveryInput } from "../../src/core/discovery/service.ts";
import { formatHarnessesForPrompt } from "../../src/core/discovery/vendors/prompt.ts";
import { harnessStatuses } from "../../src/core/discovery/vendors/index.ts";
import { SettingsManager } from "../../src/core/settings-manager.ts";
import { installOctocodeDiscovery } from "../../src/octocode/discovery/index.ts";
import { registerHarnessCommand } from "../../src/octocode/harness/command.ts";
import { switchHarness, vendorItems } from "../../src/octocode/harness/vendor-items.ts";
import { installMcpCorePorts } from "../../src/octocode/mcp-host/core.ts";
import { vendors } from "../../src/octocode/mcp-host/vendors.ts";
import type { HooksView } from "../../src/octocode/hooks/register/types.ts";
import { Subcommands } from "../../src/octocode/shared/commands.ts";
import { fakeCtx, fakeHost } from "./fake-host.ts";
import { tmp } from "./helpers.ts";

beforeAll(() => {
	installMcpCorePorts();
	installOctocodeDiscovery();
});
afterEach(() => vi.unstubAllEnvs());

function fixture() {
	const home = fs.realpathSync(tmp());
	const cwd = fs.realpathSync(tmp());
	const agentDir = path.join(home, "agent");
	fs.mkdirSync(path.join(cwd, ".git"));
	fs.mkdirSync(agentDir);
	vi.stubEnv("HOME", home);
	vi.stubEnv("OCTOCODE_HOME", agentDir);
	vi.stubEnv("OCTOCODE_CODING_AGENT_DIR", agentDir);
	const input = (toggles?: Record<string, boolean>, extra: { home?: string } = {}) =>
		discoveryInput({ cwd, agentDir, home, projectTrusted: true, piRoots: [], env: {}, toggles, ...extra });
	return { home, cwd, agentDir, input };
}
const write = (file: string, text: string) => {
	fs.mkdirSync(path.dirname(file), { recursive: true });
	fs.writeFileSync(file, text);
};
const servers = (names: Record<string, unknown>) => JSON.stringify({ mcpServers: names });

describe("MCP discovery agrees with the loader on foreign servers", () => {
	it("keeps a global Octocode server over a project Cursor server of the same name", () => {
		const f = fixture();
		write(path.join(f.agentDir, "mcp.json"), servers({ x: { command: "octocode-x" } }));
		write(path.join(f.cwd, ".cursor", "mcp.json"), servers({ x: { command: "cursor-x" } }));
		const items = configDiscovery.discover("mcp", f.input({ "harness:cursor": true })).filter((i) => i.name === "x");
		const winner = items.find((item) => item.loaded);
		expect(items.map((item) => item.provenance.vendor).sort()).toEqual(["cursor", "octocode"]);
		expect(winner?.provenance.vendor).toBe("octocode");
	});
});

describe("Claude Code auto memory is switched globally only", () => {
	const statuses = () => harnessStatuses(fixtureInput());
	function fixtureInput() {
		return discoveryInput({
			cwd: "/nowhere",
			agentDir: "/nowhere/agent",
			home: "/nowhere",
			projectTrusted: false,
			piRoots: [],
			env: {},
		});
	}

	it("refuses --project with one line and writes the global key otherwise", () => {
		const f = fixture();
		const manager = SettingsManager.create(f.cwd, f.agentDir, { projectTrusted: true });
		const memory = vendorItems(statuses(), {}).find((row) => row.id === "harness:claude:memory")!;
		expect(() => switchHarness(memory, true, "project", manager, f)).toThrow(
			"Claude Code auto memory is switched globally: run it without --project.",
		);
		expect(manager.getProjectSettings().toggles).toBeUndefined();
		expect(switchHarness(memory, true, "global", manager, f)).toContain("globally");
		expect(manager.getGlobalSettings().toggles).toEqual({ "harness:claude:memory": true });
	});

	it("ignores a project key in the row and shows the row as not switchable in project scope", () => {
		const row = (toggles: Record<string, boolean>) =>
			vendorItems(statuses(), toggles).find((entry) => entry.id === "harness:claude:memory")!;
		expect(row({ "project:harness:claude:memory": true }).on).toBe(false);
		expect(row({ "harness:claude:memory": true }).on).toBe(true);
		expect(blockedReason(row({}), "project")).toBeDefined();
		expect(blockedReason(row({}), "global")).toBeUndefined();
	});
});

describe("a harness only a project key switches on", () => {
	it("is marked project-only in the status, the prompt and its /harness row", () => {
		const f = fixture();
		const project = harnessStatuses(f.input({ "project:harness:claude": true })).find((s) => s.id === "claude")!;
		expect(project).toMatchObject({ on: true, projectOnly: true });
		expect(formatHarnessesForPrompt([project])).toContain("Claude Code on for this project");
		expect(vendorItems([project], {})[0]?.detail).toContain("on for this project only");
		const global = harnessStatuses(f.input({ "harness:claude": true })).find((s) => s.id === "claude")!;
		expect(global.projectOnly).toBeUndefined();
		expect(formatHarnessesForPrompt([global])).toBe("Harnesses: Claude Code on. The user switches them with /harness.");
	});
});

describe("harnessStatuses cache", () => {
	it("does not return another home's statuses within one discovery generation", () => {
		const f = fixture();
		const other = fs.realpathSync(tmp());
		write(path.join(other, ".claude", "skills", "s", "SKILL.md"), "---\nname: s\ndescription: d\n---\nB\n");
		const claude = (home: string) => harnessStatuses(f.input({}, { home })).find((s) => s.id === "claude")!;
		expect(claude(f.home).found.skill).toBeUndefined();
		expect(claude(other).found.skill).toBe(1);
	});
});

describe("vendorSwitch", () => {
	it("reports an unreadable settings file instead of silently using the defaults", () => {
		const f = fixture();
		write(path.join(f.agentDir, "settings.json"), "{ not json");
		expect(() => vendors.vendorSwitch({ cwd: f.cwd, agentDir: f.agentDir, projectTrusted: true })).toThrow(
			/settings\.json/,
		);
	});
});

describe("/harness when the MCP reload fails", () => {
	it("keeps the saved switch and says the reload failed", async () => {
		const f = fixture();
		const { api } = fakeHost();
		const events = createEventBus();
		events.on("mcp:reload:request", (reply) =>
			(reply as (handle: () => Promise<never>) => void)(() => Promise.reject(new Error("session aborted"))),
		);
		Object.assign(api, { events });
		const commands = new Subcommands();
		registerHarnessCommand(commands, { report: () => "" } as unknown as HooksView, api);
		const ctx = fakeCtx({ cwd: f.cwd, mode: "rpc" });
		await commands.get("harness")!.handler("enable claude", ctx);
		const message = ctx.ui.notes.at(-1)!.message;
		expect(message).toContain("switches are saved, but the MCP reload failed (session aborted)");
		expect(JSON.parse(fs.readFileSync(path.join(f.agentDir, "settings.json"), "utf8")).toggles).toEqual({
			"harness:claude": true,
		});
	});
});

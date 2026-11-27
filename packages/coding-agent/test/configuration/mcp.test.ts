import { join } from "node:path";
import "../../src/octocode/mcp-host/core-install.ts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { type Sandbox, createSandbox, write } from "../discovery/fixtures.ts";
import { runConfigWords } from "../../src/configuration/command.ts";
import { configuration, readJson } from "./helpers.ts";

let sandbox: Sandbox;
let globalFile: string;
let projectFile: string;
beforeEach(() => {
	sandbox = createSandbox();
	globalFile = join(sandbox.home, ".octocode", "mcp.json");
	projectFile = join(sandbox.cwd, ".octocode", "mcp.json");
	write(globalFile, JSON.stringify({ mcpServers: { docs: { command: "docs-server" } } }));
});
afterEach(() => sandbox.cleanup());

describe("mcp:<name>", () => {
	it("lists servers, disables in the defining file and re-enables by dropping the key", async () => {
		const catalog = configuration(sandbox);
		expect(await catalog.get("mcp:docs")).toMatchObject({
			value: true,
			appliesWhen: "next-session",
			valueType: { type: "toggle" },
		});
		const result = await catalog.apply({ verb: "disable", id: "mcp:docs" });
		expect(result).toMatchObject({ status: "applied", appliesWhen: "next-session" });
		expect(readJson(globalFile)?.mcpServers.docs).toEqual({ command: "docs-server", enabled: false });
		expect(await catalog.get("mcp:docs")).toMatchObject({ value: false });
		await catalog.apply({ verb: "enable", id: "mcp:docs" });
		expect(readJson(globalFile)?.mcpServers.docs).toEqual({ command: "docs-server" });
	});

	it("describes each server with its group and file, as the /harness row does", async () => {
		write(join(sandbox.cwd, ".mcp.json"), JSON.stringify({ mcpServers: { tracker: { command: "tracker-server" } } }));
		const catalog = configuration(sandbox);
		expect((await catalog.get("mcp:docs"))?.detail).toMatch(/^Global · .*\.octocode\/mcp\.json$/);
		expect((await catalog.get("mcp:tracker"))?.detail).toMatch(/^Workspace · .*\.mcp\.json$/);
	});

	it("writes a project override and leaves the global file alone", async () => {
		await configuration(sandbox).apply({ verb: "disable", id: "mcp:docs", scope: "project" });
		expect(readJson(projectFile)?.mcpServers.docs).toEqual({ enabled: false });
		expect(readJson(globalFile)?.mcpServers.docs).toEqual({ command: "docs-server" });
	});

	it("uses the session's live switch when the context has one", async () => {
		const mcpSwitch = vi.fn(async () => ({ ok: true, message: "docs: disabled" }));
		const result = await configuration(sandbox, { live: { mcpSwitch } }).apply({
			verb: "disable",
			id: "mcp:docs",
			scope: "project",
		});
		expect(mcpSwitch).toHaveBeenCalledWith({ name: "docs", enabled: false, inProject: true });
		expect(result).toMatchObject({ status: "applied", appliesWhen: "now" });
		expect(readJson(globalFile)?.mcpServers.docs).toEqual({ command: "docs-server" });
	});

	it("adds and removes servers with the arguments `octocode mcp add` builds", async () => {
		const catalog = configuration(sandbox);
		const added = await catalog.apply({ verb: "add", id: "mcp:fresh", value: { command: "fresh", args: ["--x"] } });
		expect(added.status).toBe("applied");
		// A new definition is saved off and unassigned, as `octocode mcp add` and Add MCP save it (was: as given).
		const off = { enabled: false, defaultActive: false };
		expect(readJson(globalFile)?.mcpServers.fresh).toEqual({ command: "fresh", args: ["--x"], ...off });
		await catalog.apply({ verb: "add", id: "mcp:local", value: { url: "https://example.com/mcp" }, scope: "project" });
		expect(readJson(projectFile)?.mcpServers.local).toEqual({ url: "https://example.com/mcp", ...off });
		expect((await catalog.apply({ verb: "remove", id: "mcp:fresh" })).status).toBe("applied");
		expect(readJson(globalFile)?.mcpServers.fresh).toBeUndefined();
		expect(await catalog.apply({ verb: "remove", id: "mcp:fresh" })).toMatchObject({ status: "refused" });
	});

	it("says a new server was saved off and unassigned, and where to approve it", async () => {
		const added = await configuration(sandbox).apply({ verb: "add", id: "mcp:fresh", value: { command: "fresh" } });
		expect(added).toMatchObject({ status: "applied" });
		const message = added.status === "applied" ? added.message : "";
		expect(message).toMatch(/^Saved global MCP server "fresh" off and unassigned in /);
		expect(message).toContain("approve it in /security");
		expect(message).not.toContain("Added");
	});

	it("shows a server the security review holds back as off until approved, whatever its switch", async () => {
		// The first load records the servers already configured as approved; one added after it is reviewed as new.
		await configuration(sandbox).list({ kinds: ["mcp"] });
		const servers = readJson(globalFile)?.mcpServers;
		write(globalFile, JSON.stringify({ mcpServers: { ...servers, fresh: { command: "fresh-server" } } }));
		const catalog = configuration(sandbox);
		const held = "not checked: off until you approve it in /security";
		expect(await catalog.get("mcp:fresh")).toMatchObject({ value: true, state: held });
		expect((await catalog.get("mcp:docs"))?.state).toBeUndefined();
		const got = (await runConfigWords(catalog, ["get", "mcp:fresh"], "/settings")).lines.join("\n");
		expect(got).toContain(`value: ${held} (set by global`);
		const listed = (await runConfigWords(catalog, ["list", "mcp"], "/settings")).lines.join("\n");
		expect(listed).toMatch(new RegExp(`mcp:fresh\\s+${held}`));
		expect(listed).toMatch(/mcp:docs\s+on\s/);
		const enabled = await catalog.apply({ verb: "enable", id: "mcp:fresh" });
		expect(enabled.status === "applied" && enabled.message).toContain("approve it in /security");
	});

	it("reviews the servers already configured before an add in a fresh home, so the new one is not approved with them", async () => {
		// No session has run the security review yet: `docs` is the user's older server, `demo` is added now.
		const catalog = configuration(sandbox);
		await catalog.apply({ verb: "add", id: "mcp:demo", value: { command: "demo-server" } });
		await catalog.apply({ verb: "enable", id: "mcp:demo" });
		expect(await catalog.get("mcp:demo")).toMatchObject({
			state: "not checked: off until you approve it in /security",
		});
		expect((await catalog.get("mcp:docs"))?.state).toBeUndefined();
	});

	it("refuses an invalid definition, unknown names, untrusted project and run scope", async () => {
		const catalog = configuration(sandbox);
		expect(await catalog.apply({ verb: "add", id: "mcp:bad", value: { args: ["x"] } })).toMatchObject({
			status: "refused",
		});
		expect(await catalog.apply({ verb: "disable", id: "mcp:doc" })).toMatchObject({
			status: "refused",
			suggestions: expect.arrayContaining(["mcp:docs"]),
		});
		expect(
			await configuration(sandbox, { trusted: false }).apply({
				verb: "add",
				id: "mcp:p",
				value: { command: "p" },
				scope: "project",
			}),
		).toMatchObject({ status: "refused", reason: expect.stringContaining("not trusted") });
		expect(await catalog.apply({ verb: "disable", id: "mcp:docs", scope: "run" })).toMatchObject({ status: "refused" });
		expect(readJson(projectFile)).toBeUndefined();
		expect(readJson(globalFile)?.mcpServers.docs).toEqual({ command: "docs-server" });
	});
});

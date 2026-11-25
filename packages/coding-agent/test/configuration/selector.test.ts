import { stripVTControlCharacters } from "node:util";
import "../../src/octocode/mcp-host/core-install.ts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ConfigEntry, ConfigOp, ConfigResult } from "../../src/configuration/index.ts";
import { ConfigurationSelectorComponent } from "../../src/modes/interactive/components/configuration-selector.ts";
import { initTheme } from "../../src/theme/theme.ts";
import { type Sandbox, createSandbox } from "../discovery/fixtures.ts";
import { configuration, globalSettingsFile, projectSettingsFile, readJson } from "./helpers.ts";

let sandbox: Sandbox;
beforeEach(() => {
	sandbox = createSandbox();
	initTheme("dark", false);
});
afterEach(() => sandbox.cleanup());

async function open(trusted = true) {
	const catalog = configuration(sandbox, { trusted });
	const selector = new ConfigurationSelectorComponent({
		entries: await catalog.list({ kinds: ["tool"] }),
		apply: (op) => catalog.apply(op),
		get: (id) => catalog.get(id),
		onClose: vi.fn(),
		requestRender: vi.fn(),
		projectAvailable: trusted,
	});
	return selector;
}

describe("configuration selector", () => {
	it("filters by typing, toggles with Enter and writes the scope Tab chose", async () => {
		const selector = await open();
		for (const key of "timer") selector.handleInput(key);
		const text = () => stripVTControlCharacters(selector.render(120).join("\n"));
		expect(text()).toContain("tool:timer");
		expect(text()).not.toContain("tool:backlog");
		selector.handleInput("\r");
		await vi.waitFor(() => expect(readJson(globalSettingsFile(sandbox))?.defaultTools).toEqual(["-timer"]));
		expect(text()).toContain("applies in the next session");
		selector.handleInput("\t");
		expect(selector.getScope()).toBe("project");
		// The project row starts from the value that applies (off, from the global file), so Enter turns it on there.
		expect(text()).toContain("tool:timer");
		expect(text()).not.toContain("tool:backlog");
		selector.handleInput("\r");
		await vi.waitFor(() => expect(readJson(projectSettingsFile(sandbox))?.defaultTools).toEqual(["+timer"]));
	});

	it("shows the active scope when a change to the previous scope finishes", async () => {
		const catalog = configuration(sandbox);
		await catalog.apply({ verb: "enable", id: "tool:timer", scope: "project" });
		let release!: () => void;
		const pending = new Promise<void>((resolve) => {
			release = resolve;
		});
		const render = vi.fn();
		const selector = new ConfigurationSelectorComponent({
			entries: await catalog.list({ kinds: ["tool"] }),
			apply: async (op) => {
				await pending;
				return catalog.apply(op);
			},
			get: (id) => catalog.get(id),
			onClose: vi.fn(),
			requestRender: render,
			projectAvailable: true,
		});
		for (const key of "timer") selector.handleInput(key);
		selector.handleInput("\r");
		selector.handleInput("\t");
		release();
		await vi.waitFor(() => expect(readJson(globalSettingsFile(sandbox))?.defaultTools).toEqual(["-timer"]));
		await vi.waitFor(() => expect(render).toHaveBeenCalledTimes(2));
		const text = stripVTControlCharacters(selector.render(120).join("\n"));
		expect(selector.getScope()).toBe("project");
		expect(text).toMatch(/tool:timer +on/);
		expect(readJson(projectSettingsFile(sandbox))?.defaultTools).toEqual(["+timer"]);
	});

	it("keeps a filtered selected setting while switching scopes", async () => {
		const selector = await open();
		for (const key of "tool:") selector.handleInput(key);
		selector.handleInput("\x1b[B");
		selector.handleInput("\x1b[B");
		const selected = () => stripVTControlCharacters(selector.render(120).join("\n")).match(/^› (\S+)/m)?.[1];
		const id = selected();
		expect(id).toBeDefined();
		selector.handleInput("\t");
		expect(selected()).toBe(id);
		selector.handleInput("\t");
		expect(selected()).toBe(id);
	});

	it("shows a held-back entry's state where on and off show, and Enter still flips its switch", async () => {
		const held = "not checked: off until you approve it in /security";
		let on = true;
		const entry = (): ConfigEntry => ({
			id: "mcp:fresh",
			kind: "mcp",
			label: "fresh",
			valueType: { type: "toggle" },
			value: on,
			...(on ? { state: held } : {}),
			scopes: { global: on },
			setBy: "global",
			appliesWhen: "next-session",
		});
		const apply = vi.fn(async (op: ConfigOp): Promise<ConfigResult> => {
			on = op.verb === "enable";
			return {
				status: "applied",
				id: op.id,
				verb: "enable",
				scope: "global",
				appliesWhen: "next-session",
				message: "ok",
			};
		});
		const selector = new ConfigurationSelectorComponent({
			entries: [entry()],
			apply,
			get: async () => entry(),
			onClose: vi.fn(),
			requestRender: vi.fn(),
			projectAvailable: false,
		});
		const text = () => stripVTControlCharacters(selector.render(120).join("\n"));
		expect(text()).toMatch(new RegExp(`mcp:fresh +${held}`));
		selector.handleInput("\r");
		await vi.waitFor(() =>
			expect(apply).toHaveBeenLastCalledWith({ verb: "disable", id: "mcp:fresh", scope: "global" }),
		);
		await vi.waitFor(() => expect(text()).toMatch(/mcp:fresh +off/));
		selector.handleInput("\r");
		await vi.waitFor(() =>
			expect(apply).toHaveBeenLastCalledWith({ verb: "enable", id: "mcp:fresh", scope: "global" }),
		);
		await vi.waitFor(() => expect(text()).toMatch(new RegExp(`mcp:fresh +${held}`)));
	});

	it("keeps global scope when the folder is not trusted", async () => {
		const selector = await open(false);
		selector.handleInput("\t");
		expect(selector.getScope()).toBe("global");
	});
});

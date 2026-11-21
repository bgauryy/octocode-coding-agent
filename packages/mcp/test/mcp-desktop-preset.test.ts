import { chmodSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { DESKTOP_BIN, DESKTOP_SERVER } from "../../common/src/mcp-names.ts";
import { tmp } from "../../coding-agent/test/octocode/helpers.ts";
import { presetEntries } from "../src/preset.ts";
import { withStructuredText } from "../src/presets/structured-text.ts";
import { builtinPresets } from "../src/presets/index.ts";
import { desktopPreset, onPath } from "../src/presets/desktop/index.ts";
import { boundedWindowRead } from "../src/presets/desktop/tools.ts";

/** A PATH folder holding an executable `cua-driver`. */
function pathWithDriver(): NodeJS.ProcessEnv {
	const folder = tmp();
	mkdirSync(folder, { recursive: true });
	const file = join(folder, DESKTOP_BIN);
	writeFileSync(file, "#!/bin/sh\n");
	chmodSync(file, 0o755);
	return { PATH: folder };
}

describe("desktop MCP preset", () => {
	it("is a stdio `cua-driver mcp` server that is off for the main session and never grants an existing profile", () => {
		const [entry] = presetEntries([desktopPreset(pathWithDriver())]);
		expect(entry).toMatchObject({
			name: DESKTOP_SERVER,
			scope: "default",
			config: { command: DESKTOP_BIN, args: ["mcp"], defaultActive: false, enabled: true },
		});
		expect(JSON.stringify(entry.config)).not.toContain("existing-profile");
	});

	it("keeps the rarely used tools on demand and the everyday ones declared", () => {
		const exposure = presetEntries([desktopPreset(pathWithDriver())])[0].config.toolExposure ?? {};
		for (const tool of ["kill_app", "browser_navigate", "get_config"]) expect(exposure[tool], tool).toBe("onDemand");
		// No agent installs software or rewrites Driver's configuration (telemetry included): those tools are removed.
		for (const tool of ["install_extension", "install_ffmpeg", "set_config"])
			expect(exposure[tool], tool).toBe("hidden");
		for (const tool of ["get_window_state", "click", "type_text", "launch_app"])
			expect(exposure[tool], tool).toBeUndefined();
	});

	it("declares exactly the tools recorded desktop runs used; the other known Driver tools are on demand or removed", () => {
		const exposure = presetEntries([desktopPreset(pathWithDriver())])[0].config.toolExposure ?? {};
		const declared = [
			"list_windows",
			"get_window_state",
			"verify_state",
			"launch_app",
			"invoke_menu",
			"click",
			"type_text",
			"press_key",
			"hotkey",
		];
		for (const tool of declared) expect(exposure[tool], tool).toBeUndefined();
		// Not used by a recorded live run: declared on first load, one round trip, instead of ~4,000 characters per request.
		for (const tool of ["list_apps", "get_desktop_state", "scroll", "set_value"])
			expect(exposure[tool], tool).toBe("onDemand");
	});

	it("stays listed but disabled, naming the install page, while cua-driver is not on PATH", () => {
		const [entry] = presetEntries([desktopPreset({ PATH: tmp() })]);
		expect(entry.config.enabled).toBe(false);
		expect(entry.config.description).toMatch(/not installed.*cua\.ai/i);
		expect(onPath(DESKTOP_BIN, { PATH: tmp() })).toBe(false);
	});

	it("is not enabled when OCTOCODE_MCP_DESKTOP=0, even with the binary installed", () => {
		const env = { ...pathWithDriver(), OCTOCODE_MCP_DESKTOP: "0" };
		expect(presetEntries([desktopPreset(env)])[0].config.enabled).toBe(false);
	});

	it("is one of the built-in presets", () => {
		expect(builtinPresets({ PATH: tmp() }).map((preset) => preset.name)).toContain(DESKTOP_SERVER);
	});

	it("bounds a window read that names no bound, and leaves every other call and every explicit bound alone", () => {
		expect(boundedWindowRead("get_window_state", { pid: 1, window_id: 2 })).toEqual({
			pid: 1,
			window_id: 2,
			max_depth: 3,
			max_elements: 40,
			include_screenshot: false,
		});
		// A named bound keeps its own value; the screenshot default still applies unless a picture was asked for.
		expect(boundedWindowRead("get_window_state", { pid: 1, window_id: 2, max_elements: 400 })).toEqual({
			pid: 1,
			window_id: 2,
			max_elements: 400,
			include_screenshot: false,
		});
		const asked = { pid: 1, window_id: 2, max_elements: 400, include_screenshot: true };
		expect(boundedWindowRead("get_window_state", asked)).toBe(asked);
		const saved = { pid: 1, window_id: 2, max_depth: 2, screenshot_out_file: "/x/y.png" };
		expect(boundedWindowRead("get_window_state", saved)).toBe(saved);
		const click = { pid: 1, element_token: "s1:2" };
		expect(boundedWindowRead("click", click)).toBe(click);
	});

	it("hands the model the data Driver keeps only in structuredContent, such as window ids and element tokens", () => {
		const structuredContent = { windows: [{ window_id: 4384, pid: 756 }], snapshot_id: "s1" };
		const shown = withStructuredText({ content: [{ type: "text", text: "Found 1 window(s)." }], structuredContent });
		expect(shown.content).toEqual([{ type: "text", text: `Found 1 window(s).\n${JSON.stringify(structuredContent)}` }]);
		const desktop = presetEntries([desktopPreset(pathWithDriver())]);
		expect(desktopPreset(pathWithDriver()).defineTool).toBeTypeOf("function");
		expect(desktop).toHaveLength(1);
	});
});

import "../../src/octocode/mcp-host/core-install.ts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
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
		const text = () => selector.render(120).join("\n");
		expect(text()).toContain("tool:timer");
		expect(text()).not.toContain("tool:backlog");
		selector.handleInput("\r");
		await vi.waitFor(() => expect(readJson(globalSettingsFile(sandbox))?.defaultTools).toEqual(["-timer"]));
		expect(text()).toContain("applies in the next session");
		selector.handleInput("\t");
		expect(selector.getScope()).toBe("project");
		// The project row starts from the value that applies (off, from the global file), so Enter turns it on there.
		for (const key of "timer") selector.handleInput(key);
		selector.handleInput("\r");
		await vi.waitFor(() => expect(readJson(projectSettingsFile(sandbox))?.defaultTools).toEqual(["+timer"]));
	});

	it("keeps global scope when the folder is not trusted", async () => {
		const selector = await open(false);
		selector.handleInput("\t");
		expect(selector.getScope()).toBe("global");
	});
});

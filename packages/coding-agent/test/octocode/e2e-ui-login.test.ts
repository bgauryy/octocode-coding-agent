import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { KEY, startUi, type UiHarness } from "./e2e-ui-flows/ui.ts";

/**
 * `/providers` API-key flow through the editor. The harness points the agent directory at a temp folder, so the key lands in
 * that folder's `auth.json`; the dialog's "Local auth.json file" choice is taken so no system keychain is written.
 * Nothing contacts the provider: saving a key is local.
 */
let t: UiHarness | undefined;
afterEach(async () => {
	await t?.stop();
	t = undefined;
});

const shows = (pattern: RegExp | string) => async () => {
	const text = await t!.text();
	return typeof pattern === "string" ? text.includes(pattern) : pattern.test(text);
};
const authFile = () => path.join(t!.root, "agent", "auth.json");
const saved = (): Record<string, { type: string; key?: string }> =>
	fs.existsSync(authFile()) ? JSON.parse(fs.readFileSync(authFile(), "utf8")) : {};
const openrouterModels = () =>
	t!.host.session.modelRuntime.getAvailableSnapshot().filter((model) => model.provider === "openrouter");
/** Types a slash command; the first Enter accepts the command menu, the second runs it. */
const slash = async (line: string) => {
	await t!.type(line);
	t!.press(KEY.enter);
	await new Promise((resolve) => setTimeout(resolve, 500));
	t!.press(KEY.enter);
};
/** Opens `/providers openrouter` on its "Add API key" row and returns once the key prompt shows. */
const openKeyPrompt = async () => {
	await slash("/providers openrouter");
	await t!.until(shows("Add API key"), "provider menu");
	t!.press(KEY.down);
	await new Promise((resolve) => setTimeout(resolve, 300));
	t!.press(KEY.enter);
	await t!.until(shows("Enter OpenRouter API key"), "key prompt");
};

describe("/providers API key", () => {
	it("saves the key to auth.json and makes the provider's models available", async () => {
		t = await startUi();
		expect(openrouterModels()).toHaveLength(0);
		expect(saved()).toEqual({});

		await openKeyPrompt();
		await t.type("sk-test-key-123");
		// The key is hidden while typed.
		await t.until(shows("> ***************"), "masked input");
		expect(await t.text()).not.toContain("sk-test-key-123");
		t.press(KEY.enter);
		// With a system keychain the dialog asks where to store the key; without one it stores in auth.json directly.
		await t.until(
			async () => (await shows("Where should this API key")()) || saved().openrouter !== undefined,
			"store",
		);
		if (await shows("Where should this API key")()) {
			t.press(KEY.down);
			await new Promise((resolve) => setTimeout(resolve, 300));
			t.press(KEY.enter);
		}
		await t.until(() => saved().openrouter !== undefined, "credential persisted");

		expect(saved().openrouter).toEqual({ type: "api_key", key: "sk-test-key-123" });
		await t.until(() => openrouterModels().length > 0, "models available");
		// The credential is the stored one, and the models are the ones the model picker offers.
		expect(t.host.session.modelRuntime.getProviderAuthStatus("openrouter")).toMatchObject({
			configured: true,
			source: "stored",
		});
		t.press(KEY.esc);
		await t.until(async () => !(await shows("Login to OpenRouter")()), "dialog closed");
	});

	it("Escape at the key prompt saves nothing", async () => {
		t = await startUi();
		await openKeyPrompt();
		await t.type("sk-never-saved");
		t.press(KEY.esc);
		await t.until(async () => !(await shows("Enter OpenRouter API key")()), "prompt closed");
		expect(JSON.stringify(saved())).not.toContain("sk-never-saved");
		expect(saved().openrouter).toBeUndefined();
		expect(openrouterModels()).toHaveLength(0);
	});

	it("/logout removes the saved key and the provider's models again", async () => {
		t = await startUi();
		// A credential saved the way the dialog does it, so this test covers only the removal.
		await t.host.session.modelRuntime.login(
			"openrouter",
			"api_key",
			{ prompt: async () => "sk-removed-key", notify: () => {} },
			{ getDeviceId: () => "test", agentName: "test" },
		);
		await t.until(() => saved().openrouter !== undefined, "credential persisted");
		expect(openrouterModels().length).toBeGreaterThan(0);
		await slash("/logout");
		await t.until(shows(/Remove saved credential/), "logout confirmation");
		t.press(KEY.down);
		await new Promise((resolve) => setTimeout(resolve, 300));
		t.press(KEY.enter);
		await t.until(shows(/Removed saved credential for OpenRouter/), "removal status");
		expect(saved().openrouter).toBeUndefined();
		expect(openrouterModels()).toHaveLength(0);
	});
});

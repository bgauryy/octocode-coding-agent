/** @vitest-environment jsdom */
import {
	CONFIG_PROTOCOL_VERSION,
	type ConfigProviderCommand,
	type ConfigSnapshot,
} from "@octocodeai/octocode-contracts/config";
import { cleanup, render, screen } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ConfigView } from "../src/app/config/ConfigView.tsx";

afterEach(cleanup);

const snapshot = (keychainAvailable: boolean): ConfigSnapshot => ({
	protocolVersion: CONFIG_PROTOCOL_VERSION,
	generatedAt: Date.UTC(2026, 10, 22),
	keychainAvailable,
	providers: [],
	providerTemplates: [
		{
			id: "custom-openai",
			name: "Custom OpenAI-compatible host",
			kind: "custom",
			api: "openai-completions",
			keyOptional: false,
		},
	],
	settings: [],
	writable: true,
});

const open = async (keychainAvailable: boolean) => {
	const save = vi.fn(async (_command: ConfigProviderCommand) => snapshot(keychainAvailable));
	render(<ConfigView load={async () => snapshot(keychainAvailable)} saveProvider={save} />);
	await userEvent.click(await screen.findByRole("button", { name: "Add a provider from a template" }));
	return save;
};

describe("adding a provider from a template", () => {
	it("submits the answers with the key in the keychain by default", async () => {
		const save = await open(true);
		await userEvent.type(screen.getByLabelText("Provider id"), "my-host");
		await userEvent.type(screen.getByLabelText(/^Host/), "https://llm.example.com/v1");
		await userEvent.type(screen.getByLabelText(/^Model ids/), "m1");
		await userEvent.type(screen.getByLabelText("API key", { selector: "input" }), "SENTINEL-KEY");
		await userEvent.click(screen.getByRole("button", { name: "Add provider" }));
		expect(save).toHaveBeenCalledWith(
			{
				action: "create-from-template",
				template: "custom-openai",
				provider: "my-host",
				host: "https://llm.example.com/v1",
				models: [{ id: "m1" }],
				key: { kind: "keychain", key: "SENTINEL-KEY" },
			},
			undefined,
		);
	});

	it("sends limits that differ from the shown defaults", async () => {
		const save = await open(true);
		await userEvent.type(screen.getByLabelText("Provider id"), "my-host");
		await userEvent.type(screen.getByLabelText(/^Host/), "https://llm.example.com/v1");
		await userEvent.type(screen.getByLabelText(/^Model ids/), "m1");
		await userEvent.clear(screen.getByLabelText(/^Context window/));
		await userEvent.type(screen.getByLabelText(/^Context window/), "32000");
		await userEvent.type(screen.getByLabelText("API key", { selector: "input" }), "k");
		await userEvent.click(screen.getByRole("button", { name: "Add provider" }));
		expect(save.mock.calls[0]?.[0]).toMatchObject({ models: [{ id: "m1", contextWindow: 32000 }] });
	});

	it("offers an environment variable without a keychain and plain text only after confirmation", async () => {
		const save = await open(false);
		expect(screen.queryByRole("option", { name: "Save in the OS keychain" })).toBeNull();
		await userEvent.selectOptions(screen.getByLabelText(/^API key/, { selector: "select" }), "plaintext");
		expect(screen.getByRole("button", { name: "Add provider" })).toBeDisabled();
		await userEvent.click(screen.getByRole("checkbox"));
		expect(screen.getByRole("button", { name: "Add provider" })).toBeEnabled();
		await userEvent.type(screen.getByLabelText("Provider id"), "my-host");
		await userEvent.type(screen.getByLabelText(/^Host/), "https://llm.example.com/v1");
		await userEvent.type(screen.getByLabelText(/^Model ids/), "m1");
		await userEvent.type(screen.getByLabelText("API key", { selector: "input" }), "k");
		await userEvent.click(screen.getByRole("button", { name: "Add provider" }));
		expect(save.mock.calls[0]?.[0]).toMatchObject({
			key: { kind: "plaintext", key: "k", acknowledgePlaintext: true },
		});
	});
});

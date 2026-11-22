/** @vitest-environment jsdom */
import {
	CONFIG_PROTOCOL_VERSION,
	type ConfigCredentialCommand,
	type ConfigProviderCommand,
	type ConfigSnapshot,
} from "@octocodeai/octocode-contracts/config";
import { cleanup, render, screen, within } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ConfigView } from "../src/app/config/ConfigView.tsx";

afterEach(cleanup);

const SECRET = "SENTINEL-KEY-77d1";
const snapshot = (providers: ConfigSnapshot["providers"]): ConfigSnapshot => ({
	protocolVersion: CONFIG_PROTOCOL_VERSION,
	generatedAt: Date.UTC(2026, 10, 22),
	keychainAvailable: true,
	providers,
	settings: [],
	writable: true,
});

const anthropic: ConfigSnapshot["providers"][number] = {
	provider: "anthropic",
	name: "Anthropic",
	configured: false,
	sources: [],
	auth: { keyAuth: { name: "Anthropic API key", host: { example: "llm.example.com" } } },
	baseUrl: { url: "https://api.anthropic.com", source: "default" },
};
const bedrock: ConfigSnapshot["providers"][number] = {
	provider: "amazon-bedrock",
	name: "Amazon Bedrock",
	configured: false,
	sources: [],
	auth: {
		keyAuth: {
			name: "AWS credentials or bearer token",
			host: {
				example: "bedrock-runtime.eu-central-1.amazonaws.com",
				region: true,
				apis: [
					{ id: "bedrock-converse-stream", label: "Bedrock Converse" },
					{ id: "openai-completions", label: "OpenAI-compatible Chat Completions" },
				],
			},
		},
	},
};
const gateway: ConfigSnapshot["providers"][number] = {
	provider: "gateway",
	name: "My gateway",
	configured: true,
	sources: [{ kind: "keychain" }],
	models: ["m1"],
	baseUrl: { url: "https://gw.example.com/v1", source: "models-json" },
	customEdit: { models: [{ id: "m1", contextWindow: 128000, maxOutput: 16384 }] },
};

const saveWith = (providers: ConfigSnapshot["providers"]) =>
	vi.fn(async (_command: ConfigCredentialCommand): Promise<ConfigSnapshot> => snapshot(providers));

describe("provider sign-in host step", () => {
	it("shows the effective base URL and where it comes from", async () => {
		render(<ConfigView load={async () => snapshot([anthropic, gateway])} />);
		expect(await screen.findByText("https://api.anthropic.com")).toBeInTheDocument();
		expect(screen.getByText("https://gw.example.com/v1")).toBeInTheDocument();
		expect(screen.getByText(/official host/i)).toBeInTheDocument();
		expect(screen.getByText(/models\.json/)).toBeInTheDocument();
	});

	it("asks for an optional host beside the key and sends only what was typed", async () => {
		const save = saveWith([anthropic]);
		render(<ConfigView load={async () => snapshot([anthropic])} saveCredential={save} />);
		await userEvent.click(await screen.findByRole("button", { name: "Set key for Anthropic" }));
		const host = screen.getByLabelText<HTMLInputElement>("Custom host for Anthropic (optional)");
		expect(host.placeholder).toBe("llm.example.com");
		expect(screen.queryByLabelText(/Region/)).toBeNull();
		await userEvent.type(screen.getByLabelText("API key for Anthropic"), SECRET);
		await userEvent.click(screen.getByRole("button", { name: "Save" }));
		expect(save).toHaveBeenCalledWith({ action: "set", provider: "anthropic", key: SECRET }, undefined);

		// The snapshot still lists the provider as unconfigured, so its row (and the open form) stays.
		await userEvent.type(screen.getByLabelText("Custom host for Anthropic (optional)"), " llm.example.com ");
		await userEvent.type(screen.getByLabelText("API key for Anthropic"), SECRET);
		await userEvent.click(screen.getByRole("button", { name: "Save" }));
		expect(save).toHaveBeenLastCalledWith(
			{ action: "set", provider: "anthropic", key: SECRET, host: "llm.example.com" },
			undefined,
		);
	});

	it("asks for the region and, for a host Bedrock names not, the API; neither without a host", async () => {
		const save = saveWith([bedrock]);
		render(<ConfigView load={async () => snapshot([bedrock])} saveCredential={save} />);
		await userEvent.click(await screen.findByRole("button", { name: "Set key for Amazon Bedrock" }));
		await userEvent.type(screen.getByLabelText("API key for Amazon Bedrock"), SECRET);
		expect(screen.queryByLabelText(/Which API/)).toBeNull();
		await userEvent.type(screen.getByLabelText("Custom host for Amazon Bedrock (optional)"), "proxy.example.com");
		await userEvent.type(screen.getByLabelText("Region for Amazon Bedrock (optional)"), "eu-central-1");
		await userEvent.selectOptions(screen.getByLabelText("Which API does this host serve?"), "openai-completions");
		await userEvent.click(screen.getByRole("button", { name: "Save" }));
		expect(save).toHaveBeenCalledWith(
			{
				action: "set",
				provider: "amazon-bedrock",
				key: SECRET,
				host: "proxy.example.com",
				region: "eu-central-1",
				api: "openai-completions",
			},
			undefined,
		);
	});

	it("shows the host's refusal of a bad host and keeps the form", async () => {
		const save = vi.fn(async () => {
			throw new Error("The host must use https (http is accepted only for localhost).");
		});
		render(<ConfigView load={async () => snapshot([anthropic])} saveCredential={save} />);
		await userEvent.click(await screen.findByRole("button", { name: "Set key for Anthropic" }));
		await userEvent.type(screen.getByLabelText("Custom host for Anthropic (optional)"), "http://example.com");
		await userEvent.type(screen.getByLabelText("API key for Anthropic"), SECRET);
		await userEvent.click(screen.getByRole("button", { name: "Save" }));
		expect(await screen.findByRole("alert")).toHaveTextContent(/must use https/);
		expect(screen.getByLabelText<HTMLInputElement>("Custom host for Anthropic (optional)").value).toBe(
			"http://example.com",
		);
	});

	it("offers no host field for a provider whose sign-in takes none", async () => {
		const plain = { ...anthropic, auth: { keyAuth: { name: "Key" } } };
		render(<ConfigView load={async () => snapshot([plain])} saveCredential={saveWith([plain])} />);
		await userEvent.click(await screen.findByRole("button", { name: "Set key for Anthropic" }));
		expect(screen.queryByLabelText(/Custom host/)).toBeNull();
	});
});

describe("custom provider controls", () => {
	const renderGateway = (saveProvider: (command: ConfigProviderCommand) => Promise<ConfigSnapshot>) =>
		render(<ConfigView load={async () => snapshot([gateway, anthropic])} saveProvider={saveProvider} />);

	it("offers Edit host, Edit limits and Remove only on a custom provider of models.json", async () => {
		renderGateway(vi.fn());
		expect(await screen.findByRole("button", { name: "Edit host of My gateway" })).toBeInTheDocument();
		expect(screen.getByRole("button", { name: "Edit limits of My gateway" })).toBeInTheDocument();
		expect(screen.getByRole("button", { name: "Remove My gateway" })).toBeInTheDocument();
		expect(screen.queryByRole("button", { name: "Edit host of Anthropic" })).toBeNull();
		cleanup();
		render(<ConfigView load={async () => snapshot([gateway])} />);
		await screen.findByText("https://gw.example.com/v1");
		expect(screen.queryByRole("button", { name: /Edit host|Remove/ })).toBeNull();
	});

	it("sends the new host", async () => {
		const save = vi.fn(async (_command: ConfigProviderCommand) => snapshot([gateway]));
		renderGateway(save);
		await userEvent.click(await screen.findByRole("button", { name: "Edit host of My gateway" }));
		const input = screen.getByLabelText<HTMLInputElement>("Host of My gateway");
		expect(input.value).toBe("https://gw.example.com/v1");
		await userEvent.clear(input);
		await userEvent.type(input, "new.example.com/v2");
		await userEvent.click(screen.getByRole("button", { name: "Save host" }));
		expect(save).toHaveBeenCalledWith(
			{ action: "edit-host", provider: "gateway", host: "new.example.com/v2" },
			undefined,
		);
	});

	it("sends the limits of one model", async () => {
		const save = vi.fn(async (_command: ConfigProviderCommand) => snapshot([gateway]));
		renderGateway(save);
		await userEvent.click(await screen.findByRole("button", { name: "Edit limits of My gateway" }));
		const context = screen.getByLabelText<HTMLInputElement>("Context window of m1");
		const output = screen.getByLabelText<HTMLInputElement>("Maximum output of m1");
		expect([context.value, output.value]).toEqual(["128000", "16384"]);
		await userEvent.clear(context);
		await userEvent.type(context, "32000");
		await userEvent.clear(output);
		await userEvent.type(output, "4096");
		await userEvent.click(screen.getByRole("button", { name: "Save limits of m1" }));
		expect(save).toHaveBeenCalledWith(
			{ action: "edit-limits", provider: "gateway", model: "m1", contextWindow: 32000, maxOutput: 4096 },
			undefined,
		);
	});

	it("does not send limits the page can tell are wrong", async () => {
		const save = vi.fn(async (_command: ConfigProviderCommand) => snapshot([gateway]));
		renderGateway(save);
		await userEvent.click(await screen.findByRole("button", { name: "Edit limits of My gateway" }));
		const output = screen.getByLabelText<HTMLInputElement>("Maximum output of m1");
		await userEvent.clear(output);
		await userEvent.type(output, "999999");
		expect(screen.getByRole("button", { name: "Save limits of m1" })).toBeDisabled();
		expect(save).not.toHaveBeenCalled();
	});

	it("removes the provider only after a confirmation", async () => {
		const save = vi.fn(async (_command: ConfigProviderCommand) => snapshot([anthropic]));
		renderGateway(save);
		await userEvent.click(await screen.findByRole("button", { name: "Remove My gateway" }));
		expect(save).not.toHaveBeenCalled();
		const confirm = screen.getByRole("group", { name: "Remove My gateway?" });
		expect(confirm).toHaveTextContent(/key and host/);
		await userEvent.click(within(confirm).getByRole("button", { name: "Cancel" }));
		expect(save).not.toHaveBeenCalled();
		await userEvent.click(screen.getByRole("button", { name: "Remove My gateway" }));
		await userEvent.click(screen.getByRole("button", { name: "Confirm remove My gateway" }));
		expect(save).toHaveBeenCalledWith({ action: "remove-custom", provider: "gateway" }, undefined);
	});

	it("shows the host's refusal", async () => {
		const save = vi.fn(async () => {
			throw new Error("The host must use https (http is accepted only for localhost).");
		});
		renderGateway(save);
		await userEvent.click(await screen.findByRole("button", { name: "Edit host of My gateway" }));
		await userEvent.click(screen.getByRole("button", { name: "Save host" }));
		expect(await screen.findByRole("alert")).toHaveTextContent(/must use https/);
	});
});

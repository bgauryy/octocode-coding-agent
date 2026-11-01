/** @vitest-environment jsdom */
import {
	CONFIG_PROTOCOL_VERSION,
	type ConfigCredentialCommand,
	type ConfigSnapshot,
} from "@octocodeai/octocode-contracts/config";
import { render, screen, waitFor } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { ConfigView } from "../src/app/config/ConfigView.tsx";

const SECRET = "SENTINEL-KEY-4f9a1c7e";
const base: ConfigSnapshot = {
	protocolVersion: CONFIG_PROTOCOL_VERSION,
	generatedAt: Date.UTC(2026, 9, 31),
	keychainAvailable: true,
	providers: [
		{ provider: "openai", name: "OpenAI", configured: false, sources: [] },
		{ provider: "anthropic", name: "Anthropic", configured: true, sources: [{ kind: "keychain" }] },
	],
	settings: [],
	writable: true,
};

async function openEditor(name: string) {
	await userEvent.click(await screen.findByRole("button", { name }));
}

describe("ConfigView credential editing", () => {
	it("offers no key field when the connection is read-only or no save is given", async () => {
		const view = render(<ConfigView load={async () => ({ ...base, writable: false })} saveCredential={vi.fn()} />);
		await screen.findByRole("heading", { name: "Provider credentials" });
		expect(screen.queryByRole("button", { name: /key for/i })).toBeNull();
		view.unmount();
		render(<ConfigView load={async () => base} />);
		await screen.findByRole("heading", { name: "Provider credentials" });
		expect(screen.queryByRole("button", { name: /key for/i })).toBeNull();
	});

	it("offers no editor for a provider the host marks as not editable", async () => {
		const snapshot: ConfigSnapshot = {
			...base,
			providers: [{ provider: "MyProvider", configured: true, editable: false, sources: [{ kind: "auth-json" }] }],
		};
		render(<ConfigView load={async () => snapshot} saveCredential={vi.fn()} />);
		await screen.findByRole("heading", { name: "Provider credentials" });
		expect(screen.queryByRole("button", { name: /key for|Clear credential/i })).toBeNull();
		expect(screen.getByText(/cannot be changed from this page/)).toBeInTheDocument();
	});

	it("saves a key from a password field, clears the field and never shows the key afterwards", async () => {
		const save = vi.fn(async (_command: ConfigCredentialCommand): Promise<ConfigSnapshot> => ({
			...base,
			providers: [{ provider: "openai", name: "OpenAI", configured: true, sources: [{ kind: "keychain" }] }],
		}));
		const { container } = render(<ConfigView load={async () => base} saveCredential={save} />);
		await openEditor("Set key for OpenAI");
		const input = screen.getByLabelText("API key for OpenAI") as HTMLInputElement;
		expect(input.type).toBe("password");
		expect(input.autocomplete).toBe("off");
		await userEvent.type(input, `  ${SECRET} `);
		await userEvent.click(screen.getByRole("button", { name: "Save" }));

		expect(save).toHaveBeenCalledWith({ action: "set", provider: "openai", key: SECRET }, undefined);
		// The host's fresh snapshot moves the provider to Configured, which rebuilds its row: the field and its state are gone.
		expect(await screen.findByRole("button", { name: "Replace key for OpenAI" })).toBeInTheDocument();
		expect(screen.queryByLabelText("API key for OpenAI")).toBeNull();
		expect(screen.getAllByText("OS keychain")).toHaveLength(1);
		// No DOM node (text, attribute or input value) holds the key.
		expect(container.innerHTML).not.toContain(SECRET);
		for (const node of container.querySelectorAll("input")) expect(node.value).not.toContain(SECRET);
		expect((globalThis.localStorage?.length ?? 0) + (globalThis.sessionStorage?.length ?? 0)).toBe(0);
	});

	it("replaces and clears a stored key", async () => {
		const save = vi.fn(async (_command: ConfigCredentialCommand): Promise<ConfigSnapshot> => base);
		render(<ConfigView load={async () => base} saveCredential={save} />);
		await userEvent.click(await screen.findByRole("button", { name: "Clear credential for Anthropic" }));
		expect(save).toHaveBeenCalledWith({ action: "clear", provider: "anthropic" }, undefined);
		await openEditor("Replace key for Anthropic");
		await userEvent.type(screen.getByLabelText("API key for Anthropic"), "new-key");
		await userEvent.click(screen.getByRole("button", { name: "Replace" }));
		expect(save).toHaveBeenLastCalledWith({ action: "set", provider: "anthropic", key: "new-key" }, undefined);
	});

	it("without a keychain needs the plain-text acknowledgement before Save is possible", async () => {
		const save = vi.fn(async (_command: ConfigCredentialCommand): Promise<ConfigSnapshot> => base);
		render(<ConfigView load={async () => ({ ...base, keychainAvailable: false })} saveCredential={save} />);
		await openEditor("Set key for OpenAI");
		await userEvent.type(screen.getByLabelText("API key for OpenAI"), SECRET);
		const saveButton = screen.getByRole("button", { name: "Save" });
		expect(saveButton).toBeDisabled();
		await userEvent.click(screen.getByRole("checkbox", { name: /plain text/ }));
		expect(saveButton).toBeEnabled();
		await userEvent.click(saveButton);
		expect(save).toHaveBeenCalledWith(
			{ action: "set", provider: "openai", key: SECRET, acknowledgePlaintext: true },
			undefined,
		);
	});

	it("shows the host's refusal as an alert and keeps the typed key for a retry, still hidden", async () => {
		const save = vi.fn(async () => {
			throw new Error("Could not save to the system keychain. Nothing was changed.");
		});
		const { container } = render(<ConfigView load={async () => base} saveCredential={save} />);
		await openEditor("Set key for OpenAI");
		await userEvent.type(screen.getByLabelText("API key for OpenAI"), SECRET);
		await userEvent.click(screen.getByRole("button", { name: "Save" }));
		expect(await screen.findByRole("alert")).toHaveTextContent("Could not save to the system keychain");
		await waitFor(() => expect(screen.getByRole("button", { name: "Save" })).toBeEnabled());
		expect(container.textContent).not.toContain(SECRET);
		expect((screen.getByLabelText("API key for OpenAI") as HTMLInputElement).type).toBe("password");
	});
});

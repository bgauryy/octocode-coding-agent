/** @vitest-environment jsdom */
import {
	CONFIG_PROTOCOL_VERSION,
	type ConfigProviderCommand,
	type ConfigSnapshot,
} from "@octocodeai/octocode-contracts/config";
import { cleanup, render, screen, within } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ConfigView } from "../src/app/config/ConfigView.tsx";

afterEach(cleanup);

const base: ConfigSnapshot = {
	protocolVersion: CONFIG_PROTOCOL_VERSION,
	generatedAt: Date.UTC(2026, 10, 9),
	keychainAvailable: true,
	sources: [
		{ id: "octocode", label: "Octocode", enabled: true, toggleable: false, present: true },
		{ id: "pi", label: "Pi", enabled: true, toggleable: true, present: true },
	],
	providers: [
		{
			provider: "openai",
			name: "OpenAI",
			configured: true,
			sources: [],
			origins: [{ product: "pi", file: "models-json", hasKey: true }],
		},
		{
			provider: "anthropic",
			name: "Anthropic",
			configured: true,
			sources: [{ kind: "keychain" }],
			origins: [
				{ product: "octocode", file: "auth-json" },
				{ product: "pi", file: "auth-json" },
			],
			disabled: true,
		},
	],
	settings: [],
	writable: true,
};

describe("ConfigView provider sources and switches", () => {
	it("shows cloud credential names and plan terms without claiming verified access", async () => {
		render(
			<ConfigView
				load={async () => ({
					...base,
					providers: [
						{
							provider: "cloud",
							configured: true,
							sources: [],
							auth: {
								keyAuth: { name: "AWS credentials or bearer token" },
								plan: { billing: "plan", terms: "https://example.test/terms", disabled: "Temporarily paused" },
							},
						},
					],
				})}
			/>,
		);
		expect(await screen.findByText(/AWS credentials or bearer token/)).toBeInTheDocument();
		expect(screen.getByText(/access has not been verified/)).toBeInTheDocument();
		expect(screen.getByRole("link", { name: "Plan terms" })).toHaveAttribute("href", "https://example.test/terms");
		expect(screen.getByText(/Billed by plan/)).toBeInTheDocument();
		expect(screen.getByRole("status")).toHaveTextContent("Paused: Temporarily paused");
	});
	it("shows each provider's route", async () => {
		render(
			<ConfigView
				load={async () => ({
					...base,
					providers: [
						{ provider: "metered", configured: true, sources: [], route: "config" },
						{ provider: "plan", configured: true, sources: [], route: "subscription" },
						{ provider: "runner", configured: true, sources: [], route: "external" },
					],
				})}
			/>,
		);
		expect(await screen.findByText("Route: config")).toBeInTheDocument();
		expect(screen.getByText("Route: subscription")).toBeInTheDocument();
		expect(screen.getByText("Route: external")).toBeInTheDocument();
	});
	it("shows a models.json-only provider with its models, and says its key variable is unset", async () => {
		const snapshot: ConfigSnapshot = {
			...base,
			providers: [
				{
					provider: "acme",
					name: "Acme Gateway",
					models: ["acme-large", "acme-small"],
					configured: false,
					sources: [],
					origins: [{ product: "octocode", file: "models-json", hasKey: true, keyUnset: true }],
				},
			],
		};
		render(<ConfigView load={async () => snapshot} saveProvider={vi.fn()} />);
		expect(await screen.findByText("Acme Gateway")).toBeInTheDocument();
		expect(within(screen.getByText("Acme Gateway").closest("li")!).getByText("Not configured")).toBeInTheDocument();
		expect(screen.getByText("acme-large, acme-small")).toBeInTheDocument();
		expect(screen.getByText("Octocode models.json (key variable not set)")).toBeInTheDocument();
	});

	it("shows the sources and where each provider is configured", async () => {
		render(<ConfigView load={async () => base} saveProvider={vi.fn()} />);
		const sources = await screen.findByRole("list", { name: "Provider sources" });
		expect(within(sources).getByText("Always on")).toBeInTheDocument();
		expect(within(sources).getByText("On")).toBeInTheDocument();
		expect(screen.getByText("Pi models.json (API key set)")).toBeInTheDocument();
		expect(screen.getAllByText("Pi auth.json").length).toBe(1);
		expect(screen.getByText("Octocode auth.json")).toBeInTheDocument();
		expect(screen.getByText("Disabled")).toBeInTheDocument();
		// Octocode has no switch.
		expect(screen.queryByRole("button", { name: /Turn off Octocode/ })).toBeNull();
	});

	it("sends typed commands and shows the fresh snapshot", async () => {
		const save = vi.fn(async (command: ConfigProviderCommand): Promise<ConfigSnapshot> => {
			if (command.action === "set-source")
				return { ...base, sources: base.sources!.map((s) => (s.id === "pi" ? { ...s, enabled: false } : s)) };
			return {
				...base,
				providers: base.providers.map((row) => (row.provider === "anthropic" ? { ...row, disabled: undefined } : row)),
			};
		});
		render(<ConfigView load={async () => base} saveProvider={save} />);
		await userEvent.click(await screen.findByRole("button", { name: "Turn off Pi" }));
		expect(save).toHaveBeenCalledWith({ action: "set-source", source: "pi", enabled: false }, undefined);
		expect(await screen.findByRole("button", { name: "Turn on Pi" })).toBeInTheDocument();
		await userEvent.click(screen.getByRole("button", { name: "Enable Anthropic" }));
		expect(save).toHaveBeenLastCalledWith({ action: "set-provider", provider: "anthropic", enabled: true }, undefined);
		expect(await screen.findByRole("button", { name: "Disable Anthropic" })).toBeInTheDocument();
		await userEvent.click(screen.getByRole("button", { name: "Disable OpenAI" }));
		expect(save).toHaveBeenLastCalledWith({ action: "set-provider", provider: "openai", enabled: false }, undefined);
	});

	it("shows the host's refusal and offers no switch when read-only", async () => {
		const save = vi.fn(async () => {
			throw new Error("The global settings file is invalid.");
		});
		const view = render(<ConfigView load={async () => base} saveProvider={save} />);
		await userEvent.click(await screen.findByRole("button", { name: "Turn off Pi" }));
		expect(await screen.findByText("The global settings file is invalid.")).toBeInTheDocument();
		view.unmount();
		render(<ConfigView load={async () => ({ ...base, writable: false })} saveProvider={save} />);
		await screen.findByRole("list", { name: "Provider sources" });
		expect(screen.queryByRole("button", { name: /Turn (on|off)|Enable|Disable/ })).toBeNull();
		expect(screen.getByText("Pi models.json (API key set)")).toBeInTheDocument();
	});
});

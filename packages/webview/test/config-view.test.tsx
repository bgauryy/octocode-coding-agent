/** @vitest-environment jsdom */
import { CONFIG_PROTOCOL_VERSION, type ConfigSnapshot } from "@octocodeai/octocode-contracts/config";
import { render, screen, waitFor, within } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { ConfigView } from "../src/app/config/ConfigView.tsx";

const NOW = Date.UTC(2026, 9, 29, 12, 0);
const snapshot: ConfigSnapshot = {
	protocolVersion: CONFIG_PROTOCOL_VERSION,
	generatedAt: NOW,
	keychainAvailable: true,
	providers: [
		{
			provider: "openai",
			name: "OpenAI",
			configured: true,
			sources: [{ kind: "keychain" }, { kind: "env", envVar: "OPENAI_API_KEY" }],
		},
		{ provider: "anthropic", name: "Anthropic", configured: true, sources: [{ kind: "auth-json" }] },
		{ provider: "groq", name: "Groq", configured: true, sources: [{ kind: "custom-command" }] },
		{
			provider: "openai-codex",
			name: "ChatGPT",
			configured: true,
			sources: [{ kind: "oauth", expiresAt: NOW + 3_600_000 }],
		},
		{ provider: "xai", name: "xAI", configured: false, sources: [] },
	],
	settings: [
		{ key: "defaultProvider", value: "openai", source: "global" },
		{ key: "defaultModel", source: "default" },
	],
	workspace: { repo: "octo-repo", trusted: false },
};

function renderView(load: () => Promise<ConfigSnapshot>) {
	return render(<ConfigView load={load} />);
}
function row(name: string): HTMLElement {
	const found = screen.getByText(name).closest("li");
	if (!found) throw new Error(`no row for ${name}`);
	return found;
}

describe("ConfigView", () => {
	it("announces loading while the snapshot is pending", () => {
		renderView(() => new Promise(() => {}));
		expect(screen.getByLabelText("Loading settings")).toBeInTheDocument();
	});

	it("lists providers with each source named in words", async () => {
		renderView(async () => snapshot);
		await screen.findByRole("heading", { name: "Provider credentials" });

		const openai = within(row("OpenAI"));
		expect(openai.getByText("Configured")).toBeInTheDocument();
		expect(openai.getByText("OS keychain")).toBeInTheDocument();
		expect(openai.getByText("OPENAI_API_KEY")).toBeInTheDocument();
		expect(openai.getByRole("list", { name: "Credential sources for OpenAI" })).toBeInTheDocument();

		const anthropic = within(row("Anthropic"));
		expect(anthropic.getByText("Plaintext in auth.json")).toBeInTheDocument();
		expect(anthropic.getByText(/OS keychain is possible from the page opened in the terminal/)).toBeInTheDocument();

		expect(within(row("Groq")).getByText("Custom command")).toBeInTheDocument();
		const codex = within(row("ChatGPT"));
		expect(codex.getByText("Signed in")).toBeInTheDocument();
		expect(codex.getByText(/Access token expires/)).toBeInTheDocument();

		const notConfigured = screen.getByRole("list", { name: "Not configured" });
		expect(within(notConfigured).getByText("xAI")).toBeInTheDocument();
		expect(within(notConfigured).getByText("Not configured")).toBeInTheDocument();
	});

	it("says an OAuth access token has expired", async () => {
		const expired: ConfigSnapshot = {
			...snapshot,
			providers: [{ provider: "openai-codex", configured: true, sources: [{ kind: "oauth", expiresAt: NOW - 1000 }] }],
		};
		renderView(async () => expired);
		expect(await screen.findByText(/Access token expired/)).toBeInTheDocument();
	});

	it("does not claim an effective source", async () => {
		renderView(async () => snapshot);
		expect(await screen.findByText(/does not say\s+which one a request uses/)).toBeInTheDocument();
	});

	it("shows settings with their source and a pointer to the terminal", async () => {
		renderView(async () => snapshot);
		const list = await screen.findByRole("list", { name: "Settings" });
		const provider = within(within(list).getByText("defaultProvider").closest("li") as HTMLElement);
		expect(provider.getByText("openai")).toBeInTheDocument();
		expect(provider.getByText("Global")).toBeInTheDocument();
		const model = within(within(list).getByText("defaultModel").closest("li") as HTMLElement);
		expect(model.getByText("Not set")).toBeInTheDocument();
		expect(model.getByText("Default")).toBeInTheDocument();
		expect(screen.getByText("/model")).toBeInTheDocument();
	});

	it("shows workspace trust in words, and why untrusted settings are ignored", async () => {
		const view = renderView(async () => snapshot);
		const workspace = await screen.findByRole("region", { name: "Workspace" });
		expect(within(workspace).getByText("octo-repo")).toBeInTheDocument();
		expect(within(workspace).getByText("Not trusted")).toBeInTheDocument();
		expect(within(workspace).getByText(/ignored until you trust/)).toBeInTheDocument();
		view.unmount();

		renderView(async () => ({ ...snapshot, workspace: { repo: "octo-repo", trusted: true } }));
		expect(await screen.findByText("Trusted")).toBeInTheDocument();
	});

	it("says when there is no workspace", async () => {
		renderView(async () => ({ ...snapshot, workspace: undefined }));
		expect(await screen.findByText(/No workspace selected/)).toBeInTheDocument();
	});

	it("points to the terminal when no provider has a credential", async () => {
		renderView(async () => ({
			...snapshot,
			providers: snapshot.providers.map((provider) => ({ ...provider, configured: false, sources: [] })),
		}));
		expect(await screen.findByText(/No provider has a credential yet/)).toBeInTheDocument();
		expect(screen.getByRole("list", { name: "Not configured" })).toBeVisible();
	});

	it("has an empty state when the snapshot lists no providers", async () => {
		renderView(async () => ({ ...snapshot, providers: [] }));
		expect(await screen.findByText("No providers")).toBeInTheDocument();
	});

	it("shows credential and settings file errors as alerts", async () => {
		renderView(async () => ({
			...snapshot,
			credentialsError: "auth.json could not be read; only environment variables are shown.",
			settingsErrors: [{ scope: "workspace", message: "This settings file is invalid." }],
		}));
		const alerts = await screen.findAllByRole("alert");
		expect(alerts.map((alert) => alert.textContent)).toEqual([
			"auth.json could not be read; only environment variables are shown.",
			"Workspace settings file: This settings file is invalid.",
		]);
	});

	it("shows a load error and retries", async () => {
		const load = vi
			.fn<() => Promise<ConfigSnapshot>>()
			.mockRejectedValueOnce(new Error("401 unauthorized"))
			.mockResolvedValue(snapshot);
		renderView(load);
		expect(await screen.findByRole("alert")).toHaveTextContent("Can't load settings: 401 unauthorized");
		await userEvent.click(screen.getByRole("button", { name: "Try again" }));
		expect(await screen.findByRole("heading", { name: "Provider credentials" })).toBeInTheDocument();
		expect(load).toHaveBeenCalledTimes(2);
	});

	it("refreshes on request and keeps showing the last snapshot meanwhile", async () => {
		const load = vi.fn<() => Promise<ConfigSnapshot>>().mockResolvedValue(snapshot);
		renderView(load);
		await screen.findByRole("heading", { name: "Settings" });
		load.mockResolvedValue({ ...snapshot, workspace: { repo: "octo-repo", trusted: true } });
		await userEvent.click(screen.getByRole("button", { name: "Refresh" }));
		await waitFor(() => expect(screen.getByText("Trusted")).toBeInTheDocument());
		expect(load).toHaveBeenCalledTimes(2);
	});

	it("does not refetch when the parent passes a new load function", async () => {
		const first = vi.fn<() => Promise<ConfigSnapshot>>().mockResolvedValue(snapshot);
		const second = vi.fn<() => Promise<ConfigSnapshot>>().mockResolvedValue(snapshot);
		const view = renderView(first);
		await screen.findByRole("heading", { name: "Settings" });
		view.rerender(<ConfigView load={second} />);
		await userEvent.click(screen.getByRole("button", { name: "Refresh" }));
		await waitFor(() => expect(second).toHaveBeenCalledTimes(1));
		expect(first).toHaveBeenCalledTimes(1);
	});

	it("renders no value for a credential: only kinds, names and labels", async () => {
		const secret = "SENTINEL-SECRET-4f9c";
		// A snapshot that did carry a value would be rejected by the host's schema; the view must not render unknown fields either.
		const leaky = {
			...snapshot,
			providers: [{ provider: "openai", configured: true, sources: [{ kind: "auth-json", key: secret }] }],
		} as unknown as ConfigSnapshot;
		const view = renderView(async () => leaky);
		await screen.findByText("Plaintext in auth.json");
		expect(view.container.innerHTML).not.toContain(secret);
	});
});

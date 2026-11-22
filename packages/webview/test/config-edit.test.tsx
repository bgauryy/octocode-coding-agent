/** @vitest-environment jsdom */
import {
	CONFIG_PROTOCOL_VERSION,
	type ConfigSettingCommand,
	type ConfigSnapshot,
} from "@octocodeai/octocode-contracts/config";
import { render, screen, waitFor, within } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { ConfigView } from "../src/app/config/ConfigView.tsx";
import { SettingEditor } from "../src/app/config/SettingEditor.tsx";

const base: ConfigSnapshot = {
	protocolVersion: CONFIG_PROTOCOL_VERSION,
	generatedAt: Date.UTC(2026, 9, 31),
	keychainAvailable: true,
	providers: [],
	settings: [
		{ key: "defaultProvider", value: "openai", source: "global" },
		{ key: "defaultModel", source: "default" },
	],
	writable: true,
};
const repos = [{ id: "r1", name: "octo-repo" }];

function editor(_key: string) {
	return within(screen.getByRole("form", { name: "Change startup model" }));
}

describe("ConfigView settings editing", () => {
	it("explains workspace precedence when a paired default is saved globally", async () => {
		const snapshot = {
			...base,
			settings: base.settings.map((setting) => ({ ...setting, source: "workspace" as const })),
			workspace: { repo: "octo-repo", trusted: true },
		};
		const save = vi.fn(async () => snapshot);
		render(<ConfigView load={async () => snapshot} save={save} repos={repos} />);
		await screen.findByRole("heading", { name: "Settings" });
		const form = editor("defaultModel");
		await userEvent.selectOptions(form.getByLabelText("File for defaultModel"), "global");
		await userEvent.type(form.getByLabelText("Value for defaultModel"), "model");
		await userEvent.click(form.getByRole("button", { name: "Save" }));
		expect(await form.findByRole("status")).toHaveTextContent("Workspace defaults still take precedence here.");
	});
	it("tells where hosts and custom providers are defined", async () => {
		const snapshot = { ...base, modelsPath: "/home/u/.octocode/agent/models.json" };
		render(<ConfigView load={async () => snapshot} save={vi.fn()} />);
		await screen.findByRole("heading", { name: "Settings" });
		expect(editor("defaultModel").getByText(/defined in models\.json/)).toHaveTextContent(
			"/home/u/.octocode/agent/models.json",
		);
	});

	it("has no editor when the host does not allow writes or no save is given", async () => {
		const save = vi.fn();
		const view = render(<ConfigView load={async () => ({ ...base, writable: false })} save={save} />);
		await screen.findByRole("heading", { name: "Settings" });
		expect(screen.queryByRole("form")).toBeNull();
		expect(screen.getByText(/Read-only here/)).toBeInTheDocument();
		view.unmount();

		render(<ConfigView load={async () => base} />);
		await screen.findByRole("heading", { name: "Settings" });
		expect(screen.queryByRole("form")).toBeNull();
	});

	it("saves a global value, then shows the host's fresh snapshot and when the default applies", async () => {
		const save = vi.fn(async (command: ConfigSettingCommand): Promise<ConfigSnapshot> => ({
			...base,
			settings:
				command.key === "modelDefault" && command.value
					? [
							{ key: "defaultProvider", value: command.value.provider, source: "global" },
							{ key: "defaultModel", value: command.value.model, source: "global" },
						]
					: base.settings,
		}));
		render(<ConfigView load={async () => base} save={save} />);
		await screen.findByRole("heading", { name: "Settings" });

		const form = editor("defaultProvider");
		const input = form.getByLabelText("Default provider");
		await userEvent.clear(input);
		await userEvent.type(input, "  anthropic ");
		await userEvent.type(form.getByLabelText("Value for defaultModel"), "claude-example");
		await userEvent.click(form.getByRole("button", { name: "Save" }));

		expect(save).toHaveBeenCalledWith({
			key: "modelDefault",
			scope: "global",
			value: { provider: "anthropic", model: "claude-example" },
		});
		expect(await form.findByRole("status")).toHaveTextContent(
			"Saved to global settings. Model defaults apply to new sessions; the current chat keeps its model.",
		);
		const row = screen.getByText("defaultProvider").closest("li") as HTMLElement;
		expect(within(row).getAllByText("anthropic").length).toBeGreaterThan(0);
	});

	it("clears a setting in the chosen file", async () => {
		const save = vi.fn(async (): Promise<ConfigSnapshot> => ({
			...base,
			settings: [{ key: "defaultProvider", source: "default" }, base.settings[1]],
		}));
		render(<ConfigView load={async () => base} save={save} />);
		await screen.findByRole("heading", { name: "Settings" });
		const form = editor("defaultProvider");
		await userEvent.click(form.getByRole("button", { name: "Clear" }));
		expect(save).toHaveBeenCalledWith({ key: "modelDefault", scope: "global", value: null });
		expect(await form.findByRole("status")).toHaveTextContent("Cleared in global settings");
		expect(form.getByLabelText("Default provider")).toHaveValue("");
	});

	it("shows the host's refusal as an alert and keeps the typed value", async () => {
		const save = vi.fn().mockRejectedValue(new Error("The global settings file is invalid, so it was not changed."));
		render(<ConfigView load={async () => base} save={save} />);
		await screen.findByRole("heading", { name: "Settings" });
		const form = editor("defaultModel");
		await userEvent.type(form.getByLabelText("Value for defaultModel"), "gpt-5");
		await userEvent.click(form.getByRole("button", { name: "Save" }));
		expect(await form.findByRole("alert")).toHaveTextContent("settings file is invalid");
		expect(form.getByLabelText("Value for defaultModel")).toHaveValue("gpt-5");
	});

	it("does not save an empty value", async () => {
		const save = vi.fn();
		render(<ConfigView load={async () => base} save={save} />);
		await screen.findByRole("heading", { name: "Settings" });
		expect(editor("defaultModel").getByRole("button", { name: "Save" })).toBeDisabled();
		expect(save).not.toHaveBeenCalled();
	});

	it("offers the workspace file only for a chosen, trusted workspace, and sends its repository", async () => {
		const untrusted: ConfigSnapshot = { ...base, workspace: { repo: "octo-repo", trusted: false } };
		const trusted: ConfigSnapshot = { ...base, workspace: { repo: "octo-repo", trusted: true } };
		const load = vi.fn(async (repoId?: string) => (repoId ? untrusted : base));
		const save = vi.fn(async (): Promise<ConfigSnapshot> => trusted);
		render(<ConfigView load={load} save={save} repos={repos} />);
		await screen.findByRole("heading", { name: "Settings" });
		expect(editor("defaultModel").getByRole("option", { name: /Workspace settings/ })).toBeDisabled();

		await userEvent.selectOptions(screen.getByRole("combobox", { name: "Workspace" }), "r1");
		await waitFor(() => expect(load).toHaveBeenLastCalledWith("r1"));
		await screen.findByText("Not trusted");
		expect(editor("defaultModel").getByRole("option", { name: /needs a trusted workspace/ })).toBeDisabled();

		load.mockResolvedValue(trusted);
		await userEvent.click(screen.getByRole("button", { name: "Refresh" }));
		await screen.findByText("Trusted");
		const form = editor("defaultModel");
		await userEvent.selectOptions(form.getByLabelText("File for defaultModel"), "workspace");
		await userEvent.type(form.getByLabelText("Value for defaultModel"), "gpt-5");
		await userEvent.click(form.getByRole("button", { name: "Save" }));
		expect(save).toHaveBeenCalledWith({
			key: "modelDefault",
			scope: "workspace",
			value: { provider: "openai", model: "gpt-5" },
			repoId: "r1",
		});
	});
});

describe("setting save timing", () => {
	it.each([
		{ key: "defaultProvider", action: "Save" },
		{ key: "defaultProvider", action: "Clear" },
		{ key: "defaultModel", action: "Save" },
		{ key: "defaultModel", action: "Clear" },
	])("explains that $action of $key affects new sessions", async ({ key, action }) => {
		const save = vi.fn().mockResolvedValue(undefined);
		render(<SettingEditor setting={{ key, value: "fixture-value", source: "global" }} save={save} />);

		await userEvent.click(screen.getByRole("button", { name: action }));

		expect(save).toHaveBeenCalledWith({ key, scope: "global", value: action === "Clear" ? null : "fixture-value" });
		const status = await screen.findByRole("status");
		expect(status).toHaveTextContent("Model defaults apply to new sessions; the current chat keeps its model.");
		expect(status).not.toHaveTextContent("/reload");
	});

	it("retains reload guidance for other settings", async () => {
		const save = vi.fn().mockResolvedValue(undefined);
		render(<SettingEditor setting={{ key: "theme", value: "dark", source: "global" }} save={save} />);

		await userEvent.click(screen.getByRole("button", { name: "Save" }));

		expect(await screen.findByRole("status")).toHaveTextContent(
			"Saved to global settings. Running sessions pick it up with /reload.",
		);
	});
});

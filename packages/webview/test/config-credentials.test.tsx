/** @vitest-environment jsdom */
import {
	CONFIG_PROTOCOL_VERSION,
	type ConfigCredentialCommand,
	type ConfigSnapshot,
	type SignInCommand,
	type SignInState,
} from "@octocodeai/octocode-contracts/config";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
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
		expect(screen.getByLabelText<HTMLInputElement>("API key for OpenAI").type).toBe("password");
	});
});

describe("ConfigView sign-in", () => {
	const withAuth: ConfigSnapshot = {
		...base,
		providers: [
			{
				provider: "openai",
				name: "OpenAI",
				configured: false,
				sources: [],
				auth: {
					oauth: { name: "ChatGPT", isSubscription: true },
					keyAuth: { name: "OpenAI API key", keyPage: "https://platform.openai.com/api-keys" },
				},
			},
			{ provider: "anthropic", name: "Anthropic", configured: false, sources: [] },
		],
	};
	const state = (extra: Partial<SignInState>): SignInState => ({
		provider: "openai",
		status: "running",
		events: [],
		...extra,
	});

	it("names the sign-ins, links the key page and offers no Claude subscription token", async () => {
		render(<ConfigView load={async () => withAuth} saveCredential={vi.fn()} signIn={vi.fn()} />);
		expect(await screen.findByText(/Subscription sign-in · API key/)).toBeInTheDocument();
		expect(screen.getByRole("link", { name: "Get key for OpenAI" })).toHaveAttribute(
			"href",
			"https://platform.openai.com/api-keys",
		);
		// Anthropic allows a Claude subscription token only in Claude Code, so the page offers none.
		expect(screen.queryByRole("button", { name: "Use Claude subscription token" })).toBeNull();
		expect(screen.queryByText(/sk-ant-oat|claude setup-token/)).toBeNull();
	});

	it("shows the link, answers a question, then reloads the snapshot on success", async () => {
		const open = vi.fn();
		vi.stubGlobal("open", open);
		const load = vi.fn(async () => withAuth);
		const commands: SignInCommand[] = [];
		const signIn = vi.fn(async (command: SignInCommand): Promise<SignInState> => {
			commands.push(command);
			if (command.action === "start")
				return state({
					events: [{ type: "auth_url", url: "https://auth.example.com/go", instructions: "Open to sign in" }],
					prompt: { id: "p1", type: "manual_code", message: "Paste the code" },
				});
			if (command.action === "answer") return state({});
			return state({ status: "succeeded" });
		});
		render(<ConfigView load={load} saveCredential={vi.fn()} signIn={signIn} />);
		await userEvent.click(await screen.findByRole("button", { name: "Sign in with subscription for OpenAI" }));
		expect(await screen.findByRole("link", { name: "https://auth.example.com/go" })).toBeInTheDocument();
		expect(open).toHaveBeenCalledWith("https://auth.example.com/go", "_blank", "noopener,noreferrer");
		await userEvent.type(screen.getByLabelText("Paste the code"), "the-code");
		await userEvent.click(screen.getByRole("button", { name: "Continue" }));
		expect(commands).toContainEqual({ action: "answer", provider: "openai", promptId: "p1", value: "the-code" });
		await waitFor(() => expect(load.mock.calls.length).toBeGreaterThan(1), { timeout: 4000 });
		vi.unstubAllGlobals();
	});

	it("cancels a running sign-in and shows a failure", async () => {
		const signIn = vi.fn(async (command: SignInCommand): Promise<SignInState> => {
			if (command.action === "start") return state({});
			if (command.action === "cancel") return state({ status: "cancelled" });
			return state({ status: "failed", error: "Provider refused the code" });
		});
		render(<ConfigView load={async () => withAuth} saveCredential={vi.fn()} signIn={signIn} />);
		await userEvent.click(await screen.findByRole("button", { name: "Sign in with subscription for OpenAI" }));
		await userEvent.click(await screen.findByRole("button", { name: "Cancel sign-in for OpenAI" }));
		expect(await screen.findByText("Sign-in cancelled.")).toBeInTheDocument();
		signIn.mockImplementation(async (command) =>
			command.action === "start" ? state({ status: "failed", error: "Provider refused the code" }) : state({}),
		);
		await userEvent.click(screen.getByRole("button", { name: "Sign in with subscription for OpenAI" }));
		expect(await screen.findByRole("alert")).toHaveTextContent("Provider refused the code");
	});

	it("offers no sign-in on a read-only connection and does not render an unsafe link", async () => {
		const view = render(<ConfigView load={async () => ({ ...withAuth, writable: false })} signIn={vi.fn()} />);
		await screen.findByRole("heading", { name: "Provider credentials" });
		expect(screen.queryByRole("button", { name: /Sign in with/ })).toBeNull();
		view.unmount();
		const signIn = vi.fn(async () => state({ events: [{ type: "auth_url", url: "javascript:alert(1)" } as never] }));
		render(<ConfigView load={async () => withAuth} signIn={signIn} />);
		await userEvent.click(await screen.findByRole("button", { name: "Sign in with subscription for OpenAI" }));
		await screen.findByText(/Signing in to OpenAI/);
		expect(document.querySelector('a[href^="javascript"]')).toBeNull();
	});

	it("applies the page's one link policy to key pages and sign-in links", async () => {
		const open = vi.fn();
		vi.stubGlobal("open", open);
		const unsafe: ConfigSnapshot = {
			...withAuth,
			providers: [
				{
					...withAuth.providers[0],
					auth: { keyAuth: { name: "OpenAI API key", keyPage: "javascript:alert(1)" } },
				},
			],
		};
		const view = render(<ConfigView load={async () => unsafe} saveCredential={vi.fn()} signIn={vi.fn()} />);
		expect(await screen.findByText(/Sign in with: API key/)).toBeInTheDocument();
		expect(screen.queryByRole("link", { name: "Get key for OpenAI" })).toBeNull();
		view.unmount();
		const signIn = vi.fn(async () =>
			state({ events: [{ type: "auth_url", url: "https://user:secret@auth.example.com/go" }] }),
		);
		render(<ConfigView load={async () => withAuth} signIn={signIn} />);
		await userEvent.click(await screen.findByRole("button", { name: "Sign in with subscription for OpenAI" }));
		await screen.findByText(/Signing in to OpenAI/);
		expect(screen.queryByRole("link", { name: /auth\.example\.com/ })).toBeNull();
		expect(open).not.toHaveBeenCalled();
		vi.unstubAllGlobals();
	});

	it("sends a blank answer to a text question but keeps a secret answer required", async () => {
		const commands: SignInCommand[] = [];
		const signIn = vi.fn(async (command: SignInCommand): Promise<SignInState> => {
			commands.push(command);
			return state({
				prompt: { id: "p1", type: "text", message: "GitHub Enterprise URL/domain (blank for github.com)" },
			});
		});
		render(<ConfigView load={async () => withAuth} saveCredential={vi.fn()} signIn={signIn} />);
		await userEvent.click(await screen.findByRole("button", { name: "Sign in with subscription for OpenAI" }));
		await userEvent.click(await screen.findByRole("button", { name: "Continue" }));
		expect(commands).toContainEqual({ action: "answer", provider: "openai", promptId: "p1", value: "" });

		signIn.mockImplementation(async () => state({ prompt: { id: "p2", type: "secret", message: "Paste the secret" } }));
		cleanup();
		render(<ConfigView load={async () => withAuth} saveCredential={vi.fn()} signIn={signIn} />);
		expect(await screen.findByRole("button", { name: "Continue" })).toBeDisabled();
	});

	it("finds a sign-in the host still runs after the page was reopened, and can cancel it", async () => {
		const commands: SignInCommand[] = [];
		const signIn = vi.fn(async (command: SignInCommand): Promise<SignInState> => {
			commands.push(command);
			return command.action === "cancel" ? state({ status: "cancelled" }) : state({});
		});
		render(<ConfigView load={async () => withAuth} saveCredential={vi.fn()} signIn={signIn} />);
		await userEvent.click(await screen.findByRole("button", { name: "Cancel sign-in for OpenAI" }));
		expect(commands[0]).toEqual({ action: "status", provider: "openai" });
		expect(commands).toContainEqual({ action: "cancel", provider: "openai" });
	});

	it("keeps polling after one failed poll", async () => {
		let polls = 0;
		const signIn = vi.fn(async (command: SignInCommand): Promise<SignInState> => {
			if (command.action === "start") return state({});
			polls += 1;
			if (polls === 1) return state({});
			if (polls === 2) throw new Error("network down");
			return state({ status: "cancelled" });
		});
		render(<ConfigView load={async () => withAuth} saveCredential={vi.fn()} signIn={signIn} />);
		await userEvent.click(await screen.findByRole("button", { name: "Sign in with subscription for OpenAI" }));
		expect(await screen.findByText("Sign-in cancelled.", undefined, { timeout: 6000 })).toBeInTheDocument();
	}, 10000);

	it("reloads the snapshot when the credential was saved but a later step failed", async () => {
		const load = vi.fn(async () => withAuth);
		const signIn = vi.fn(async (command: SignInCommand): Promise<SignInState> =>
			command.action === "start"
				? state({ status: "failed", credentialSaved: true, error: "The credential was saved, but sync failed." })
				: state({ status: "idle" }),
		);
		render(<ConfigView load={load} saveCredential={vi.fn()} signIn={signIn} />);
		await userEvent.click(await screen.findByRole("button", { name: "Sign in with subscription for OpenAI" }));
		await waitFor(() => expect(load.mock.calls.length).toBeGreaterThan(1));
	});
});

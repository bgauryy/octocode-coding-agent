import { ELLIPSIS } from "@octocodeai/octocode-tui";
/**
 * Provider login dialogs: OAuth, API key and ambient credentials, the prompts and selections a login asks for, and
 * what happens after a provider is authenticated.
 */

import * as path from "node:path";
import type { AuthEvent, AuthPrompt } from "@octocodeai/octocode-ai";
import type { Component } from "@octocodeai/octocode-tui";
import { APP_NAME, getAgentDir, getDocsPath } from "../../../config.ts";
import { CredentialSynchronizationError } from "../../../core/model-runtime.ts";
import { detectKeychain } from "../../../core/auth-storage/keychain.ts";
import {
	confirmPlaintextHost,
	KeychainLoginSession,
	plaintextStorageNotice,
} from "../../../core/auth-storage/keychain-login.ts";
import { DialogSelectorComponent } from "../components/dialog-selector.ts";
import { LoginDialogComponent } from "../components/login-dialog.ts";
import type { AuthSelectorProvider } from "../components/oauth-selector.ts";
import { theme } from "../../../theme/theme.ts";
import { errorMessage } from "@octocodeai/octocode-contracts/guards";
import type { InteractiveModeHost } from "./host.ts";
import { checkPastedKey } from "./pasted-key.ts";

/** Interactive-mode members used by the provider login dialogs. */
type LoginDialogsHost = Pick<
	InteractiveModeHost,
	| "completeProviderAuthentication"
	| "editor"
	| "editorContainer"
	| "programStatus"
	| "session"
	| "settingsManager"
	| "showError"
	| "showModelSelector"
	| "showStatus"
	| "showWarning"
	| "ui"
	| "updateAvailableProviderCount"
	| "updateEditorBorderColor"
>;

export async function completeProviderAuthentication(
	connected: Pick<
		InteractiveModeHost,
		| "session"
		| "showModelSelector"
		| "showStatus"
		| "showWarning"
		| "updateAvailableProviderCount"
		| "updateEditorBorderColor"
	>,
	providerId: string,
	providerName: string,
	authType: "oauth" | "api_key",
): Promise<void> {
	const actionLabel = authType === "oauth" ? `Logged in to ${providerName}` : `Saved API key for ${providerName}`;
	connected.updateAvailableProviderCount();
	connected.updateEditorBorderColor();
	connected.showStatus(`${actionLabel}. Choose a model; Esc keeps the current model.`);
	if (connected.session.modelRuntime.getProviderAuthStatus(providerId).source === "runtime") {
		connected.showWarning(
			"The session API key override still takes priority. Clear it in /providers to use the saved credential.",
		);
	}
	// The picker owns its bounded catalog refresh and cancellation. Connecting never silently changes the default.
	connected.showModelSelector(`${providerId}/`);
}

export function showAmbientAuthDialog(
	host: LoginDialogsHost,
	providerOption: AuthSelectorProvider,
	onBack?: () => void,
): void {
	const dialog = new LoginDialogComponent(
		host.ui,
		providerOption.id,
		() => {
			showInEditorSlot(host, host.editor);
			onBack?.();
		},
		providerOption.name,
		`${providerOption.name} setup`,
	);
	dialog.showInfo(`${providerOption.method?.name ?? "Authentication"} is configured outside ${APP_NAME}.`, [], true);
	showInEditorSlot(host, dialog);
}

export async function showApiKeyLoginDialog(
	host: LoginDialogsHost,
	providerId: string,
	providerName: string,
	onBack?: () => void,
): Promise<void> {
	const dialog = new LoginDialogComponent(host.ui, providerId, () => {}, providerName);
	if (providerId === "amazon-bedrock") {
		dialog.showDetails([
			theme.fg("text", "You can also use an AWS profile, IAM keys, or role-based credentials."),
			theme.fg(
				"text",
				"A custom endpoint host and region are optional and are saved with the key. For a fully custom host, choose the 'Custom OpenAI-compatible host' template instead.",
			),
			theme.fg("muted", "See:"),
			theme.fg("accent", `  ${path.join(getDocsPath(), "providers.md")}`),
		]);
	}
	await runLoginDialog(host, dialog, providerId, providerName, "api_key", onBack);
}

/** Asks for one secret with hidden input; undefined when the user cancels or types nothing. */
export async function showSecretDialog(
	slot: Pick<InteractiveModeHost, "editor" | "editorContainer" | "ui">,
	title: string,
	message: string,
): Promise<string | undefined> {
	const dialog = new LoginDialogComponent(slot.ui, "secret", () => {}, title, title);
	showInEditorSlot(slot, dialog);
	try {
		return (await dialog.showPrompt(message, undefined, true)).trim() || undefined;
	} catch (error: unknown) {
		if (dialog.signal.aborted) return undefined;
		throw error;
	} finally {
		showInEditorSlot(slot, slot.editor);
	}
}

export async function showLoginDialog(
	host: LoginDialogsHost,
	providerId: string,
	providerName: string,
	onBack?: () => void,
): Promise<void> {
	const dialog = new LoginDialogComponent(host.ui, providerId, () => {}, providerName);
	await runLoginDialog(host, dialog, providerId, providerName, "oauth", onBack);
}

/** Puts `component` in the editor slot and focuses it. */
function showInEditorSlot(slot: Pick<InteractiveModeHost, "editorContainer" | "ui">, component: Component): void {
	slot.editorContainer.clear();
	slot.editorContainer.addChild(component);
	slot.ui.setFocus(component);
	slot.ui.requestRender();
}

/** Runs a provider login inside `dialog`, then restores the editor and reports the outcome. */
async function runLoginDialog(
	host: LoginDialogsHost,
	dialog: LoginDialogComponent,
	providerId: string,
	providerName: string,
	method: "api_key" | "oauth",
	onBack: (() => void) | undefined,
): Promise<void> {
	showInEditorSlot(host, dialog);
	try {
		await loginProvider(host, dialog, providerId, providerName, method);
		showInEditorSlot(host, host.editor);
		await host.completeProviderAuthentication(providerId, providerName, method);
	} catch (error: unknown) {
		showInEditorSlot(host, host.editor);
		const errorMsg = errorMessage(error);
		if (error instanceof CredentialSynchronizationError) {
			const done = method === "oauth" ? `Logged in to ${providerName}` : `Saved API key for ${providerName}`;
			host.showError(`${done}, but local model state could not be synchronized: ${errorMsg}`);
		} else if (dialog.signal.aborted || errorMsg === "Login cancelled") {
			onBack?.();
		} else {
			const action = method === "oauth" ? "login to" : "save API key for";
			host.showError(`Failed to ${action} ${providerName}: ${errorMsg}`);
		}
	}
}

function showAuthSelect(
	host: LoginDialogsHost,
	dialog: LoginDialogComponent,
	prompt: Extract<AuthPrompt, { type: "select" }>,
): Promise<string> {
	return new Promise((resolve, reject) => {
		const restoreDialog = () => showInEditorSlot(host, dialog);
		const labels = prompt.options.map((option) => option.label);
		const selector = new DialogSelectorComponent(
			prompt.message,
			labels,
			(optionLabel) => {
				restoreDialog();
				const id = prompt.options.find((option) => option.label === optionLabel)?.id;
				if (id) resolve(id);
				else reject(new Error("Login cancelled"));
			},
			() => {
				restoreDialog();
				reject(new Error("Login cancelled"));
			},
		);
		showInEditorSlot(host, selector);
	});
}

async function showAuthPrompt(
	host: LoginDialogsHost,
	dialog: LoginDialogComponent,
	prompt: AuthPrompt,
): Promise<string> {
	let response: Promise<string>;
	if (prompt.type === "select") {
		response = showAuthSelect(host, dialog, prompt);
	} else if (prompt.type === "manual_code") {
		response = dialog.showManualInput(prompt.message);
	} else {
		response = dialog.showPrompt(prompt.message, prompt.placeholder, prompt.type === "secret");
	}
	if (!prompt.signal) return response;
	if (prompt.signal.aborted) throw new Error("Login cancelled");
	const signal = prompt.signal;
	let onAbort: (() => void) | undefined;
	const aborted = new Promise<string>((_resolve, reject) => {
		onAbort = () => reject(new Error("Login cancelled"));
		signal.addEventListener("abort", onAbort, { once: true });
	});
	try {
		return await Promise.race([response, aborted]);
	} finally {
		if (onAbort) signal.removeEventListener("abort", onAbort);
	}
}

function notifyAuthDialog(dialog: LoginDialogComponent, event: AuthEvent): void {
	if (event.type === "auth_url") {
		dialog.showAuth(event.url, event.instructions);
	} else if (event.type === "device_code") {
		dialog.showDeviceCode(event);
		dialog.showWaiting(`Waiting for authentication${ELLIPSIS}`);
	} else if (event.type === "info") {
		dialog.showInfo(event.message, event.links);
	} else {
		dialog.showProgress(event.message);
	}
}

/** Throws for a key that is never saved, and asks before saving one whose prefix belongs to another provider. */
async function confirmPastedKey(
	host: LoginDialogsHost,
	dialog: LoginDialogComponent,
	providerId: string,
	providerName: string,
	key: string,
): Promise<void> {
	const check = checkPastedKey(providerId, key);
	if (check.kind === "refuse") throw new Error(check.message);
	if (check.kind === "ok") return;
	const owner = host.session.modelRuntime.getProvider(check.owner)?.name ?? check.owner;
	const choice = await showAuthPrompt(host, dialog, {
		type: "select",
		message: `This looks like a key for ${owner}, not ${providerName}. Save it for ${providerName} anyway?`,
		signal: dialog.signal,
		options: [
			{ id: "save", label: `Save it for ${providerName}` },
			{ id: "cancel", label: "Cancel" },
		],
	});
	if (choice !== "save") throw new Error("Login cancelled");
}

async function loginProvider(
	host: LoginDialogsHost,
	dialog: LoginDialogComponent,
	providerId: string,
	providerName: string,
	method: "api_key" | "oauth",
): Promise<void> {
	host.programStatus.setBlocked("login", { kind: "auth", message: `Log in to ${providerName}` });
	try {
		// API keys and account sign-ins alike go to the system keychain when the user picks it (OAuth as one blob).
		const keychain = detectKeychain(process.platform);
		// A pasted key is checked before anything is saved: refused, or confirmed when it belongs to another provider.
		const prompt = async (request: AuthPrompt) => {
			const answer = await showAuthPrompt(host, dialog, request);
			if (method === "api_key" && request.type === "secret")
				await confirmPastedKey(host, dialog, providerId, providerName, answer);
			return answer;
		};
		const storage = keychain
			? new KeychainLoginSession(keychain, providerId, async () => {
					const choice = await showAuthPrompt(host, dialog, {
						type: "select",
						message:
							method === "oauth" ? "Where should this sign-in be stored?" : "Where should this API key be stored?",
						signal: dialog.signal,
						options: [
							{ id: "keychain", label: `${keychain.name} (recommended)` },
							{ id: "file", label: "Local auth.json file (plaintext; created with owner-only permissions)" },
						],
					});
					return choice === "keychain" ? "keychain" : "file";
				})
			: undefined;
		if (!keychain) dialog.showInfo(plaintextStorageNotice(method, path.join(getAgentDir(), "auth.json")));
		if (method === "oauth") await storage?.chooseForSignIn();
		await host.session.modelRuntime.login(
			providerId,
			method,
			{
				signal: dialog.signal,
				prompt: storage
					? storage.wrapPrompt(prompt)
					: confirmPlaintextHost(prompt, () => confirmPlaintextHostStorage(host, dialog)),
				notify: (event) => notifyAuthDialog(dialog, event),
			},
			{ getDeviceId: () => host.settingsManager.getOrCreateDeviceId(), agentName: APP_NAME },
			storage ? { transformCredential: storage.transformCredential } : undefined,
		);
	} finally {
		host.programStatus.setBlocked("login", undefined);
	}
}

/** Asks before a custom host is saved in auth.json, because no system keychain can hold it. */
async function confirmPlaintextHostStorage(host: LoginDialogsHost, dialog: LoginDialogComponent): Promise<boolean> {
	const choice = await showAuthPrompt(host, dialog, {
		type: "select",
		message: `No system keychain is available. Save the key and host as plain text in ${path.join(getAgentDir(), "auth.json")} (owner-only permissions)?`,
		signal: dialog.signal,
		options: [
			{ id: "save", label: "Save in auth.json" },
			{ id: "cancel", label: "Cancel" },
		],
	});
	return choice === "save";
}

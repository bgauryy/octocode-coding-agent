/**
 * Provider login dialogs: OAuth, API key and ambient credentials, the prompts and selections a login asks for, and
 * what happens after a provider is authenticated.
 */

import * as path from "node:path";
import type { AuthEvent, AuthPrompt } from "@octocodeai/octocode-ai";
import type { Model } from "@octocodeai/octocode-ai/compat";
import { APP_NAME, getAuthPath, getDocsPath } from "../../../config.ts";
import { getApplicationPort } from "../../../core/application/index.ts";
import { defaultModelPerProvider } from "../../../core/model-resolver.ts";
import { CredentialSynchronizationError } from "../../../core/model-runtime.ts";
import { ExtensionSelectorComponent } from "../components/extension-selector.ts";
import { LoginDialogComponent } from "../components/login-dialog.ts";
import type { AuthSelectorProvider } from "../components/oauth-selector.ts";
import { theme } from "../theme/theme.ts";
import { isUnknownModel, hasDefaultModelProvider, llamaCppPostLoginGuidance } from "./helpers.ts";
import type { InteractiveModeHost } from "./host.ts";

/** Interactive-mode members used by the provider login dialogs. */
export type LoginDialogsHost = Pick<
	InteractiveModeHost,
	| "completeProviderAuthentication"
	| "editor"
	| "editorContainer"
	| "footer"
	| "maybeWarnAboutAnthropicSubscriptionAuth"
	| "programStatus"
	| "session"
	| "settingsManager"
	| "showError"
	| "showStatus"
	| "showWarning"
	| "ui"
	| "updateAvailableProviderCount"
	| "updateEditorBorderColor"
>;

export async function completeProviderAuthentication(
	host: LoginDialogsHost,
	providerId: string,
	providerName: string,
	authType: "oauth" | "api_key",
	previousModel: Model<any> | undefined,
): Promise<void> {
	const actionLabel = authType === "oauth" ? `Logged in to ${providerName}` : `Saved API key for ${providerName}`;

	const session = host.session;
	// Dynamic catalogs may be empty until the first authenticated network refresh.
	const deferSelection =
		isUnknownModel(previousModel) &&
		hasDefaultModelProvider(providerId) &&
		!session.modelRuntime
			.getAvailableSnapshot()
			.some((model) => model.provider === providerId && model.id === defaultModelPerProvider[providerId]);
	const finishAuthentication = async () => {
		let selectedModel: Model<any> | undefined;
		let selectionError: string | undefined;
		if (isUnknownModel(previousModel)) {
			const availableModels = host.session.modelRuntime.getAvailableSnapshot();
			const providerModels = availableModels.filter((model) => model.provider === providerId);
			// Matches LLAMA_PROVIDER_ID from extensions/llama/provider.ts; kept inline to avoid coupling interactive mode to the built-in extension.
			if (providerId === "llama.cpp") {
				selectionError = llamaCppPostLoginGuidance(actionLabel, providerModels.length);
			} else if (!hasDefaultModelProvider(providerId)) {
				selectionError = `${actionLabel}, but no default model is configured for provider "${providerId}". Use /model to select a model.`;
			} else if (providerModels.length === 0) {
				selectionError = `${actionLabel}, but no models are available for that provider. Use /model to select a model.`;
			} else {
				const defaultModelId = defaultModelPerProvider[providerId];
				selectedModel = providerModels.find((model) => model.id === defaultModelId);
				if (!selectedModel) {
					selectionError = `${actionLabel}, but its default model "${defaultModelId}" is not available. Use /model to select a model.`;
				} else {
					try {
						await getApplicationPort(host.session).invoke("setModel", selectedModel, { persist: true });
					} catch (error: unknown) {
						selectedModel = undefined;
						const errorMessage = error instanceof Error ? error.message : String(error);
						selectionError = `${actionLabel}, but selecting its default model failed: ${errorMessage}. Use /model to select a model.`;
					}
				}
			}
		}

		host.updateAvailableProviderCount();
		host.footer.invalidate();
		host.updateEditorBorderColor();
		if (selectedModel) {
			host.showStatus(`${actionLabel}. Selected ${selectedModel.id}. Credentials saved to ${getAuthPath()}`);
			void host.maybeWarnAboutAnthropicSubscriptionAuth(selectedModel);
		} else {
			host.showStatus(`${actionLabel}. Credentials saved to ${getAuthPath()}`);
			if (selectionError) {
				host.showError(selectionError);
			} else {
				void host.maybeWarnAboutAnthropicSubscriptionAuth();
			}
		}
	};
	if (deferSelection) {
		host.showStatus(`${actionLabel}. Credentials saved to ${getAuthPath()}. Refreshing model catalog…`);
	} else {
		await finishAuthentication();
	}

	const controller = new AbortController();
	const timeout = setTimeout(() => controller.abort(), 15_000);
	void session.modelRuntime
		.refresh({ providers: [providerId], signal: controller.signal })
		.then(async (result) => {
			if (result.aborted) {
				host.showWarning(`${actionLabel}, but its model catalog refresh timed out; using cached models.`);
			} else if (result.errors.size > 0) {
				host.showWarning(`${actionLabel}, but its model catalog could not be refreshed; using cached models.`);
			}
			// Do not replace a model or session selected while the refresh was running.
			if (deferSelection && host.session === session && session.model === previousModel) {
				await finishAuthentication();
			}
			host.updateAvailableProviderCount();
			host.footer.invalidate();
			host.ui.requestRender();
		})
		.catch((error: unknown) => {
			host.showWarning(
				`${actionLabel}, but its model catalog could not be refreshed: ${error instanceof Error ? error.message : String(error)}`,
			);
		})
		.finally(() => clearTimeout(timeout));
}

export function showAmbientAuthDialog(
	host: LoginDialogsHost,
	providerOption: AuthSelectorProvider,
	onBack?: () => void,
): void {
	const restoreEditor = () => {
		host.editorContainer.clear();
		host.editorContainer.addChild(host.editor);
		host.ui.setFocus(host.editor);
		host.ui.requestRender();
	};

	const dialog = new LoginDialogComponent(
		host.ui,
		providerOption.id,
		() => {
			restoreEditor();
			onBack?.();
		},
		providerOption.name,
		`${providerOption.name} setup`,
	);
	dialog.showInfo(`${providerOption.method?.name ?? "Authentication"} is configured outside ${APP_NAME}.`, [], true);

	host.editorContainer.clear();
	host.editorContainer.addChild(dialog);
	host.ui.setFocus(dialog);
	host.ui.requestRender();
}

export async function showApiKeyLoginDialog(
	host: LoginDialogsHost,
	providerId: string,
	providerName: string,
	onBack?: () => void,
): Promise<void> {
	const previousModel = host.session.model;

	const dialog = new LoginDialogComponent(
		host.ui,
		providerId,
		(_success, _message) => {
			// Completion handled below
		},
		providerName,
	);

	if (providerId === "amazon-bedrock") {
		dialog.showDetails([
			theme.fg("text", "You can also use an AWS profile, IAM keys, or role-based credentials."),
			theme.fg("muted", "See:"),
			theme.fg("accent", `  ${path.join(getDocsPath(), "providers.md")}`),
		]);
	}

	host.editorContainer.clear();
	host.editorContainer.addChild(dialog);
	host.ui.setFocus(dialog);
	host.ui.requestRender();

	const restoreEditor = () => {
		host.editorContainer.clear();
		host.editorContainer.addChild(host.editor);
		host.ui.setFocus(host.editor);
		host.ui.requestRender();
	};

	try {
		await loginProvider(host, dialog, providerId, providerName, "api_key");
		restoreEditor();
		await host.completeProviderAuthentication(providerId, providerName, "api_key", previousModel);
	} catch (error: unknown) {
		restoreEditor();
		const errorMsg = error instanceof Error ? error.message : String(error);
		if (error instanceof CredentialSynchronizationError) {
			host.showError(`Saved API key for ${providerName}, but local model state could not be synchronized: ${errorMsg}`);
		} else if (errorMsg === "Login cancelled") {
			onBack?.();
		} else {
			host.showError(`Failed to save API key for ${providerName}: ${errorMsg}`);
		}
	}
}

export function showAuthSelect(
	host: LoginDialogsHost,
	dialog: LoginDialogComponent,
	prompt: Extract<AuthPrompt, { type: "select" }>,
): Promise<string> {
	return new Promise((resolve, reject) => {
		const restoreDialog = () => {
			host.editorContainer.clear();
			host.editorContainer.addChild(dialog);
			host.ui.setFocus(dialog);
			host.ui.requestRender();
		};
		const labels = prompt.options.map((option) => option.label);
		const selector = new ExtensionSelectorComponent(
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
		host.editorContainer.clear();
		host.editorContainer.addChild(selector);
		host.ui.setFocus(selector);
		host.ui.requestRender();
	});
}

export async function showAuthPrompt(
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
		response = dialog.showPrompt(prompt.message, prompt.placeholder);
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

export function notifyAuthDialog(dialog: LoginDialogComponent, event: AuthEvent): void {
	if (event.type === "auth_url") {
		dialog.showAuth(event.url, event.instructions);
	} else if (event.type === "device_code") {
		dialog.showDeviceCode(event);
		dialog.showWaiting("Waiting for authentication...");
	} else if (event.type === "info") {
		dialog.showInfo(event.message, event.links);
	} else {
		dialog.showProgress(event.message);
	}
}

export async function loginProvider(
	host: LoginDialogsHost,
	dialog: LoginDialogComponent,
	providerId: string,
	providerName: string,
	method: "api_key" | "oauth",
): Promise<void> {
	host.programStatus.setBlocked("login", { kind: "auth", message: `Log in to ${providerName}` });
	try {
		await host.session.modelRuntime.login(
			providerId,
			method,
			{
				signal: dialog.signal,
				prompt: (prompt) => showAuthPrompt(host, dialog, prompt),
				notify: (event) => notifyAuthDialog(dialog, event),
			},
			{ getDeviceId: () => host.settingsManager.getOrCreateDeviceId() },
		);
	} finally {
		host.programStatus.setBlocked("login", undefined);
	}
}

export async function showLoginDialog(
	host: LoginDialogsHost,
	providerId: string,
	providerName: string,
	onBack?: () => void,
): Promise<void> {
	const previousModel = host.session.model;
	const dialog = new LoginDialogComponent(host.ui, providerId, (_success, _message) => {}, providerName);
	host.editorContainer.clear();
	host.editorContainer.addChild(dialog);
	host.ui.setFocus(dialog);
	host.ui.requestRender();

	const restoreEditor = () => {
		host.editorContainer.clear();
		host.editorContainer.addChild(host.editor);
		host.ui.setFocus(host.editor);
		host.ui.requestRender();
	};

	try {
		await loginProvider(host, dialog, providerId, providerName, "oauth");
		restoreEditor();
		await host.completeProviderAuthentication(providerId, providerName, "oauth", previousModel);
	} catch (error: unknown) {
		restoreEditor();
		const errorMsg = error instanceof Error ? error.message : String(error);
		if (error instanceof CredentialSynchronizationError) {
			host.showError(`Logged in to ${providerName}, but local model state could not be synchronized: ${errorMsg}`);
		} else if (errorMsg === "Login cancelled") {
			onBack?.();
		} else {
			host.showError(`Failed to login to ${providerName}: ${errorMsg}`);
		}
	}
}

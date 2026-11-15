import type { ApiKeyAuth, AuthCheck, OAuthAuth } from "@octocodeai/octocode-ai";
import {
	Container,
	type Focusable,
	fuzzyFilter,
	getKeybindings,
	GLYPH,
	Input,
	Spacer,
	TruncatedText,
} from "@octocodeai/octocode-tui";
import { emptyState, hintLine, keyText } from "../../../theme/theme-tui-helpers.ts";
import { theme } from "../../../theme/theme.ts";
import { DynamicBorder } from "../../../theme/dynamic-border.ts";

export type AuthSelectorProvider = {
	detail?: string;
	id: string;
	name: string;
	authType: "oauth" | "api_key";
	method?: ApiKeyAuth | OAuthAuth;
	status?: AuthCheck;
	/**
	 * Whether the provider's OAuth sign-in is backed by a subscription. `false` labels it as an account;
	 * unset keeps the "subscription" label.
	 */
	subscription?: boolean;
};

export function formatAuthSelectorProviderType(
	authType: AuthSelectorProvider["authType"],
	subscription?: boolean,
): string {
	if (authType === "api_key") return "API key";
	return subscription === false ? "account" : "subscription";
}

/** Themed suffix describing whether and how a login option is configured, for example " ✓ configured". */
function formatAuthSelectorProviderStatus(provider: AuthSelectorProvider): string {
	if (!provider.status) return theme.fg("muted", " • not configured");
	if (provider.status.type !== provider.authType) {
		const label = `${formatAuthSelectorProviderType(provider.status.type, provider.subscription)} configured`;
		return theme.fg("muted", " • ") + theme.fg("warning", label);
	}
	if (!provider.status.source || provider.status.source === "OAuth" || provider.status.source === "stored credential") {
		return theme.fg("success", " ✓ configured");
	}
	const source = /^[A-Z][A-Z0-9_]*(?:, [A-Z][A-Z0-9_]*)*$/.test(provider.status.source)
		? `env: ${provider.status.source}`
		: provider.status.source;
	return theme.fg("success", ` ✓ ${source}`);
}

/**
 * Component that renders an auth provider selector
 */
export class OAuthSelectorComponent extends Container implements Focusable {
	private searchInput: Input;

	// Focusable implementation - propagate to search input for IME cursor positioning
	private _focused = false;
	get focused(): boolean {
		return this._focused;
	}
	set focused(value: boolean) {
		this._focused = value;
		this.searchInput.focused = value;
	}

	private listContainer: Container;
	private allProviders: AuthSelectorProvider[];
	private filteredProviders: AuthSelectorProvider[];
	private selectedIndex: number = 0;
	private mode: "sign-in" | "logout";
	private onSelectCallback: (providerId: string, authType: AuthSelectorProvider["authType"]) => void;
	private onCancelCallback: () => void;
	private showAuthTypeLabels: boolean;

	constructor(
		mode: "sign-in" | "logout",
		providers: AuthSelectorProvider[],
		onSelect: (providerId: string, authType: AuthSelectorProvider["authType"]) => void,
		onCancel: () => void,
		initialSearchInput?: string,
	) {
		super();

		this.mode = mode;
		this.allProviders = providers;
		this.filteredProviders = providers;
		this.showAuthTypeLabels = new Set(providers.map((provider) => provider.authType)).size > 1;
		this.onSelectCallback = onSelect;
		this.onCancelCallback = onCancel;

		this.addChild(new DynamicBorder());
		this.addChild(new Spacer(1));

		const title = mode === "sign-in" ? "Sign in — choose a provider" : "Remove a saved AI provider credential:";
		this.addChild(new TruncatedText(theme.fg("accent", theme.bold(title)), 1, 0));
		if (mode === "sign-in") {
			this.addChild(
				new TruncatedText(
					theme.fg(
						"muted",
						"Subscription, account or API key. Type to search (chatgpt, copilot). Then /model picks a model.",
					),
					1,
					0,
				),
			);
		}
		this.addChild(new Spacer(1));

		this.searchInput = new Input();
		if (initialSearchInput) {
			this.searchInput.setValue(initialSearchInput);
		}
		this.searchInput.onSubmit = () => {
			const selectedProvider = this.filteredProviders[this.selectedIndex];
			if (selectedProvider) {
				this.onSelectCallback(selectedProvider.id, selectedProvider.authType);
			}
		};
		this.addChild(this.searchInput);
		this.addChild(new Spacer(1));

		this.listContainer = new Container();
		this.addChild(this.listContainer);

		this.addChild(new Spacer(1));
		this.addChild(
			new TruncatedText(
				hintLine([
					[keyText("tui.select.confirm"), mode === "logout" ? "remove" : "select"],
					[keyText("tui.select.cancel"), "cancel"],
				]),
				1,
				0,
			),
		);

		this.addChild(new DynamicBorder());

		this.filterProviders(initialSearchInput ?? "");
	}

	private filterProviders(query: string): void {
		this.filteredProviders = query
			? fuzzyFilter(
					this.allProviders,
					query,
					(provider) =>
						`${provider.name} ${provider.id} ${provider.authType} ${provider.method?.name ?? ""} ${provider.detail ?? ""}`,
				)
			: this.allProviders;
		this.selectedIndex = Math.max(0, Math.min(this.selectedIndex, Math.max(0, this.filteredProviders.length - 1)));
		this.updateList();
	}

	private updateList(): void {
		this.listContainer.clear();

		// One row fewer than before the key-hint line, so the dialog keeps its height.
		const maxVisible = 7;
		const startIndex = Math.max(
			0,
			Math.min(this.selectedIndex - Math.floor(maxVisible / 2), this.filteredProviders.length - maxVisible),
		);
		const endIndex = Math.min(startIndex + maxVisible, this.filteredProviders.length);

		for (let i = startIndex; i < endIndex; i++) {
			const provider = this.filteredProviders[i];
			if (!provider) continue;

			const isSelected = i === this.selectedIndex;

			const statusIndicator = provider.detail
				? theme.fg("muted", ` · ${provider.detail}`)
				: formatAuthSelectorProviderStatus(provider);
			const authTypeLabel =
				this.showAuthTypeLabels && this.mode !== "sign-in"
					? theme.fg("muted", ` [${formatAuthSelectorProviderType(provider.authType, provider.subscription)}]`)
					: "";
			let line = "";
			if (isSelected) {
				const prefix = theme.fg("accent", `${GLYPH.cursor} `);
				const text = theme.fg("accent", provider.name);
				line = prefix + text + authTypeLabel + statusIndicator;
			} else {
				const text = `  ${theme.fg("text", provider.name)}`;
				line = text + authTypeLabel + statusIndicator;
			}

			this.listContainer.addChild(new TruncatedText(line, 1, 0));
		}

		if (startIndex > 0 || endIndex < this.filteredProviders.length) {
			const scrollInfo = theme.fg("muted", `  (${this.selectedIndex + 1}/${this.filteredProviders.length})`);
			this.listContainer.addChild(new TruncatedText(scrollInfo, 1, 0));
		}

		if (this.filteredProviders.length === 0) {
			const message =
				this.allProviders.length === 0
					? this.mode === "sign-in"
						? "No providers available"
						: "No providers logged in. Use /providers first."
					: "No matching providers";
			this.listContainer.addChild(new TruncatedText(emptyState(message), 0, 0));
		}
	}

	handleInput(keyData: string): void {
		const kb = getKeybindings();
		if (kb.matches(keyData, "tui.select.up")) {
			if (this.filteredProviders.length === 0) return;
			this.selectedIndex = Math.max(0, this.selectedIndex - 1);
			this.updateList();
		} else if (kb.matches(keyData, "tui.select.down")) {
			if (this.filteredProviders.length === 0) return;
			this.selectedIndex = Math.min(this.filteredProviders.length - 1, this.selectedIndex + 1);
			this.updateList();
		} else if (kb.matches(keyData, "tui.select.confirm")) {
			const selectedProvider = this.filteredProviders[this.selectedIndex];
			if (selectedProvider) {
				this.onSelectCallback(selectedProvider.id, selectedProvider.authType);
			}
		} else if (kb.matches(keyData, "tui.select.cancel")) {
			this.onCancelCallback();
		} else {
			this.searchInput.handleInput(keyData);
			this.filterProviders(this.searchInput.getValue());
		}
	}
}

import type { ApiKeyAuth, AuthCheck, OAuthAuth } from "@octocodeai/octocode-ai";
import { Container, type Focusable, ListView, Spacer, TruncatedText, truncateToWidth } from "@octocodeai/octocode-tui";
import { HintBar, keyText, moveHint, type RankedHint } from "../../../theme/theme-tui-helpers.ts";
import { selectedText } from "../../../theme/gradients.ts";
import { theme } from "../../../theme/theme.ts";
import { DynamicBorder } from "../../../theme/dynamic-border.ts";
import { listRows, listTheme, syncEmpty, typeKeepingSelection } from "./list-kit.ts";
import { plainText } from "./styled-line.ts";

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
 * The provider picker of /login and /logout: a `⌕` search over providers, each row with how it is configured. Enter
 * signs in (or removes the saved credential); a click only selects on /logout, which removes.
 */
export class OAuthSelectorComponent extends Container implements Focusable {
	private readonly hints = new HintBar([]);
	private confirmHint: RankedHint = ["enter", "select"];
	private cancelHint: RankedHint = ["esc", "cancel"];
	private readonly list: ListView<AuthSelectorProvider>;
	private readonly mode: "sign-in" | "logout";
	private readonly hasProviders: boolean;

	get focused(): boolean {
		return this.list.focused;
	}
	set focused(value: boolean) {
		this.list.focused = value;
	}

	constructor(
		mode: "sign-in" | "logout",
		providers: AuthSelectorProvider[],
		onSelect: (providerId: string, authType: AuthSelectorProvider["authType"]) => void,
		onCancel: () => void,
		initialSearchInput?: string,
		rows?: number,
	) {
		super();
		this.mode = mode;
		this.hasProviders = providers.length > 0;
		const showAuthTypeLabels = mode !== "sign-in" && new Set(providers.map((provider) => provider.authType)).size > 1;

		this.list = new ListView<AuthSelectorProvider>({
			items: providers,
			maxRows: listRows(rows, 12, 8),
			theme: listTheme(),
			clickConfirms: mode === "sign-in",
			search: {
				text: (provider) =>
					`${provider.name} ${provider.id} ${provider.authType} ${provider.method?.name ?? ""} ${provider.detail ?? ""}`,
				placeholder: mode === "sign-in" ? "type to search (chatgpt, copilot)" : "type to search",
			},
			row: (provider, { selected, width }) => {
				const name = plainText(provider.name);
				const status = provider.detail
					? theme.fg("muted", ` · ${plainText(provider.detail)}`)
					: formatAuthSelectorProviderStatus(provider);
				const type = showAuthTypeLabels
					? theme.fg("muted", ` [${formatAuthSelectorProviderType(provider.authType, provider.subscription)}]`)
					: "";
				const label = selected ? theme.bold(selectedText(name)) : theme.fg("text", name);
				return truncateToWidth(`${label}${type}${status}`, width, "…");
			},
		});
		this.list.onSelect = (provider) => onSelect(provider.id, provider.authType);
		this.list.onCancel = onCancel;
		if (initialSearchInput) this.list.setQuery(initialSearchInput);
		this.syncEmpty();

		this.addChild(new DynamicBorder());
		this.addChild(new Spacer(1));
		const title = mode === "sign-in" ? "Sign in — choose a provider" : "Remove a saved AI provider credential";
		this.addChild(new TruncatedText(theme.fg("accent", theme.bold(title)), 1, 0));
		if (mode === "sign-in") {
			this.addChild(
				new TruncatedText(theme.fg("muted", "Subscription, account or API key. Then /model picks a model."), 1, 0),
			);
		}
		this.addChild(new Spacer(1));
		this.addChild(this.list);
		this.addChild(new Spacer(1));
		this.confirmHint = [keyText("tui.select.confirm"), mode === "logout" ? "remove" : "sign in", 1];
		this.cancelHint = [keyText("tui.select.cancel"), "cancel", 0];
		this.addChild(this.hints);
		this.syncHints();
		this.addChild(new DynamicBorder());
	}

	/** `No providers match "q"`, or what to do when there is none at all. */
	private syncEmpty(): void {
		if (this.hasProviders) return syncEmpty(this.list, "providers");
		this.list.setEmpty({
			message: this.mode === "sign-in" ? "No providers available" : "No providers logged in. Use /providers first.",
		});
	}

	handleInput(keyData: string): void {
		typeKeepingSelection(this.list, keyData);
		this.syncEmpty();
		this.syncHints();
	}

	/** While the list is empty, Enter does nothing: only Esc (and the empty line's recovery key) remain. */
	private syncHints(): void {
		this.hints.setHints(
			this.list.getItems().length ? [moveHint(1), this.confirmHint, this.cancelHint] : [this.cancelHint],
		);
	}
}

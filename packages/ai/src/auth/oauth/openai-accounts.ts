import { sleepUnlessAborted } from "../../utils/abort.ts";
import type { Credential, OAuthCredential, ProviderAuthInteraction } from "../types.ts";

export interface OpenAIAccount {
	clientId: string;
	subject: string;
	idToken?: string;
	access?: string;
	refresh?: string;
	expires?: number;
}

function account(value: unknown): OpenAIAccount | undefined {
	if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
	const v = value as Record<string, unknown>;
	if (
		typeof v.clientId !== "string" ||
		!v.clientId.startsWith("oaiapp_") ||
		typeof v.subject !== "string" ||
		!v.subject
	)
		return undefined;
	return {
		clientId: v.clientId,
		subject: v.subject,
		...(typeof v.idToken === "string" ? { idToken: v.idToken } : {}),
		...(typeof v.access === "string" ? { access: v.access } : {}),
		...(typeof v.refresh === "string" ? { refresh: v.refresh } : {}),
		...(typeof v.expires === "number" && Number.isFinite(v.expires) ? { expires: v.expires } : {}),
	};
}

export function openAIAccounts(credential?: Credential): OpenAIAccount[] {
	if (credential?.type !== "oauth") return [];
	const accounts = new Map<string, OpenAIAccount>();
	for (const value of Array.isArray(credential.accounts) ? credential.accounts : []) {
		const entry = account(value);
		if (entry) accounts.set(`${entry.clientId}\0${entry.subject}`, entry);
	}
	const current = account(credential);
	if (current) accounts.set(`${current.clientId}\0${current.subject}`, current);
	return [...accounts.values()];
}

export async function chooseOpenAIAccount(
	interaction: ProviderAuthInteraction,
	previous?: Credential,
): Promise<OpenAIAccount | undefined> {
	const accounts = openAIAccounts(previous);
	if (accounts.length === 0) return undefined;
	const choice = await interaction.prompt({
		type: "select",
		message: "Choose a ChatGPT account:",
		signal: interaction.signal,
		options: [
			...accounts.map((entry, index) => ({ id: String(index), label: entry.subject })),
			{ id: "new", label: "Use another ChatGPT account" },
		],
	});
	if (choice === "new") return undefined;
	const selected = accounts.find((_, index) => String(index) === choice);
	if (!selected) throw new Error("Unknown ChatGPT account selection");
	return selected;
}

/** Each account keeps its own issued client ID and token set. */
export function withOpenAIAccounts(credential: OAuthCredential, previous?: Credential): OAuthCredential {
	const accounts = openAIAccounts(previous);
	const current = account(credential);
	if (!current) throw new Error("The stored ChatGPT session has no verified account; sign in with ChatGPT again.");
	const index = accounts.findIndex((entry) => entry.clientId === current.clientId && entry.subject === current.subject);
	if (index < 0) accounts.push(current);
	else accounts[index] = current;
	return { ...credential, accounts };
}

/** Revoke every saved renewable session; retain only non-secret account registrations. */
export async function logoutOpenAI(credential: OAuthCredential, signal: AbortSignal): Promise<OAuthCredential> {
	const accounts = openAIAccounts(credential);
	const sessions = accounts;
	let unconfirmed = false;
	for (const entry of sessions) {
		if (!entry.refresh) continue;
		let confirmed = false;
		for (let attempt = 0; attempt < 3 && !signal.aborted; attempt++) {
			try {
				if (attempt > 0) await sleepUnlessAborted(200 * 2 ** attempt, signal, () => new Error("Revocation timed out"));
				const response = await fetch("https://auth.openai.com/api/accounts/oauth/revoke", {
					method: "POST",
					redirect: "error",
					headers: { "content-type": "application/x-www-form-urlencoded" },
					body: new URLSearchParams({
						token: entry.refresh,
						token_type_hint: "refresh_token",
						client_id: entry.clientId,
					}),
					signal,
				});
				await response.body?.cancel();
				if (response.status === 200) {
					confirmed = true;
					break;
				}
				if (response.status < 500) break;
			} catch {
				// Retry bounded transient failures while the renewable session is still available.
			}
		}
		if (!confirmed) unconfirmed = true;
	}
	return {
		type: "oauth",
		access: "",
		refresh: "",
		expires: 0,
		signedOut: true,
		accounts: accounts.map(({ clientId, subject }) => ({ clientId, subject })),
		...(unconfirmed ? { revocationUnconfirmed: true } : {}),
	};
}

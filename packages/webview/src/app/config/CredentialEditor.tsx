import type { ConfigCredentialCommand, ProviderCredentialStatus } from "@octocodeai/octocode-contracts/config";
import { errorMessage } from "@octocodeai/octocode-contracts/guards";
import { type SubmitEvent, useId, useState } from "react";
import { RequestError } from "../../request.ts";
import { Button } from "../ui/primitives.tsx";

export type SaveCredential = (command: ConfigCredentialCommand) => Promise<void>;

interface CredentialEditorProps {
	row: ProviderCredentialStatus;
	save: SaveCredential;
	/** Whether the host has an OS keychain; without one a key is saved as plain text, and only after the user agrees. */
	keychainAvailable: boolean;
}

/** A key the host stored can be replaced or cleared; a provider variable or custom command cannot be cleared here. */
const STORED = new Set(["keychain", "auth-json", "oauth"]);

/**
 * Sets, replaces or clears one provider's API key. The key lives only in this field's state while it is typed: it is not
 * kept in a draft, a URL or storage, it is cleared once saved, and the host never sends it back (the page shows the
 * source kind only). Without an OS keychain the Save button stays off until the user confirms the key will be plain text.
 */
export function CredentialEditor({ row, save, keychainAvailable }: CredentialEditorProps) {
	const id = useId();
	const title = row.name ?? row.provider;
	const stored = row.sources.some((source) => STORED.has(source.kind));
	const [open, setOpen] = useState(false);
	const [key, setKey] = useState("");
	const [plaintext, setPlaintext] = useState(false);
	const [busy, setBusy] = useState<"save" | "clear" | undefined>();
	const [message, setMessage] = useState<{ tone: "ok" | "error"; text: string } | undefined>();
	/** The host could not check the key (provider unreachable): the user may save it unchecked. */
	const [unverified, setUnverified] = useState(false);
	const ready = key.trim().length > 0 && (keychainAvailable || plaintext) && !busy;

	async function apply(command: ConfigCredentialCommand) {
		setBusy(command.action === "set" ? "save" : "clear");
		setMessage(undefined);
		setUnverified(false);
		try {
			await save(command);
			setKey("");
			setPlaintext(false);
			setMessage({
				tone: "ok",
				text:
					command.action === "clear"
						? "Cleared."
						: keychainAvailable
							? "Saved to the OS keychain."
							: "Saved as plain text in auth.json.",
			});
		} catch (error) {
			setMessage({ tone: "error", text: errorMessage(error) });
			setUnverified(command.action === "set" && error instanceof RequestError && error.code === "unverified");
		} finally {
			setBusy(undefined);
		}
	}

	const setKeyCommand = (acknowledgeUnverified: boolean): ConfigCredentialCommand => ({
		action: "set",
		provider: row.provider,
		key: key.trim(),
		...(keychainAvailable ? {} : { acknowledgePlaintext: true }),
		...(acknowledgeUnverified ? { acknowledgeUnverified: true } : {}),
	});

	const submit = (event: SubmitEvent) => {
		event.preventDefault();
		if (!ready) return;
		void apply(setKeyCommand(false));
	};

	if (!open) {
		return (
			<div className="config-edit">
				<Button size="sm" aria-label={`${stored ? "Replace" : "Set"} key for ${title}`} onClick={() => setOpen(true)}>
					{stored ? "Replace key" : "Set key"}
				</Button>
				{stored && (
					<Button
						size="sm"
						aria-label={`Clear credential for ${title}`}
						loading={busy === "clear"}
						disabled={!!busy}
						onClick={() => void apply({ action: "clear", provider: row.provider })}
					>
						Clear
					</Button>
				)}
				{message && <Notice message={message} />}
			</div>
		);
	}
	return (
		<form className="config-edit" onSubmit={submit} aria-label={`Edit key for ${title}`}>
			<input
				type="password"
				aria-label={`API key for ${title}`}
				value={key}
				maxLength={8192}
				autoComplete="off"
				spellCheck={false}
				onChange={(event) => setKey(event.target.value)}
			/>
			<Button type="submit" size="sm" variant="primary" loading={busy === "save"} disabled={!ready}>
				{stored ? "Replace" : "Save"}
			</Button>
			<Button
				size="sm"
				disabled={!!busy}
				onClick={() => {
					setOpen(false);
					setKey("");
					setPlaintext(false);
					setMessage(undefined);
					setUnverified(false);
				}}
			>
				Cancel
			</Button>
			{keychainAvailable ? (
				<p className="muted">The key goes to the OS keychain. It is not shown again.</p>
			) : (
				<label className="config-ack" htmlFor={`${id}-ack`}>
					<input
						id={`${id}-ack`}
						type="checkbox"
						checked={plaintext}
						onChange={(event) => setPlaintext(event.target.checked)}
					/>
					This computer has no OS keychain. Save the key as plain text in auth.json. The key is not encrypted, and
					auth.json is made readable by your user account only.
				</label>
			)}
			{message && <Notice message={message} />}
			{unverified && (
				<Button
					size="sm"
					aria-label={`Save key for ${title} without checking it`}
					disabled={!ready}
					onClick={() => void apply(setKeyCommand(true))}
				>
					Save unverified
				</Button>
			)}
		</form>
	);
}

function Notice({ message }: { message: { tone: "ok" | "error"; text: string } }) {
	return (
		<p
			className={message.tone === "error" ? "callout tone-danger" : "muted"}
			role={message.tone === "error" ? "alert" : "status"}
		>
			{message.text}
		</p>
	);
}

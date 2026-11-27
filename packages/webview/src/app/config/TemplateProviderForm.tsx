import {
	DEFAULT_CONTEXT_WINDOW,
	DEFAULT_MAX_OUTPUT,
	type ConfigProviderCommand,
	type ProviderTemplateInfo,
} from "@octocodeai/octocode-contracts/config";
import { type SubmitEvent, useState } from "react";
import { Button } from "../ui/primitives.tsx";
import { type SetProvider, useSwitch } from "./ProviderControls.tsx";

type KeyChoice = "keychain" | "plaintext" | "env" | "none";
type Create = Extract<ConfigProviderCommand, { action: "create-from-template" }>;

const wholeNumber = (text: string): number | undefined =>
	/^[1-9]\d{0,15}$/.test(text.trim()) ? Number(text) : undefined;

/** The model ids typed one per line or separated by commas. */
const modelIds = (text: string): string[] => [
	...new Set(
		text
			.split(/[\n,]/)
			.map((id) => id.trim())
			.filter(Boolean),
	),
];

/** Adds a custom provider from a template, with the questions the terminal asks; the key goes in this request only. */
export function TemplateProviderForm({
	templates,
	keychainAvailable,
	set,
}: {
	templates: readonly ProviderTemplateInfo[];
	keychainAvailable: boolean;
	set: SetProvider;
}) {
	const [open, setOpen] = useState(false);
	const [templateId, setTemplateId] = useState(templates[0]?.id ?? "");
	const template = templates.find((each) => each.id === templateId);
	const [provider, setProviderId] = useState("");
	const [host, setHost] = useState("");
	const [models, setModels] = useState("");
	const [context, setContext] = useState(String(DEFAULT_CONTEXT_WINDOW));
	const [output, setOutput] = useState(String(DEFAULT_MAX_OUTPUT));
	const [choice, setChoice] = useState<KeyChoice>(keychainAvailable ? "keychain" : "env");
	const [key, setKey] = useState("");
	const [envName, setEnvName] = useState("");
	const [confirmed, setConfirmed] = useState(false);
	const local = template?.kind === "local";

	const reset = () => {
		setOpen(false);
		setKey("");
		setConfirmed(false);
	};
	const create = useSwitch(async () => {
		if (!template) throw new Error("Choose a template.");
		const ids = modelIds(models);
		if (ids.length === 0) throw new Error("Give at least one model id.");
		const contextWindow = wholeNumber(context);
		const maxOutput = wholeNumber(output);
		if (contextWindow === undefined || maxOutput === undefined) throw new Error("Limits are whole numbers of tokens.");
		if (maxOutput > contextWindow) throw new Error("The maximum output cannot exceed the context window.");
		// A limit kept at its shown default is not written, so the model keeps following its catalog entry.
		const written = (id: string) => ({
			id,
			...(local || contextWindow !== DEFAULT_CONTEXT_WINDOW ? { contextWindow } : {}),
			...(local || maxOutput !== DEFAULT_MAX_OUTPUT ? { maxOutput } : {}),
		});
		let keyField: Create["key"];
		if (choice === "keychain") keyField = { kind: "keychain", key };
		else if (choice === "plaintext") keyField = { kind: "plaintext", key, acknowledgePlaintext: true };
		else if (choice === "env") keyField = { kind: "env", name: envName.trim().replace(/^\$/, "") };
		else keyField = { kind: "none" };
		await set({
			action: "create-from-template",
			template: template.id,
			provider: provider.trim(),
			...(host.trim() ? { host: host.trim() } : {}),
			models: ids.map(written),
			key: keyField,
		});
		reset();
	});
	const submit = (event: SubmitEvent) => {
		event.preventDefault();
		void create.click();
	};

	if (templates.length === 0) return null;
	if (!open)
		return (
			<div className="config-edit">
				<Button size="sm" onClick={() => setOpen(true)}>
					Add a provider from a template
				</Button>
			</div>
		);
	const needsKeyText = choice === "keychain" || choice === "plaintext";
	return (
		<form className="config-edit" onSubmit={submit} aria-label="Add a provider from a template">
			<label>
				Template
				<select
					value={templateId}
					onChange={(event) => {
						setTemplateId(event.target.value);
						setProviderId("");
					}}
				>
					{templates.map((each) => (
						<option key={each.id} value={each.id}>
							{each.name}
						</option>
					))}
				</select>
			</label>
			<label>
				Provider id
				<input
					type="text"
					value={provider}
					placeholder={template?.id}
					maxLength={128}
					autoComplete="off"
					spellCheck={false}
					onChange={(event) => setProviderId(event.target.value)}
				/>
			</label>
			{template && !template.baseUrl && (
				<label>
					Host (https, or localhost)
					<input
						type="text"
						value={host}
						placeholder={template.hostHint}
						maxLength={2048}
						autoComplete="off"
						spellCheck={false}
						onChange={(event) => setHost(event.target.value)}
					/>
				</label>
			)}
			<label>
				Model ids (one per line)
				<textarea value={models} rows={3} spellCheck={false} onChange={(event) => setModels(event.target.value)} />
			</label>
			<label>
				Context window (tokens)
				<input type="text" inputMode="numeric" value={context} onChange={(event) => setContext(event.target.value)} />
			</label>
			<label>
				Maximum output (tokens)
				<input type="text" inputMode="numeric" value={output} onChange={(event) => setOutput(event.target.value)} />
			</label>
			<label>
				API key
				<select value={choice} onChange={(event) => setChoice(event.target.value as KeyChoice)}>
					{keychainAvailable && <option value="keychain">Save in the OS keychain</option>}
					<option value="env">Use an environment variable</option>
					{template?.keyOptional && <option value="none">No key</option>}
					<option value="plaintext">Save as plain text in auth.json</option>
				</select>
			</label>
			{needsKeyText && (
				<input
					type="password"
					aria-label="API key"
					value={key}
					autoComplete="off"
					spellCheck={false}
					onChange={(event) => setKey(event.target.value)}
				/>
			)}
			{choice === "env" && (
				<input
					type="text"
					aria-label="Environment variable name"
					value={envName}
					placeholder={template?.keyEnv ?? "MY_PROVIDER_API_KEY"}
					autoComplete="off"
					spellCheck={false}
					onChange={(event) => setEnvName(event.target.value)}
				/>
			)}
			{choice === "plaintext" && (
				<label>
					<input type="checkbox" checked={confirmed} onChange={(event) => setConfirmed(event.target.checked)} /> I
					understand the key is stored unencrypted on this computer
				</label>
			)}
			<Button
				type="submit"
				size="sm"
				variant="primary"
				loading={create.busy}
				disabled={choice === "plaintext" && !confirmed}
			>
				Add provider
			</Button>
			<Button size="sm" disabled={create.busy} onClick={reset}>
				Cancel
			</Button>
			{create.error && (
				<p className="callout tone-danger" role="alert">
					{create.error}
				</p>
			)}
		</form>
	);
}

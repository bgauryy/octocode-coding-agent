import type { ConfigSetting, ConfigSettingCommand, ConfigSettingScope } from "@octocodeai/octocode-contracts/config";
import { errorMessage } from "@octocodeai/octocode-contracts/guards";
import { type SubmitEvent, useId, useState } from "react";
import { Button } from "../ui/primitives.tsx";

export type SaveSetting = (command: ConfigSettingCommand) => Promise<void>;

interface SettingEditorProps {
	setting: ConfigSetting;
	provider?: ConfigSetting;
	save: SaveSetting;
	/** The workspace the page is showing, when one is selected; its settings file is a target only while trusted. */
	workspace?: { id: string; trusted: boolean };
	/** Where models.json lives, named in the hint for custom hosts and providers. */
	modelsPath?: string;
}

/**
 * Changes one allow-listed setting in the global or the workspace file. The host decides: it refuses an untrusted
 * workspace and an invalid file, and the page shows its reason. Values are not secrets, so they stay in the field.
 */
export function SettingEditor({ setting, provider, save, workspace, modelsPath }: SettingEditorProps) {
	const id = useId();
	const [value, setValue] = useState(typeof setting.value === "string" ? setting.value : "");
	const [providerValue, setProviderValue] = useState(typeof provider?.value === "string" ? provider.value : "");
	const paired = provider !== undefined;
	const [scope, setScope] = useState<ConfigSettingScope>(
		setting.source === "workspace" || provider?.source === "workspace" ? "workspace" : "global",
	);
	const [busy, setBusy] = useState<"save" | "clear" | undefined>();
	const [message, setMessage] = useState<{ tone: "ok" | "error"; text: string } | undefined>();
	const canWorkspace = workspace?.trusted === true;
	const target: ConfigSettingScope = scope === "workspace" && !canWorkspace ? "global" : scope;

	async function apply(next: string | null) {
		setBusy(next === null ? "clear" : "save");
		setMessage(undefined);
		try {
			const targetFields = {
				scope: target,
				...(target === "workspace" && workspace ? { repoId: workspace.id } : {}),
			};
			await save(
				paired
					? {
							key: "modelDefault",
							value: next === null ? null : { provider: providerValue.trim(), model: next },
							...targetFields,
						}
					: {
							key: setting.key as "defaultProvider" | "defaultModel",
							value: next,
							...targetFields,
						},
			);
			if (next === null) {
				setValue("");
				if (paired) setProviderValue("");
			}
			const timing =
				setting.key === "defaultProvider" || setting.key === "defaultModel"
					? "Model defaults apply to new sessions; the current chat keeps its model."
					: "Running sessions pick it up with /reload.";
			setMessage({
				tone: "ok",
				text: `${next === null ? "Cleared in" : "Saved to"} ${target} settings. ${timing}${target === "global" && (setting.source === "workspace" || provider?.source === "workspace") ? " Workspace defaults still take precedence here." : ""}`,
			});
		} catch (error) {
			setMessage({ tone: "error", text: errorMessage(error) });
		} finally {
			setBusy(undefined);
		}
	}

	const submit = (event: SubmitEvent) => {
		event.preventDefault();
		const trimmed = value.trim();
		if (trimmed && (!paired || providerValue.trim())) void apply(trimmed);
	};

	return (
		<form
			className="config-edit"
			onSubmit={submit}
			aria-label={paired ? "Change startup model" : `Change ${setting.key}`}
		>
			{paired && (
				<label htmlFor={`${id}-provider`}>
					Provider
					<input
						id={`${id}-provider`}
						aria-label="Default provider"
						value={providerValue}
						maxLength={256}
						autoComplete="off"
						spellCheck={false}
						onChange={(event) => setProviderValue(event.target.value)}
					/>
				</label>
			)}
			{paired && <label htmlFor={`${id}-value`}>Model ID</label>}
			<input
				id={`${id}-value`}
				aria-label={`Value for ${setting.key}`}
				value={value}
				maxLength={256}
				autoComplete="off"
				spellCheck={false}
				onChange={(event) => setValue(event.target.value)}
			/>
			<select
				aria-label={`File for ${setting.key}`}
				value={target}
				onChange={(event) => setScope(event.target.value as ConfigSettingScope)}
			>
				<option value="global">Global settings</option>
				<option value="workspace" disabled={!canWorkspace}>
					{canWorkspace ? "Workspace settings" : "Workspace settings (needs a trusted workspace)"}
				</option>
			</select>
			<Button
				type="submit"
				size="sm"
				variant="primary"
				loading={busy === "save"}
				disabled={!value.trim() || (paired && !providerValue.trim()) || !!busy}
			>
				Save
			</Button>
			<Button size="sm" loading={busy === "clear"} disabled={!!busy} onClick={() => void apply(null)}>
				Clear
			</Button>
			{paired && (
				<p className="muted">
					Hosts and custom providers are defined in models.json
					{modelsPath ? (
						<>
							{" "}
							(<code>{modelsPath}</code>)
						</>
					) : (
						""
					)}
					.
				</p>
			)}
			{message && (
				<p
					className={message.tone === "error" ? "callout tone-danger" : "muted"}
					role={message.tone === "error" ? "alert" : "status"}
				>
					{message.text}
				</p>
			)}
		</form>
	);
}

import type { ConfigSetting, ConfigSnapshot } from "@octocodeai/octocode-contracts/config";
import { Badge } from "../ui/primitives.tsx";
import { SettingEditor, type SaveSetting } from "./SettingEditor.tsx";

const SOURCE_LABELS = { global: "Global", workspace: "Workspace", default: "Default" } as const;

function SettingRow({ setting }: { setting: ConfigSetting }) {
	return (
		<li className="config-row">
			<div className="config-row-head">
				<code className="config-name">{setting.key}</code>
				{setting.value === undefined ? (
					<span className="muted">Not set</span>
				) : (
					<code>{typeof setting.value === "string" ? setting.value : JSON.stringify(setting.value)}</code>
				)}
				<Badge tone={setting.source === "workspace" ? "accent" : "neutral"}>
					<span className="visually-hidden">Source: </span>
					{SOURCE_LABELS[setting.source]}
				</Badge>
			</div>
		</li>
	);
}

export function SettingsPanel({
	snapshot,
	save,
	workspace,
}: {
	snapshot: ConfigSnapshot;
	save?: SaveSetting;
	workspace?: { id: string; trusted: boolean };
}) {
	const setting = (key: string): ConfigSetting =>
		snapshot.settings.find((setting) => setting.key === key) ?? { key, source: "default" };
	return (
		<section className="panel" aria-labelledby="config-settings">
			<div className="panel-header">
				<h2 id="config-settings">Settings</h2>
				<p className="muted">
					{save ? (
						"Startup model defaults apply to new sessions. A workspace value takes precedence over global settings."
					) : (
						<>
							Read-only here. Use <code>/model</code> in a terminal and Ctrl+S to save a global startup default.
						</>
					)}
				</p>
			</div>
			{snapshot.settingsErrors?.map((error) => (
				<p key={error.scope} className="callout tone-danger" role="alert">
					{error.scope === "global" ? "Global settings file: " : "Workspace settings file: "}
					{error.message}
				</p>
			))}
			<ul className="row-list" aria-label="Settings">
				{snapshot.settings.map((setting) => (
					<SettingRow key={setting.key} setting={setting} />
				))}
			</ul>
			{save && (
				<SettingEditor
					key={workspace?.id ?? ""}
					setting={setting("defaultModel")}
					provider={setting("defaultProvider")}
					save={save}
					workspace={workspace}
					modelsPath={snapshot.modelsPath}
				/>
			)}
		</section>
	);
}

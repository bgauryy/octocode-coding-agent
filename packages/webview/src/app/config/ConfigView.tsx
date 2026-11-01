import type {
	ConfigCredentialCommand,
	ConfigSetting,
	ConfigSettingCommand,
	ConfigSnapshot,
} from "@octocodeai/octocode-contracts/config";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { plural } from "../model/format.ts";
import { errorMessage } from "@octocodeai/octocode-contracts/guards";
import { StateMark } from "../ui/StateMark.tsx";
import { Badge, Button, EmptyState, Skeleton, SkeletonLine } from "../ui/primitives.tsx";
import { SettingEditor, type SaveSetting } from "./SettingEditor.tsx";
import type { SaveCredential } from "./CredentialEditor.tsx";
import { type ConfigProviders, ProviderRow } from "./sources.tsx";

type LoadState =
	| { status: "loading" }
	| { status: "error"; message: string; key: string }
	| { status: "ready"; snapshot: ConfigSnapshot; key: string };

const SETTING_SOURCE_LABELS = { global: "Global", workspace: "Workspace", default: "Default" } as const;

function ConfigSkeleton() {
	return (
		<Skeleton label="Loading settings">
			<div className="skeleton-list" aria-hidden="true">
				{[0, 1, 2].map((row) => (
					<div key={row} className="skeleton-card">
						<SkeletonLine width="30%" height={14} />
						<SkeletonLine width="55%" height={10} />
					</div>
				))}
			</div>
		</Skeleton>
	);
}

function ProviderGroup({
	title,
	rows,
	now,
	open,
	save,
	keychainAvailable,
}: {
	title: string;
	rows: ConfigProviders;
	now: number;
	open: boolean;
	save?: SaveCredential;
	keychainAvailable: boolean;
}) {
	if (rows.length === 0) return null;
	return (
		<details className="config-group" open={open}>
			<summary>
				<h3>{title}</h3>
				<span className="count">{rows.length}</span>
			</summary>
			<ul className="row-list" aria-label={title}>
				{rows.map((row) => (
					<ProviderRow key={row.provider} row={row} now={now} save={save} keychainAvailable={keychainAvailable} />
				))}
			</ul>
		</details>
	);
}

function Providers({ snapshot, save }: { snapshot: ConfigSnapshot; save?: SaveCredential }) {
	const configured = snapshot.providers.filter((row) => row.configured);
	const missing = snapshot.providers.filter((row) => !row.configured);
	return (
		<section className="panel" aria-labelledby="config-providers">
			<div className="panel-header">
				<h2 id="config-providers">Provider credentials</h2>
				<p className="muted">
					Shows where a credential exists, never its value. When several sources exist, this page does not say which one
					a request uses. {save && "A key you save here is not shown again."}
				</p>
				<p className="config-keychain">
					<StateMark state={snapshot.keychainAvailable ? "done" : "stopped"} size={12} />{" "}
					{snapshot.keychainAvailable ? "OS keychain available" : "No OS keychain available on this machine"}
				</p>
			</div>
			{snapshot.credentialsError && (
				<p className="callout tone-danger" role="alert">
					{snapshot.credentialsError}
				</p>
			)}
			{snapshot.providers.length === 0 ? (
				<EmptyState title="No providers">This build lists no model providers.</EmptyState>
			) : (
				<>
					{configured.length === 0 && (
						<p className="panel-empty muted">
							No provider has a credential yet. Sign in with <code>/login</code> in a terminal session.
						</p>
					)}
					<ProviderGroup
						title="Configured"
						rows={configured}
						now={snapshot.generatedAt}
						open
						save={save}
						keychainAvailable={snapshot.keychainAvailable}
					/>
					<ProviderGroup
						title="Not configured"
						rows={missing}
						now={snapshot.generatedAt}
						open={configured.length === 0}
						save={save}
						keychainAvailable={snapshot.keychainAvailable}
					/>
				</>
			)}
		</section>
	);
}

function SettingRow({
	setting,
	save,
	workspace,
}: {
	setting: ConfigSetting;
	save?: SaveSetting;
	workspace?: { id: string; trusted: boolean };
}) {
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
					{SETTING_SOURCE_LABELS[setting.source]}
				</Badge>
			</div>
			{save && <SettingEditor key={workspace?.id ?? ""} setting={setting} save={save} workspace={workspace} />}
		</li>
	);
}

function Settings({
	snapshot,
	save,
	workspace,
}: {
	snapshot: ConfigSnapshot;
	save?: SaveSetting;
	workspace?: { id: string; trusted: boolean };
}) {
	return (
		<section className="panel" aria-labelledby="config-settings">
			<div className="panel-header">
				<h2 id="config-settings">Settings</h2>
				{save ? (
					<p className="muted">
						A workspace value replaces the global one. Running sessions pick a change up with <code>/reload</code>.
					</p>
				) : (
					<p className="muted">
						Read-only here. Change settings with <code>/settings</code> in a terminal session; running sessions pick
						them up with <code>/reload</code>.
					</p>
				)}
			</div>
			{snapshot.settingsErrors?.map((error) => (
				<p key={error.scope} className="callout tone-danger" role="alert">
					{error.scope === "global" ? "Global settings file: " : "Workspace settings file: "}
					{error.message}
				</p>
			))}
			<ul className="row-list" aria-label="Settings">
				{snapshot.settings.map((setting) => (
					<SettingRow key={setting.key} setting={setting} save={save} workspace={workspace} />
				))}
			</ul>
		</section>
	);
}

function Workspace({
	workspace,
	repos,
	repoId,
	onRepo,
}: {
	workspace: ConfigSnapshot["workspace"];
	repos?: readonly { id: string; name: string }[];
	repoId?: string;
	onRepo: (id: string | undefined) => void;
}) {
	return (
		<section className="panel" aria-labelledby="config-workspace">
			<div className="panel-header">
				<h2 id="config-workspace">Workspace</h2>
				{repos && repos.length > 0 && (
					<select
						aria-label="Workspace"
						value={repoId ?? ""}
						onChange={(event) => onRepo(event.target.value || undefined)}
					>
						<option value="">None (global settings only)</option>
						{repos.map((repo) => (
							<option key={repo.id} value={repo.id}>
								{repo.name}
							</option>
						))}
					</select>
				)}
			</div>
			<div className="config-row">
				{workspace ? (
					<>
						<div className="config-row-head">
							<span className="config-name">{workspace.repo}</span>
							<Badge
								tone={workspace.trusted ? "success" : "warning"}
								icon={<StateMark state={workspace.trusted ? "done" : "waiting"} size={12} />}
							>
								{workspace.trusted ? "Trusted" : "Not trusted"}
							</Badge>
						</div>
						{!workspace.trusted && (
							<p className="muted">Workspace settings are ignored until you trust this folder in a terminal session.</p>
						)}
					</>
				) : (
					<p className="muted">No workspace selected: only global settings are shown.</p>
				)}
			</div>
		</section>
	);
}

export interface ConfigViewProps {
	/** The host's snapshot, for the chosen workspace when `repoId` is given. */
	load: (repoId?: string) => Promise<ConfigSnapshot>;
	/** Changes one setting and returns the fresh snapshot. Settings are editable only when this is given and the host says the connection is `writable`. */
	save?: (command: ConfigSettingCommand) => Promise<ConfigSnapshot>;
	/** Sets, replaces or clears a provider key and returns the fresh snapshot (for the chosen workspace). Offered only when the host says the connection is `writable`. */
	saveCredential?: (command: ConfigCredentialCommand, repoId?: string) => Promise<ConfigSnapshot>;
	/** Repositories that can be chosen as the workspace whose trust and settings file are shown. */
	repos?: readonly { id: string; name: string }[];
}

/**
 * The Settings page: provider credential sources (read-only), the allow-listed settings with the file they come from
 * (editable through `save` when the host allows it), and workspace trust. Persistence, precedence and trust belong to
 * the host; the page only shows its answer and its refusals.
 */
export function ConfigView({ load, save, saveCredential, repos }: ConfigViewProps) {
	const [state, setState] = useState<LoadState>({ status: "loading" });
	const [attempt, setAttempt] = useState(0);
	const [repoId, setRepoId] = useState<string | undefined>();
	const key = `${attempt}:${repoId ?? ""}`;
	// The latest `load`, so a parent that passes a new function on each render does not refetch.
	const loader = useRef(load);
	useEffect(() => {
		loader.current = load;
	}, [load]);

	useEffect(() => {
		let current = true;
		const loaded = `${attempt}:${repoId ?? ""}`;
		loader.current(repoId).then(
			(snapshot) => {
				if (current) setState({ status: "ready", snapshot, key: loaded });
			},
			(error: unknown) => {
				if (current) setState({ status: "error", message: errorMessage(error), key: loaded });
			},
		);
		return () => {
			current = false;
		};
	}, [attempt, repoId]);

	const reload = useCallback(() => setAttempt((count) => count + 1), []);
	const refreshing = state.status !== "loading" && state.key !== key;
	const saveSetting = useMemo<SaveSetting | undefined>(
		() =>
			save &&
			(async (command) => {
				const next = await save(command);
				setState((current) => (current.status === "ready" ? { ...current, snapshot: next } : current));
			}),
		[save],
	);
	const saveKey = useMemo<SaveCredential | undefined>(
		() =>
			saveCredential &&
			(async (command) => {
				const next = await saveCredential(command, repoId);
				setState((current) => (current.status === "ready" ? { ...current, snapshot: next } : current));
			}),
		[saveCredential, repoId],
	);

	if (state.status === "loading") return <ConfigSkeleton />;
	if (state.status === "error") {
		return (
			<div className="config-view">
				<p className="callout tone-danger" role="alert">
					Can't load settings: {state.message}
				</p>
				<div className="view-actions">
					<Button onClick={reload} loading={refreshing}>
						Try again
					</Button>
				</div>
			</div>
		);
	}
	const { snapshot } = state;
	const configured = snapshot.providers.filter((row) => row.configured).length;
	return (
		<div className="config-view">
			<div className="view-actions">
				<p className="muted" aria-live="polite">
					{plural(configured, "provider")} configured
				</p>
				<Button size="sm" onClick={reload} loading={refreshing}>
					Refresh
				</Button>
			</div>
			<Providers snapshot={snapshot} save={snapshot.writable ? saveKey : undefined} />
			<Settings
				snapshot={snapshot}
				save={snapshot.writable ? saveSetting : undefined}
				workspace={repoId && snapshot.workspace ? { id: repoId, trusted: snapshot.workspace.trusted } : undefined}
			/>
			<Workspace workspace={snapshot.workspace} repos={repos} repoId={repoId} onRepo={setRepoId} />
		</div>
	);
}

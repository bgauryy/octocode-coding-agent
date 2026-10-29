import type { ConfigSetting, ConfigSnapshot } from "@octocodeai/octocode-contacts/config";
import { useCallback, useEffect, useRef, useState } from "react";
import { errorMessage, plural } from "../model/format.ts";
import { StateMark } from "../ui/StateMark.tsx";
import { Badge, Button, EmptyState, Skeleton, SkeletonLine } from "../ui/primitives.tsx";
import { type ConfigProviders, ProviderRow } from "./sources.tsx";

type LoadState =
	| { status: "loading" }
	| { status: "error"; message: string; attempt: number }
	| { status: "ready"; snapshot: ConfigSnapshot; attempt: number };

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
}: {
	title: string;
	rows: ConfigProviders;
	now: number;
	open: boolean;
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
					<ProviderRow key={row.provider} row={row} now={now} />
				))}
			</ul>
		</details>
	);
}

function Providers({ snapshot }: { snapshot: ConfigSnapshot }) {
	const configured = snapshot.providers.filter((row) => row.configured);
	const missing = snapshot.providers.filter((row) => !row.configured);
	return (
		<section className="panel" aria-labelledby="config-providers">
			<div className="panel-header">
				<h2 id="config-providers">Provider credentials</h2>
				<p className="muted">
					Shows where a credential exists, never its value. When several sources exist, this page does not say which one
					a request uses.
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
					<ProviderGroup title="Configured" rows={configured} now={snapshot.generatedAt} open />
					<ProviderGroup
						title="Not configured"
						rows={missing}
						now={snapshot.generatedAt}
						open={configured.length === 0}
					/>
				</>
			)}
		</section>
	);
}

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
					{SETTING_SOURCE_LABELS[setting.source]}
				</Badge>
			</div>
		</li>
	);
}

function Settings({ snapshot }: { snapshot: ConfigSnapshot }) {
	return (
		<section className="panel" aria-labelledby="config-settings">
			<div className="panel-header">
				<h2 id="config-settings">Settings</h2>
				<p className="muted">
					Read-only. Change settings with <code>/settings</code> in a terminal session; running sessions pick them up
					with <code>/reload</code>.
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
		</section>
	);
}

function Workspace({ workspace }: { workspace: ConfigSnapshot["workspace"] }) {
	return (
		<section className="panel" aria-labelledby="config-workspace">
			<div className="panel-header">
				<h2 id="config-workspace">Workspace</h2>
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

/**
 * The read-only Settings page: provider credential sources, the allow-listed settings with the file they come from, and
 * workspace trust. `load` returns the host's snapshot; nothing on the page can change configuration.
 */
export function ConfigView({ load }: { load: () => Promise<ConfigSnapshot> }) {
	const [state, setState] = useState<LoadState>({ status: "loading" });
	const [attempt, setAttempt] = useState(0);
	// The latest `load`, so a parent that passes a new function on each render does not refetch.
	const loader = useRef(load);
	useEffect(() => {
		loader.current = load;
	}, [load]);

	useEffect(() => {
		let current = true;
		loader.current().then(
			(snapshot) => {
				if (current) setState({ status: "ready", snapshot, attempt });
			},
			(error: unknown) => {
				if (current) setState({ status: "error", message: errorMessage(error), attempt });
			},
		);
		return () => {
			current = false;
		};
	}, [attempt]);

	const reload = useCallback(() => setAttempt((count) => count + 1), []);
	const refreshing = state.status !== "loading" && state.attempt !== attempt;

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
			<Providers snapshot={snapshot} />
			<Settings snapshot={snapshot} />
			<Workspace workspace={snapshot.workspace} />
		</div>
	);
}

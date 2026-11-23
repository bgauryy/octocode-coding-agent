import type {
	ConfigCredentialCommand,
	ConfigProviderCommand,
	ConfigSettingCommand,
	ConfigSnapshot,
	SignInCommand,
	SignInState,
} from "@octocodeai/octocode-contracts/config";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { plural } from "../model/format.ts";
import { errorMessage } from "@octocodeai/octocode-contracts/guards";
import { StateMark } from "../ui/StateMark.tsx";
import { Badge, Button, EmptyState } from "../ui/primitives.tsx";
import type { SaveSetting } from "./SettingEditor.tsx";
import { SettingsPanel } from "./SettingsPanel.tsx";
import { ConfigSkeleton } from "./ConfigSkeleton.tsx";
import { SourcesPanel, type SetProvider } from "./ProviderControls.tsx";
import { TemplateProviderForm } from "./TemplateProviderForm.tsx";
import { McpPanel, type McpAddStatus } from "./McpPanel.tsx";
import type { AddMcp } from "./McpAddForm.tsx";
import { type HarnessApi, HarnessPanel } from "./HarnessPanel.tsx";
import { type RunnersApi, RunnersPanel } from "./RunnersPanel.tsx";
import { type SecurityApi, SecurityPanel } from "./SecurityPanel.tsx";
import { type ToolsApi, ToolsPanel } from "./ToolsPanel.tsx";
import type { SaveCredential } from "./CredentialEditor.tsx";
import { ProviderTestProvider, TestAll, type TestProviders } from "./ProviderTest.tsx";
import type { SignInRequest } from "./SignIn.tsx";
import { type ConfigProviders, ProviderRow } from "./sources.tsx";

type LoadState =
	| { status: "loading" }
	| { status: "error"; message: string; key: string }
	| { status: "ready"; snapshot: ConfigSnapshot; key: string };

function ProviderGroup({
	title,
	rows,
	now,
	open,
	save,
	keychainAvailable,
	signIn,
	onSignedIn,
	setProvider,
}: {
	title: string;
	setProvider?: SetProvider;
	rows: ConfigProviders;
	now: number;
	open: boolean;
	save?: SaveCredential;
	keychainAvailable: boolean;
	signIn?: SignInRequest;
	onSignedIn: () => void;
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
					<ProviderRow
						key={row.provider}
						row={row}
						now={now}
						save={save}
						keychainAvailable={keychainAvailable}
						signIn={signIn}
						onSignedIn={onSignedIn}
						setProvider={setProvider}
					/>
				))}
			</ul>
		</details>
	);
}

function Providers({
	snapshot,
	save,
	signIn,
	onSignedIn,
	setProvider,
	focus,
}: {
	/** Scroll here once loaded: the page was opened to fix a provider (a credential error's link). */
	focus?: boolean;
	setProvider?: SetProvider;
	snapshot: ConfigSnapshot;
	save?: SaveCredential;
	signIn?: SignInRequest;
	onSignedIn: () => void;
}) {
	const configured = snapshot.providers.filter((row) => row.configured);
	const missing = snapshot.providers.filter((row) => !row.configured);
	const ref = useRef<HTMLElement>(null);
	useEffect(() => {
		if (focus) ref.current?.scrollIntoView?.({ block: "start" });
	}, [focus]);
	return (
		<section className="panel" aria-labelledby="config-providers" ref={ref}>
			<div className="panel-header">
				<h2 id="config-providers">Provider credentials</h2>
				<p className="muted">
					Configured means a credential source is present; access has not been verified. When several sources exist,
					this page does not say which one a request uses. {save && "A key you save here is not shown again."}
				</p>
				<p className="config-keychain">
					<StateMark state={snapshot.keychainAvailable ? "done" : "stopped"} size={12} />{" "}
					{snapshot.keychainAvailable ? "OS keychain available" : "No OS keychain available on this machine"}
				</p>
			</div>
			<TestAll />
			{setProvider && snapshot.providerTemplates && (
				<TemplateProviderForm
					templates={snapshot.providerTemplates}
					keychainAvailable={snapshot.keychainAvailable}
					set={setProvider}
				/>
			)}
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
							No provider has a credential yet. {signIn || save ? "Sign in or set a key below. " : ""}
							<code>/providers</code> in a terminal session does the same.
						</p>
					)}
					<ProviderGroup
						title="Configured"
						rows={configured}
						now={snapshot.generatedAt}
						open
						save={save}
						keychainAvailable={snapshot.keychainAvailable}
						signIn={signIn}
						onSignedIn={onSignedIn}
						setProvider={setProvider}
					/>
					<ProviderGroup
						title="Not configured"
						rows={missing}
						now={snapshot.generatedAt}
						open={configured.length === 0}
						save={save}
						keychainAvailable={snapshot.keychainAvailable}
						signIn={signIn}
						onSignedIn={onSignedIn}
						setProvider={setProvider}
					/>
				</>
			)}
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
	/** Starts, polls, answers or cancels a sign-in the host runs for a provider. Offered only when the host says the connection is `writable`. */
	signIn?: (command: SignInCommand) => Promise<SignInState>;
	/** Turns a provider or the Pi source on or off and returns the fresh snapshot. Offered only when the host says the connection is `writable`. */
	saveProvider?: (command: ConfigProviderCommand, repoId?: string) => Promise<ConfigSnapshot>;
	/** Tests one connected provider, or all of them, only when a Test button is pressed; used only when the host says the connection is `writable`. */
	testProviders?: TestProviders;
	/** Lists and switches the Harness panel's rows; used only when the host says the connection is `writable`. */
	harness?: HarnessApi;
	/** Lists the reviewed hooks, MCP servers and skills and records one decision; used only when the host says the connection is `writable`. */
	security?: SecurityApi;
	/** Lists and changes the External agents (vendor CLIs); used only when the host says the connection is `writable`. */
	runners?: RunnersApi;
	addMcp?: AddMcp;
	mcpAddStatus?: McpAddStatus;
	/** Lists each tool's exposure state and pins one tool; used only when the host says the connection is `writable`. */
	tools?: ToolsApi;
	/** Repositories that can be chosen as the workspace whose trust and settings file are shown. */
	repos?: readonly { id: string; name: string }[];
	/** The panel to scroll to once loaded (`#settings?section=providers`). */
	section?: string;
}

/**
 * The Settings page: provider credential sources (read-only), the allow-listed settings with the file they come from
 * (editable through `save` when the host allows it), and workspace trust. Persistence, precedence and trust belong to
 * the host; the page only shows its answer and its refusals.
 */
export function ConfigView(props: ConfigViewProps) {
	const {
		load,
		save,
		saveCredential,
		saveProvider,
		testProviders,
		signIn,
		harness,
		security,
		runners,
		addMcp,
		mcpAddStatus,
		tools,
		repos,
		section,
	} = props;
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

	const setProvider = useMemo<SetProvider | undefined>(
		() =>
			saveProvider &&
			(async (command) => {
				const next = await saveProvider(command, repoId);
				setState((current) => (current.status === "ready" ? { ...current, snapshot: next } : current));
			}),
		[saveProvider, repoId],
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
			<SourcesPanel sources={snapshot.sources ?? []} set={snapshot.writable ? setProvider : undefined} />
			<ProviderTestProvider test={snapshot.writable ? testProviders : undefined}>
				<Providers
					setProvider={snapshot.writable ? setProvider : undefined}
					snapshot={snapshot}
					save={snapshot.writable ? saveKey : undefined}
					signIn={snapshot.writable ? signIn : undefined}
					onSignedIn={reload}
					focus={section === "providers"}
				/>
			</ProviderTestProvider>
			<SettingsPanel
				snapshot={snapshot}
				save={snapshot.writable ? saveSetting : undefined}
				workspace={repoId && snapshot.workspace ? { id: repoId, trusted: snapshot.workspace.trusted } : undefined}
			/>
			<McpPanel
				key={repoId ?? "global"}
				add={snapshot.writable && !refreshing ? addMcp : undefined}
				status={mcpAddStatus}
				repoId={repoId}
				trusted={snapshot.workspace?.trusted === true}
			/>
			<HarnessPanel api={snapshot.writable ? harness : undefined} repoId={repoId} reloadKey={key} />
			<RunnersPanel api={snapshot.writable ? runners : undefined} reloadKey={key} />
			<SecurityPanel api={snapshot.writable ? security : undefined} repoId={repoId} reloadKey={key} />
			<ToolsPanel api={snapshot.writable ? tools : undefined} repoId={repoId} reloadKey={key} />
			<Workspace workspace={snapshot.workspace} repos={repos} repoId={repoId} onRepo={setRepoId} />
		</div>
	);
}

import type {
	SecurityAction,
	SecurityActionCommand,
	SecurityItem,
	SecurityList,
} from "@octocodeai/octocode-contracts/config";
import { errorMessage } from "@octocodeai/octocode-contracts/guards";
import { useEffect, useRef, useState } from "react";
import { Badge, Button } from "../ui/primitives.tsx";
import { useSwitch } from "./ProviderControls.tsx";

/** The host's Security routes: the reviewed items for a workspace, and one decision that answers with the fresh list. */
export interface SecurityApi {
	list: (repoId?: string) => Promise<SecurityList>;
	act: (command: SecurityActionCommand) => Promise<SecurityList>;
}

const KIND_WORDS = { hook: "Hook", mcp: "MCP server", skill: "Skill" } as const;
const TONES = { LOW: "neutral", MEDIUM: "warning", HIGH: "danger", CRITICAL: "danger" } as const;
const ACTION_WORDS: Record<SecurityAction, string> = { approve: "Approve", deny: "Deny", forget: "Forget" };

/** The verbs `/security` offers for an item in this state: approve unless it is approved, deny unless denied, forget once decided. */
function actionsFor(item: SecurityItem): SecurityAction[] {
	const actions: SecurityAction[] = [];
	if ((item.state !== "approved" || item.changed) && !item.unreadable) actions.push("approve");
	if (item.state !== "denied") actions.push("deny");
	if (item.state !== "not checked" || item.changed) actions.push("forget");
	return actions;
}

function Item({ item, act }: { item: SecurityItem; act?: (action: SecurityAction) => Promise<void> }) {
	const [pending, setPending] = useState<SecurityAction | undefined>();
	const decide = useSwitch(async () => {
		if (!pending) return;
		await act!(pending);
		setPending(undefined);
	});
	const word = item.changed ? "Changed since approval" : item.state === "not checked" ? "Not checked" : item.state;
	return (
		<li className="config-row">
			<div className="config-row-head">
				<span className="config-name">{item.label}</span>
				<Badge tone="neutral">{KIND_WORDS[item.kind]}</Badge>
				<Badge
					tone={item.state === "approved" && !item.changed ? "success" : item.state === "denied" ? "danger" : "warning"}
				>
					{word}
				</Badge>
				<Badge tone={TONES[item.rating]}>
					<span className="visually-hidden">Rating: </span>
					{item.rating}
				</Badge>
				{act &&
					actionsFor(item).map((action) => (
						<Button
							key={action}
							size="sm"
							onClick={() => setPending(action)}
							disabled={decide.busy}
							aria-label={`${ACTION_WORDS[action]} ${item.label}`}
						>
							{ACTION_WORDS[action]}
						</Button>
					))}
			</div>
			<p className="muted config-methods">
				{item.scope === "global" ? "Your files" : "This repository"} · {item.path}
				{item.withheld ? " · off until approved" : ""}
			</p>
			{item.unreadable && (
				<p className="muted config-methods">Not read in full: {item.unreadable}. It cannot be approved.</p>
			)}
			<details>
				<summary>Findings ({item.findings.length})</summary>
				{item.findings.length === 0 ? (
					<p className="muted config-methods">No findings from the static scan.</p>
				) : (
					<ol aria-label={`Findings for ${item.label}`}>
						{item.findings.map((finding) => (
							<li key={`${finding.rule}:${finding.text}`}>
								[{finding.rating}] {finding.rule} {finding.text}
							</li>
						))}
					</ol>
				)}
				<p className="muted config-methods">If approved it gets: {item.grants.join(" · ")}</p>
			</details>
			{item.changes && (
				<details open>
					<summary>Changed since you approved it</summary>
					<pre className="config-methods">{item.changes.join("\n")}</pre>
				</details>
			)}
			{pending && (
				<fieldset className="callout" aria-label={`Confirm ${pending} ${item.label}`}>
					<p>
						{ACTION_WORDS[pending]} <strong>{item.label}</strong> at the content shown above?
					</p>
					<Button
						size="sm"
						onClick={decide.click}
						loading={decide.busy}
						aria-label={`Confirm ${pending} for ${item.label}`}
					>
						Confirm
					</Button>
					<Button size="sm" onClick={() => setPending(undefined)} disabled={decide.busy}>
						Cancel
					</Button>
				</fieldset>
			)}
			{decide.error && (
				<p className="callout tone-danger" role="alert">
					{decide.error}
				</p>
			)}
		</li>
	);
}

/**
 * The reviews `/security` shows: every hook, MCP server and skill from outside Octocode with its state, rating,
 * findings and the lines that changed since approval. The host scans, decides and records; the page sends one verb and
 * shows the answer. Without `api` (a published link) it explains where to review instead.
 */
export function SecurityPanel({ api, repoId, reloadKey }: { api?: SecurityApi; repoId?: string; reloadKey: string }) {
	const [loaded, setLoaded] = useState<{ repoId?: string; list: SecurityList } | undefined>();
	const list = loaded?.repoId === repoId ? loaded?.list : undefined;
	const [error, setError] = useState<string | undefined>();
	const hasApi = api !== undefined;
	const loader = useRef(api);
	useEffect(() => {
		loader.current = api;
	}, [api]);

	useEffect(() => {
		let current = true;
		loader.current?.list(repoId).then(
			(fetched) => {
				if (!current) return;
				setLoaded({ ...(repoId !== undefined ? { repoId } : {}), list: fetched });
				setError(undefined);
			},
			(caught: unknown) => {
				if (current) setError(errorMessage(caught));
			},
		);
		return () => {
			current = false;
		};
	}, [hasApi, repoId, reloadKey]);

	const decide = (item: SecurityItem) => async (action: SecurityAction) => {
		const fresh = await api!.act({ id: item.id, action, ...(repoId ? { repoId } : {}) });
		setLoaded({ ...(repoId !== undefined ? { repoId } : {}), list: fresh });
	};

	return (
		<section className="panel" aria-labelledby="config-security">
			<div className="panel-header">
				<h2 id="config-security">Security</h2>
				<p className="muted">
					Hooks, MCP servers and skills from outside Octocode stay off until you approve their exact content. These are
					the reviews of <code>/security</code>; a scan says what was checked, never that an item is safe.
				</p>
			</div>
			{!api ? (
				<p className="panel-empty muted">
					Reviews are made through <code>/web</code> or <code>/security</code> in the Octocode terminal.
				</p>
			) : error ? (
				<p className="callout tone-danger" role="alert">
					Can't load the security reviews: {error}
				</p>
			) : !list ? (
				<p className="panel-empty muted">Loading…</p>
			) : (
				<>
					{list.message && <output className="muted">{list.message}</output>}
					{list.items.length === 0 ? (
						<p className="panel-empty muted">No hooks, MCP servers or skills from outside Octocode were found.</p>
					) : (
						<ul className="row-list" aria-label="Reviewed items">
							{list.items.map((item) => (
								<Item key={item.id} item={item} act={decide(item)} />
							))}
						</ul>
					)}
				</>
			)}
		</section>
	);
}

import type {
	HarnessList,
	HarnessPreview,
	HarnessRow,
	HarnessSwitchCommand,
} from "@octocodeai/octocode-contracts/config";
import { errorMessage } from "@octocodeai/octocode-contracts/guards";
import { useEffect, useRef, useState } from "react";
import { StateMark } from "../ui/StateMark.tsx";
import { Badge, Button } from "../ui/primitives.tsx";
import { useSwitch } from "./ProviderControls.tsx";

/** The host's Harness routes: the list for a workspace, and one switch that answers with the fresh list. */
export interface HarnessApi {
	list: (repoId?: string) => Promise<HarnessList>;
	set: (command: HarnessSwitchCommand) => Promise<HarnessList>;
	/** Scans what turning a harness on would bring; the panel shows it and writes only after a confirmation. */
	preview?: (id: string, repoId?: string) => Promise<HarnessPreview>;
}

type Scope = HarnessSwitchCommand["scope"];

/** Display groups, in `/harness` order; each lists the row kinds it holds. */
const GROUPS: readonly { title: string; kinds: readonly HarnessRow["kind"][]; open: boolean }[] = [
	{ title: "Harnesses", kinds: ["harness"], open: true },
	{ title: "MCP servers", kinds: ["mcp"], open: true },
	{ title: "Skills", kinds: ["skill"], open: false },
	{ title: "Hooks", kinds: ["hooks", "hook"], open: false },
	{ title: "Plugins", kinds: ["plugin", "installed"], open: false },
	{ title: "Extensions", kinds: ["extension"], open: false },
];

const SET_BY = { workspace: "Workspace", global: "Global" } as const;

function Row({
	row,
	set,
	preview,
}: {
	row: HarnessRow;
	set?: (on: boolean) => Promise<void>;
	preview?: () => Promise<HarnessPreview>;
}) {
	// Turning a harness source on first shows the host's scan; a failed scan shows its error and writes nothing.
	const [review, setReview] = useState<HarnessPreview | undefined>();
	const toggle = useSwitch(async () => {
		if (!row.on && row.kind === "harness" && preview) {
			const scanned = await preview();
			if (scanned.lines.length > 0) {
				setReview(scanned);
				return;
			}
		}
		await set!(!row.on);
	});
	const confirm = useSwitch(async () => {
		await set!(true);
		setReview(undefined);
	});
	return (
		<li className="config-row">
			<div className="config-row-head">
				<span className="config-name">{row.label}</span>
				{/* A row's `state` (a server held back until approved) is what it is in effect: shown in place of On or Off. */}
				<Badge
					tone={row.locked ? "success" : row.state ? "warning" : row.on ? "success" : "neutral"}
					icon={
						<StateMark state={row.locked ? "done" : row.state ? "waiting" : row.on ? "done" : "stopped"} size={12} />
					}
				>
					{row.locked ? "Always on" : (row.state ?? (row.on ? "On" : "Off"))}
				</Badge>
				{row.setBy !== "default" && (
					<Badge tone={row.setBy === "workspace" ? "accent" : "neutral"}>
						<span className="visually-hidden">Set in: </span>
						{SET_BY[row.setBy]}
					</Badge>
				)}
				{set && !row.locked && (
					<Button
						size="sm"
						onClick={toggle.click}
						loading={toggle.busy}
						aria-label={`${row.on ? "Turn off" : "Turn on"} ${row.label}`}
					>
						{row.on ? "Turn off" : "Turn on"}
					</Button>
				)}
			</div>
			{(row.detail || row.locked) && <p className="muted config-methods">{row.locked ?? row.detail}</p>}
			{review && (
				<fieldset className="callout" aria-label={`Scan of ${review.label}`}>
					<pre className="config-methods">{review.lines.join("\n")}</pre>
					<Button size="sm" onClick={confirm.click} loading={confirm.busy} aria-label={`Confirm turn on ${row.label}`}>
						Confirm turn on
					</Button>
					<Button size="sm" onClick={() => setReview(undefined)} disabled={confirm.busy}>
						Cancel
					</Button>
					{confirm.error && (
						<p className="callout tone-danger" role="alert">
							{confirm.error}
						</p>
					)}
				</fieldset>
			)}
			{toggle.error && (
				<p className="callout tone-danger" role="alert">
					{toggle.error}
				</p>
			)}
		</li>
	);
}

const matches = (row: HarnessRow, text: string) =>
	!text || [row.label, row.id, row.detail ?? ""].some((field) => field.toLowerCase().includes(text));

/**
 * The switches `/harness` shows: other tools (Claude Code, Codex, Cursor) and Octocode's own harnesses, MCP servers,
 * skills, hooks, plugins and extensions. The host lists and writes them; the page only sends one switch and shows the
 * answer. Without `api` (a published link) it explains where to change them instead.
 */
export function HarnessPanel({ api, repoId, reloadKey }: { api?: HarnessApi; repoId?: string; reloadKey: string }) {
	// Keyed by the workspace it was read for: after the choice changes, the old rows (and their trust) are not shown.
	const [loaded, setLoaded] = useState<{ repoId?: string; list: HarnessList } | undefined>();
	const list = loaded?.repoId === repoId ? loaded?.list : undefined;
	const setList = (next: HarnessList) => setLoaded({ ...(repoId !== undefined ? { repoId } : {}), list: next });
	const [error, setError] = useState<string | undefined>();
	const [scope, setScope] = useState<Scope>("global");
	const [filter, setFilter] = useState("");
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

	const canWorkspace = repoId !== undefined && list?.workspace?.trusted === true;
	// A workspace choice holds only while a trusted workspace is chosen; otherwise switches go to the global file.
	const target: Scope = canWorkspace ? scope : "global";
	const text = filter.trim().toLowerCase();
	const switchRow = (row: HarnessRow) => async (on: boolean) => {
		const fresh = await api!.set({
			id: row.id,
			on,
			scope: target,
			...(target === "workspace" && repoId ? { repoId } : {}),
		});
		setList(fresh);
	};

	return (
		<section className="panel" aria-labelledby="config-harness">
			<div className="panel-header">
				<h2 id="config-harness">Harness</h2>
				<p className="muted">
					What Octocode reads from itself and from Claude Code, Codex and Cursor. These are the switches of{" "}
					<code>/harness</code>; other tools' files are never changed.
				</p>
			</div>
			{!api ? (
				<p className="panel-empty muted">
					Open this page from the Octocode terminal (<code>/web</code>) to see and change these switches, or use{" "}
					<code>/harness</code> there.
				</p>
			) : error ? (
				<p className="callout tone-danger" role="alert">
					Can't load the harness switches: {error}
				</p>
			) : !list ? (
				<p className="panel-empty muted">Loading…</p>
			) : (
				<>
					<div className="config-edit">
						<input
							aria-label="Filter switches"
							placeholder="Filter by name or path"
							value={filter}
							autoComplete="off"
							spellCheck={false}
							onChange={(event) => setFilter(event.target.value)}
						/>
						<select
							aria-label="Save switches to"
							value={target}
							onChange={(event) => setScope(event.target.value as Scope)}
						>
							<option value="global">Global settings</option>
							<option value="workspace" disabled={!canWorkspace}>
								{canWorkspace ? "Workspace settings" : "Workspace settings (needs a trusted workspace)"}
							</option>
						</select>
					</div>
					{list.message && <output className="muted">{list.message}</output>}
					{GROUPS.map((group) => {
						const rows = list.rows.filter((row) => group.kinds.includes(row.kind) && matches(row, text));
						if (rows.length === 0) return null;
						return (
							<details key={group.title} className="config-group" open={group.open || !!text}>
								<summary>
									<h3>{group.title}</h3>
									<span className="count">{rows.length}</span>
								</summary>
								<ul className="row-list" aria-label={group.title}>
									{rows.map((row) => (
										<Row
											key={row.id}
											row={row}
											set={switchRow(row)}
											{...(api?.preview ? { preview: () => api.preview!(row.id, repoId) } : {})}
										/>
									))}
								</ul>
							</details>
						);
					})}
				</>
			)}
		</section>
	);
}

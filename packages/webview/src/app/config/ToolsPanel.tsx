import type {
	ToolExposureGroup,
	ToolExposureList,
	ToolExposureRow,
	ToolPinCommand,
} from "@octocodeai/octocode-contracts/config";
import { errorMessage } from "@octocodeai/octocode-contracts/guards";
import { useEffect, useRef, useState } from "react";
import { Badge } from "../ui/primitives.tsx";

/** The host's Tools routes: the list for a workspace, and one pin that answers with the fresh list. */
export interface ToolsApi {
	list: (repoId?: string) => Promise<ToolExposureList>;
	pin: (command: ToolPinCommand) => Promise<ToolExposureList>;
}

type Scope = ToolPinCommand["scope"];
type Pin = NonNullable<ToolExposureRow["pin"]>;
type State = ToolExposureRow["state"];

const STATE = { direct: "Direct", deferred: "Deferred", onDemand: "On demand", hidden: "Hidden" } as const;
const TONE: Record<State, "success" | "accent" | "neutral"> = {
	direct: "success",
	deferred: "accent",
	hidden: "neutral",
};
const NATIVE_PINS: readonly Pin[] = ["direct", "deferred"];
const MCP_PINS: readonly Pin[] = ["direct", "deferred", "onDemand", "hidden"];

const size = (bytes: number): string => (bytes >= 1024 ? `${(bytes / 1024).toFixed(1)} KB` : `${bytes} B`);

/** What the usage record says of the tool: share of declaring sessions, calls, last use, refusals and bytes saved. */
function usage(row: ToolExposureRow): string {
	const audit = row.audit;
	if (!audit) return "—";
	return [
		`${(audit.rate * 100).toFixed(1)}% of ${audit.declared} sessions`,
		`${audit.called} calls`,
		audit.lastUsed ? `last ${audit.lastUsed}` : "unused in 7 days",
		...(audit.refused > 0 ? [`${audit.refused} refused`] : []),
		...(audit.bytesSaved ? [`saves ${size(audit.bytesSaved)}`] : []),
	].join(" · ");
}

/** Why the tool has its state, in the words of the page. */
function reason(row: ToolExposureRow): string {
	switch (row.decidedBy) {
		case "usage":
			return row.audit?.reason === "promoted"
				? "Promoted by use"
				: row.audit?.reason === "unused"
					? "Not used in 7 days"
					: "Below the promotion rate";
		case "pin":
			return "Pinned";
		case "pattern":
			return "A toolExposure pattern";
		case "server":
			return "The server's exposure";
		case "recent":
			return row.state === "direct" ? "Used in the last 24 hours" : "Not used in the last 24 hours";
		case "setting":
			return "The mcpExposure setting";
		case "core":
			return "Always direct";
		default:
			return "Default";
	}
}

function ToolRow({
	group,
	row,
	pin,
}: {
	group: ToolExposureGroup;
	row: ToolExposureRow;
	pin?: (tool: string, value: Pin | null) => Promise<void>;
}) {
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string | undefined>();
	const pinnable = pin && group.pinnable && row.decidedBy !== "core";
	async function change(value: string) {
		setBusy(true);
		setError(undefined);
		try {
			await pin!(row.name, value === "" ? null : (value as Pin));
		} catch (caught) {
			setError(errorMessage(caught));
		} finally {
			setBusy(false);
		}
	}
	return (
		<tr>
			<th scope="row" className="config-name">
				{row.name}
			</th>
			<td>
				<Badge tone={TONE[row.state]}>{STATE[row.state]}</Badge>
			</td>
			<td className="muted">
				{reason(row)}
				{row.pin &&
					row.pin !== row.state &&
					!(row.pin === "onDemand" && row.state === "deferred") &&
					` · ${STATE[row.pin]} from the next session`}
			</td>
			<td className="muted">{usage(row)}</td>
			<td>
				{pinnable ? (
					<select
						aria-label={`Pin ${row.name}`}
						value={row.pin ?? ""}
						disabled={busy}
						onChange={(event) => void change(event.target.value)}
					>
						<option value="">No pin</option>
						{(group.kind === "native" ? NATIVE_PINS : MCP_PINS).map((value) => (
							<option key={value} value={value}>
								{STATE[value]}
							</option>
						))}
					</select>
				) : (
					<span className="muted">{row.pin ? STATE[row.pin] : "—"}</span>
				)}
				{error && (
					<p className="callout tone-danger" role="alert">
						{error}
					</p>
				)}
			</td>
		</tr>
	);
}

const title = (group: ToolExposureGroup) => (group.kind === "native" ? "Native tools" : group.name);

/**
 * Each tool's exposure state, for the native tools and per MCP server, with a pin control. The host lists and writes;
 * the page sends one pin and shows the answer. Without `api` (a published link) it explains where to change pins.
 */
export function ToolsPanel({ api, repoId, reloadKey }: { api?: ToolsApi; repoId?: string; reloadKey: string }) {
	// Keyed by the workspace it was read for: after the choice changes, the old rows (and their trust) are not shown.
	const [loaded, setLoaded] = useState<{ repoId?: string; list: ToolExposureList } | undefined>();
	const list = loaded?.repoId === repoId ? loaded?.list : undefined;
	const [error, setError] = useState<string | undefined>();
	const [scope, setScope] = useState<Scope>("global");
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
	}, [repoId, reloadKey]);

	const canWorkspace = repoId !== undefined && list?.workspace?.trusted === true;
	// A workspace choice holds only while a trusted workspace is chosen; otherwise pins go to the global files.
	const target: Scope = canWorkspace ? scope : "global";
	const pinIn = (group: ToolExposureGroup) => async (tool: string, pin: Pin | null) => {
		const where = { scope: target, ...(target === "workspace" && repoId ? { repoId } : {}) };
		const fresh = await api!.pin(
			group.kind === "native"
				? ({ kind: "native", tool, pin, ...where } as ToolPinCommand)
				: { kind: "mcp", server: group.name, tool, pin, ...where },
		);
		setLoaded({ ...(repoId !== undefined ? { repoId } : {}), list: fresh });
	};

	return (
		<section className="panel" aria-labelledby="config-tools">
			<div className="panel-header">
				<h2 id="config-tools">Tools</h2>
				<p className="muted">
					How much of each tool a session sends to the model. Direct: the full description and parameters. Deferred: the
					description only until the tool is used; it stays callable. Hidden: not offered. A pin fixes the state;
					without one, the <code>mcpExposure</code> setting decides{list ? ` (now ${list.setting})` : ""}. A pin applies
					from the next session: a running session keeps what it declared.
				</p>
			</div>
			{!api ? (
				<p className="panel-empty muted">
					Tool states are shown on the page the Octocode terminal opens (<code>/web</code>), where you can see and pin
					tools, or use <code>/mcp exposure</code> there.
				</p>
			) : error ? (
				<p className="callout tone-danger" role="alert">
					Can't load the tools: {error}
				</p>
			) : !list ? (
				<p className="panel-empty muted">Loading…</p>
			) : (
				<>
					<div className="config-edit">
						<select
							aria-label="Save pins to"
							value={target}
							onChange={(event) => setScope(event.target.value as Scope)}
						>
							<option value="global">Global configuration</option>
							<option value="workspace" disabled={!canWorkspace}>
								{canWorkspace ? "Workspace configuration" : "Workspace configuration (needs a trusted workspace)"}
							</option>
						</select>
					</div>
					{list.message && <output className="muted">{list.message}</output>}
					{list.groups.map((group) => (
						<details key={`${group.kind}:${group.name}`} className="config-group" open={group.kind === "native"}>
							<summary>
								<h3>{title(group)}</h3>
								<span className="count">{group.tools.length}</span>
							</summary>
							{group.note && <p className="muted config-methods config-note">{group.note}</p>}
							{group.kind === "native" && !list.live && (
								<p className="muted config-methods config-note">Every other native tool is always direct.</p>
							)}
							{group.tools.length > 0 && (
								<table className="config-table" aria-label={`${title(group)} exposure`}>
									<thead>
										<tr>
											<th scope="col">Tool</th>
											<th scope="col">{list.live ? "This session" : "Next session"}</th>
											<th scope="col">Decided by</th>
											<th scope="col">Use (7 days)</th>
											<th scope="col">Pin</th>
										</tr>
									</thead>
									<tbody>
										{group.tools.map((row) => (
											<ToolRow key={row.name} group={group} row={row} pin={pinIn(group)} />
										))}
									</tbody>
								</table>
							)}
						</details>
					))}
				</>
			)}
		</section>
	);
}

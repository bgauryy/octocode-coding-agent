import type { RunnerCommand, RunnerList, RunnerRow } from "@octocodeai/octocode-contracts/config";
import { errorMessage } from "@octocodeai/octocode-contracts/guards";
import { useEffect, useRef, useState } from "react";
import { Badge, Button } from "../ui/primitives.tsx";
import { useSwitch } from "./ProviderControls.tsx";

/** The host's External agents routes: the runners as last detected, and one command that answers with the fresh list. */
export interface RunnersApi {
	list: () => Promise<RunnerList>;
	act: (command: RunnerCommand) => Promise<RunnerList>;
}

function signInWords(row: RunnerRow): string {
	const { signIn } = row;
	if (signIn.state === "unchecked") return "not checked yet";
	if (signIn.state === "unknown") return `sign-in unknown${signIn.error ? ` (${signIn.error})` : ""}`;
	if (signIn.state === "signed-out") return "signed out";
	const billing = signIn.billing === "metered" ? "metered key" : signIn.billing === "plan" ? "plan" : "billing unknown";
	return `signed in${signIn.method ? ` · ${signIn.method}` : ""} · ${billing}`;
}

function Runner({ row, act }: { row: RunnerRow; act?: (command: RunnerCommand) => Promise<void> }) {
	const check = useSwitch(() => act!({ action: "check", id: row.id }));
	const toggle = useSwitch(() => act!({ action: "set-enabled", id: row.id, enabled: !row.enabled }));
	const installed = row.cli.installed;
	return (
		<li className="config-row">
			<div className="config-row-head">
				<span className="config-name">{row.name}</span>
				<Badge tone={row.connected && row.enabled ? "success" : row.connected || !installed ? "neutral" : "warning"}>
					{!installed ? "Not installed" : !row.connected ? "Not ready" : row.enabled ? "Ready" : "Off for tasks"}
				</Badge>
				{act && installed && (
					<Button size="sm" onClick={check.click} loading={check.busy} aria-label={`Check ${row.name}`}>
						Check
					</Button>
				)}
				{act && (installed || row.enabled) && (
					<Button
						size="sm"
						onClick={toggle.click}
						loading={toggle.busy}
						aria-label={`${row.enabled ? "Disable" : "Enable"} ${row.name} for tasks`}
					>
						{row.enabled ? "Disable" : "Enable"}
					</Button>
				)}
			</div>
			<p className="muted config-methods">
				{installed
					? `CLI ${row.cli.version ?? "found"}${row.cli.untested ? ` (checked from ${row.cli.tested})` : ""}`
					: `${row.cli.command} not on PATH`}
				{installed && row.adapter.route ? ` · ${row.adapter.route}` : ""}
				{installed && !row.adapter.installed ? ` · adapter ${row.adapter.command} missing` : ""}
				{` · ${signInWords(row)}`}
			</p>
			{(!installed || !row.adapter.installed) && (
				<p className="muted config-methods">
					Install: <code>{row.adapter.install}</code>
				</p>
			)}
			{installed && !row.connected && (
				<p className="muted config-methods">
					Sign in from a terminal: <code>{row.login}</code>, then Check.
				</p>
			)}
			{(check.error ?? toggle.error) && (
				<p className="callout tone-danger" role="alert">
					{check.error ?? toggle.error}
				</p>
			)}
		</li>
	);
}

function PauseAll({ list, act }: { list: RunnerList; act: (command: RunnerCommand) => Promise<void> }) {
	const pause = useSwitch(() => act({ action: "set-tasks", enabled: !list.tasksEnabled }));
	return (
		<div className="config-row-head">
			<span className="muted">Agent tasks may use external agents: {list.tasksEnabled ? "on" : "off"}</span>
			<Button
				size="sm"
				onClick={pause.click}
				loading={pause.busy}
				aria-label={list.tasksEnabled ? "Pause all external agents" : "Resume external agents"}
			>
				{list.tasksEnabled ? "Pause all" : "Resume"}
			</Button>
			{pause.error && (
				<p className="callout tone-danger" role="alert">
					{pause.error}
				</p>
			)}
		</div>
	);
}

/**
 * The External agents of `/providers`: vendor CLIs that run `agent` tasks with their own sign-in. The host detects,
 * checks and writes the setting; the page sends one verb and shows the answer. Signing in is the vendor's own terminal
 * command, never a form here. Without `api` it says where to manage them instead.
 */
export function RunnersPanel({ api, reloadKey }: { api?: RunnersApi; reloadKey: string }) {
	const [list, setList] = useState<RunnerList | undefined>();
	const [error, setError] = useState<string | undefined>();
	const hasApi = api !== undefined;
	const loader = useRef(api);
	useEffect(() => {
		loader.current = api;
	}, [api]);

	useEffect(() => {
		let current = true;
		loader.current?.list().then(
			(fetched) => {
				if (!current) return;
				setList(fetched);
				setError(undefined);
			},
			(caught: unknown) => {
				if (current) setError(errorMessage(caught));
			},
		);
		return () => {
			current = false;
		};
	}, [hasApi, reloadKey]);

	const act = async (command: RunnerCommand) => setList(await api!.act(command));

	return (
		<section className="panel" aria-labelledby="config-runners">
			<div className="panel-header">
				<h2 id="config-runners">External agents</h2>
				<p className="muted">
					Claude Code, Codex, Cursor, Gemini and OpenCode run agent tasks in their own harness with their own sign-in,
					as in <code>/providers</code>. Running sessions apply a change after <code>/reload</code>.
				</p>
			</div>
			{!api ? (
				<p className="panel-empty muted">
					Manage external agents through <code>/web</code> or <code>/providers</code> in the Octocode terminal.
				</p>
			) : error ? (
				<p className="callout tone-danger" role="alert">
					Can't load the external agents: {error}
				</p>
			) : !list ? (
				<p className="panel-empty muted">Loading…</p>
			) : (
				<>
					{list.message && <output className="muted">{list.message}</output>}
					<PauseAll list={list} act={act} />
					<ul className="row-list" aria-label="External agents">
						{list.runners.map((row) => (
							<Runner key={row.id} row={row} act={act} />
						))}
					</ul>
				</>
			)}
		</section>
	);
}

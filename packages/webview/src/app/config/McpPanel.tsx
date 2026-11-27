import { useEffect, useState } from "react";
import type { McpAddAvailability } from "@octocodeai/octocode-contracts/config";
import { Button } from "../ui/primitives.tsx";
import { McpAddForm, type AddMcp } from "./McpAddForm.tsx";

export type McpAddStatus = (repoId?: string) => Promise<McpAddAvailability>;

function AvailableMcpForm({ add, repoId, trusted }: { add: AddMcp; repoId?: string; trusted: boolean }) {
	const [open, setOpen] = useState(false);
	const [message, setMessage] = useState<string>();
	const [warnings, setWarnings] = useState<string[]>([]);
	return (
		<>
			{message && <output>{message}</output>}
			{warnings.map((warning) => (
				<p role="alert" key={warning}>
					{warning}
				</p>
			))}
			{open ? (
				<McpAddForm
					add={add}
					repoId={repoId}
					trusted={trusted}
					onCancel={() => setOpen(false)}
					onSaved={(result) => {
						setMessage(result.message);
						setWarnings(result.warnings ?? []);
						setOpen(false);
					}}
				/>
			) : (
				<Button
					type="button"
					onClick={() => {
						setMessage(undefined);
						setWarnings([]);
						setOpen(true);
					}}
				>
					Add MCP
				</Button>
			)}
		</>
	);
}

export function McpPanel({
	add,
	status,
	repoId,
	trusted,
}: {
	add?: AddMcp;
	status?: McpAddStatus;
	repoId?: string;
	trusted: boolean;
}) {
	const [availability, setAvailability] = useState<{
		reader: McpAddStatus;
		add: AddMcp;
		repoId?: string;
		value: McpAddAvailability;
	}>();
	useEffect(() => {
		let active = true;
		if (add && status)
			void status(repoId).then(
				(value) => {
					if (active) setAvailability({ reader: status, add, repoId, value });
				},
				() => {
					if (active)
						setAvailability({
							reader: status,
							add,
							repoId,
							value: {
								available: false,
								message: "Could not check the running session's MCP registry. Reopen its Settings page to retry.",
							},
						});
				},
			);
		return () => {
			active = false;
		};
	}, [add, status, repoId]);
	const current =
		availability?.reader === status && availability?.add === add && availability?.repoId === repoId
			? availability?.value
			: undefined;
	return (
		<section className="config-section" aria-label="Add MCP server">
			<h2>Add MCP server</h2>
			<p className="muted">
				Save a stdio or HTTP definition. New servers are off and unassigned; review them in /security before enabling.
			</p>
			{!add ? (
				<p className="muted">Read-only. Open settings from the Octocode terminal to add an MCP server.</p>
			) : !status ? (
				<p className="muted">Open a running session's page and choose Settings to add MCP servers.</p>
			) : !current ? (
				<p className="muted">Checking the running session's MCP registry…</p>
			) : !current.available ? (
				<p className="muted">{current.message ?? "Open a running session's Settings page to add MCP servers."}</p>
			) : (
				<AvailableMcpForm add={add} repoId={repoId} trusted={trusted} />
			)}
		</section>
	);
}

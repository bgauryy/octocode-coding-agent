import type { ProviderCredentialStatus } from "@octocodeai/octocode-contracts/config";
import { useState } from "react";
import { Button } from "../ui/primitives.tsx";
import { type SetProvider, useSwitch } from "./ProviderControls.tsx";

function ModelChecklist({
	row,
	title,
	set,
	close,
}: {
	row: ProviderCredentialStatus;
	title: string;
	set: SetProvider;
	close: () => void;
}) {
	const { ids, hidden } = row.modelChoice!;
	const [unticked, setUnticked] = useState(() => new Set(hidden));
	const [query, setQuery] = useState("");
	const shown = ids.filter((id) => id.toLowerCase().includes(query.trim().toLowerCase()));
	// Hidden ids the provider no longer lists stay hidden: its catalog may come back.
	const unlisted = hidden.filter((id) => !ids.includes(id));
	const save = useSwitch(async () => {
		await set({
			action: "set-models",
			provider: row.provider,
			hidden: [...unlisted, ...ids.filter((id) => unticked.has(id))],
		});
		close();
	});
	const toggle = (id: string) =>
		setUnticked((current) => {
			const next = new Set(current);
			if (!next.delete(id)) next.add(id);
			return next;
		});
	const setAll = (ticked: boolean) =>
		setUnticked((current) => {
			const next = new Set(current);
			for (const id of shown) {
				if (ticked) next.delete(id);
				else next.add(id);
			}
			return next;
		});
	return (
		<fieldset className="config-edit" aria-label={`Choose models of ${title}`}>
			<input
				type="search"
				aria-label={`Search models of ${title}`}
				placeholder="Search models"
				value={query}
				onChange={(event) => setQuery(event.target.value)}
			/>
			<ul className="config-sources">
				{shown.map((id) => (
					<li key={id}>
						<label>
							<input type="checkbox" checked={!unticked.has(id)} onChange={() => toggle(id)} /> <code>{id}</code>
						</label>
					</li>
				))}
			</ul>
			<Button size="sm" onClick={() => setAll(true)}>
				Tick all
			</Button>
			<Button size="sm" onClick={() => setAll(false)}>
				Untick all
			</Button>
			<Button size="sm" onClick={save.click} loading={save.busy}>
				Save models
			</Button>
			<Button size="sm" onClick={close}>
				Cancel
			</Button>
			{save.error && (
				<p className="callout tone-danger" role="alert">
					{save.error}
				</p>
			)}
		</fieldset>
	);
}

/** "Choose models": tick which of the provider's models /model, Ctrl+P and subagents may use. Needs the host's write capability. */
export function ModelChoiceControls({ row, set }: { row: ProviderCredentialStatus; set: SetProvider }) {
	const [open, setOpen] = useState(false);
	if (!row.modelChoice) return null;
	const title = row.name ?? row.provider;
	const { ids, hidden } = row.modelChoice;
	const shownCount = ids.filter((id) => !hidden.includes(id)).length;
	if (open) return <ModelChecklist row={row} title={title} set={set} close={() => setOpen(false)} />;
	return (
		<div className="config-edit">
			<Button size="sm" onClick={() => setOpen(true)} aria-label={`Choose models of ${title}`}>
				Choose models
			</Button>
			{hidden.length > 0 && (
				<span className="muted">
					{shownCount} of {ids.length} shown
				</span>
			)}
		</div>
	);
}

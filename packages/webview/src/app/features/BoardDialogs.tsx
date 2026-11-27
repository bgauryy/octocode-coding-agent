import type { SnapshotItem, State } from "@octocodeai/octocode-contracts/snapshot";
import { type SubmitEvent, useState } from "react";
import { navigate } from "../hooks.ts";
import { STATE_TITLES } from "../model/backlog.ts";
import { Field } from "../ui/fields.tsx";
import { Button } from "../ui/primitives.tsx";
import { BoardPopup } from "./BoardPopup.tsx";
import { useBoardFlow } from "./board-flow.tsx";

/** The one question a drop may need answered: claim, fill in goal and why, a reopen note, or the Close form. */
export function BoardDialogs() {
	const flow = useBoardFlow();
	const { dialog, actions } = flow;
	if (!dialog || !actions) return null;
	const item = flow.find(dialog.item.ref) ?? dialog.item;
	switch (dialog.kind) {
		case "close":
			return (
				<actions.CloseDialog
					item={item}
					onClose={flow.dismissDialog}
					onClosed={(refreshed) => flow.closed(item, refreshed)}
				/>
			);
		case "claim":
			return (
				<BoardPopup label={`Start ${item.ref}`} onClose={flow.dismissDialog}>
					<div className="popup-body">
						<h3>Start {item.ref} as you?</h3>
						<p>
							Moving it to In progress assigns {item.ref} to you. The host refuses it if another session already holds
							it.
						</p>
						<div className="actions">
							<Button variant="primary" onClick={() => flow.confirmClaim(item)}>
								Claim as you
							</Button>
							<Button variant="ghost" onClick={flow.dismissDialog}>
								Cancel
							</Button>
						</div>
					</div>
				</BoardPopup>
			);
		case "missing":
			return (
				<BoardPopup label={`${item.ref} needs more before it can start`} onClose={flow.dismissDialog}>
					<div className="popup-body">
						<h3>{item.ref} is not ready to start</h3>
						<p>
							In progress needs a goal and a why. Missing: <strong>{dialog.missing.join(" and ")}</strong>.
						</p>
						<div className="actions">
							<Button
								variant="primary"
								onClick={() => {
									flow.dismissDialog();
									navigate(`#${item.ref}/edit`);
								}}
							>
								Edit {item.ref}
							</Button>
							<Button variant="ghost" onClick={flow.dismissDialog}>
								Cancel
							</Button>
						</div>
					</div>
				</BoardPopup>
			);
		case "reopen":
			return <ReopenNote item={item} state={dialog.state} />;
	}
}

function ReopenNote({ item, state }: { item: SnapshotItem; state: State }) {
	const flow = useBoardFlow();
	const [note, setNote] = useState("");
	function submit(event: SubmitEvent<HTMLFormElement>) {
		event.preventDefault();
		if (note.trim()) flow.confirmReopen(item, state, note.trim());
	}
	return (
		<BoardPopup label={`Reopen ${item.ref}`} onClose={flow.dismissDialog}>
			<form className="popup-body" onSubmit={submit}>
				<h3>
					Reopen {item.ref} to {STATE_TITLES[state]}
				</h3>
				<Field label="Why is it reopened?" hint="Reopening needs a note; it is kept on the item.">
					{(props) => (
						<textarea
							{...props}
							rows={3}
							required
							maxLength={4000}
							value={note}
							onChange={(event) => setNote(event.target.value)}
						/>
					)}
				</Field>
				{state === "ongoing" && <p className="muted">It also becomes yours: In progress assigns the item to you.</p>}
				<div className="actions">
					<Button type="submit" variant="primary" disabled={!note.trim()}>
						Reopen
					</Button>
					<Button variant="ghost" onClick={flow.dismissDialog}>
						Cancel
					</Button>
				</div>
			</form>
		</BoardPopup>
	);
}

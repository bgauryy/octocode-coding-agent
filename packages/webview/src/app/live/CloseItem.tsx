import type { SnapshotItem } from "@octocodeai/octocode-contracts/snapshot";
import { CLOSE_KINDS, type CloseKind } from "@octocodeai/octocode-contracts/backlogs";
import { errorMessage } from "@octocodeai/octocode-contracts/guards";
import { type SubmitEvent, useState } from "react";
import { BoardPopup } from "../features/BoardPopup.tsx";
import { Field, Select } from "../ui/fields.tsx";
import { Button } from "../ui/primitives.tsx";
import { tryRefresh } from "./refresh.ts";
import { useLive } from "./session.tsx";

const KIND_LABELS: Record<CloseKind, string> = {
	obsolete: "Obsolete: no longer needed",
	duplicate: "Duplicate of another item",
	wont_do: "Won't do",
};

/**
 * Closing is the only way to end an item that is not needed: it is kept with the reason, hidden from the default board,
 * and can be reopened. A done or closed item is reopened first, so the control shows only for open items.
 */
export function CloseItem({ item }: { item: SnapshotItem }) {
	const [open, setOpen] = useState(false);
	if (item.state === "done") return null;
	if (!open)
		return (
			<Button onClick={() => setOpen(true)} aria-haspopup="dialog">
				Close…
			</Button>
		);
	return <CloseItemForm item={item} onCancel={() => setOpen(false)} onClosed={() => setOpen(false)} />;
}

/** The Close form as a dialog, for the board card menu and the Closed drop zone. */
export function CloseItemDialog({
	item,
	onClose,
	onClosed,
}: {
	item: SnapshotItem;
	onClose: () => void;
	onClosed: (refreshed: boolean) => void;
}) {
	const { refresh } = useLive();
	return (
		<BoardPopup label={`Close item ${item.ref}`} onClose={onClose}>
			<CloseItemForm
				item={item}
				onCancel={onClose}
				onClosed={async () => {
					// The live push also delivers the change; reloading makes the Undo that follows use the current version.
					onClosed(await tryRefresh(refresh));
				}}
			/>
		</BoardPopup>
	);
}

function CloseItemForm({
	item,
	onCancel,
	onClosed,
}: {
	item: SnapshotItem;
	onCancel: () => void;
	onClosed: () => void | Promise<void>;
}) {
	const { api } = useLive();
	const [kind, setKind] = useState<CloseKind>("obsolete");
	const [of, setOf] = useState("");
	const [text, setText] = useState("");
	const [status, setStatus] = useState<{ pending: boolean; error?: string }>({ pending: false });
	async function submit(event: SubmitEvent<HTMLFormElement>) {
		event.preventDefault();
		setStatus({ pending: true });
		try {
			await api.backlogCommand({
				command: "item.close",
				id: item.ref,
				version: item.version,
				kind,
				text: text.trim(),
				...(kind === "duplicate" ? { of: of.trim().toUpperCase() } : {}),
			});
			await onClosed();
		} catch (error) {
			setStatus({ pending: false, error: errorMessage(error) });
		}
	}
	return (
		<form className="composer close-item" onSubmit={submit} aria-label={`Close ${item.ref}`}>
			<Field label="Why is it closed?" hint="The item is kept with this reason; reopen it later with a note.">
				{(props) => (
					<Select
						{...props}
						value={kind}
						options={CLOSE_KINDS.map((value) => ({ value, label: KIND_LABELS[value] }))}
						onChange={(event) => setKind(event.target.value as CloseKind)}
					/>
				)}
			</Field>
			{kind === "duplicate" && (
				<Field label="Duplicate of">
					{(props) => (
						<input
							{...props}
							required
							pattern="[Bb][0-9]+"
							placeholder="B12"
							value={of}
							onChange={(event) => setOf(event.target.value)}
						/>
					)}
				</Field>
			)}
			<Field label="Reason">
				{(props) => (
					<textarea
						{...props}
						rows={3}
						required
						maxLength={2000}
						value={text}
						onChange={(event) => setText(event.target.value)}
					/>
				)}
			</Field>
			<div className="actions">
				<Button type="submit" variant="danger" loading={status.pending}>
					Close {item.ref}
				</Button>
				<Button type="button" variant="ghost" onClick={onCancel}>
					Cancel
				</Button>
			</div>
			{status.error && <p role="alert">{status.error}</p>}
		</form>
	);
}

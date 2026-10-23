import { type FormEvent, type ReactNode, useState } from "react";
import { useStore } from "zustand";
import type { EditorProps } from "../extension.ts";
import { ITEM_TYPES, PRIORITIES, PRIORITY_TITLES, STATE_TITLES } from "../model/backlog.ts";
import {
	type EditorValues,
	editorDefaults,
	FILE_ROLES,
	locksIntent,
	needsCompletion,
	toMutation,
	VERIFICATION_LABELS,
	VERIFICATION_STATUSES,
} from "../model/editor.ts";
import { errorMessage } from "../model/format.ts";
import { Field, Select } from "../ui/fields.tsx";
import { CloseIcon } from "../ui/icons.tsx";
import { Button, IconButton } from "../ui/primitives.tsx";
import { useLive } from "./session.tsx";

/**
 * Title-first item editor. Every change is kept as a tab-local draft with the version it started from and its
 * operation key, so a retried save is deduplicated and a stale draft is reported instead of overwriting newer work.
 */
export function Editor({ item, correction, onClose }: EditorProps) {
	const { workspace, api, refresh, backlog } = useLive();
	const states = useStore(backlog, (state) => state.snapshot.states);
	const draftKey = `editor:${item ? item.ref : "new"}${correction ? ":correction" : ""}`;
	const [initial] = useState(() => {
		const draft = workspace.getState().drafts[draftKey];
		const restored = draft
			? { ...editorDefaults(item, correction), ...(JSON.parse(draft.text) as Partial<EditorValues>) }
			: undefined;
		return {
			values: restored ?? editorDefaults(item, correction),
			version: draft?.version ?? item?.version,
			operationKey: draft?.id ?? crypto.randomUUID(),
			notice: draft
				? item && draft.version !== item.version
					? "Draft restored from an older version. Copy your changes, then discard the draft to load the latest item before saving."
					: "Unsaved draft restored in this tab."
				: "",
		};
	});
	const [values, setValues] = useState(initial.values);
	const [saving, setSaving] = useState(false);
	const [error, setError] = useState("");

	function change(name: keyof EditorValues, value: string) {
		const next = { ...values, [name]: value };
		setValues(next);
		workspace
			.getState()
			.setDraft(draftKey, { id: initial.operationKey, text: JSON.stringify(next), version: initial.version });
	}
	function discard() {
		workspace.getState().setDraft(draftKey, null);
		onClose();
	}
	async function submit(event: FormEvent) {
		event.preventDefault();
		setSaving(true);
		setError("");
		try {
			const mutation = toMutation(values, {
				item,
				correction,
				baseVersion: initial.version,
				operationKey: initial.operationKey,
				states,
			});
			const result = await api.mutate(mutation);
			workspace.getState().setDraft(draftKey, null);
			await refresh();
			onClose(result.item.ref);
		} catch (failure) {
			setError(
				`${errorMessage(failure)} Your changes are still here. Close and reopen to load the latest version if another session edited this item.`,
			);
		} finally {
			setSaving(false);
		}
	}

	const text = (
		name: keyof EditorValues,
		label: string,
		options: { rows?: number; hint?: string; disabled?: boolean } = {},
	) => (
		<Field label={label} hint={options.hint}>
			{(props) => (
				<textarea
					{...props}
					rows={options.rows ?? 2}
					value={values[name]}
					disabled={options.disabled}
					onChange={(event) => change(name, event.target.value)}
				/>
			)}
		</Field>
	);
	const pick = (
		name: keyof EditorValues,
		label: string,
		options: readonly (string | { value: string; label: string })[],
		disabled = false,
	): ReactNode => (
		<Field label={label}>
			{(props) => (
				<Select
					{...props}
					value={values[name]}
					disabled={disabled}
					onChange={(event) => change(name, event.target.value)}
					options={options}
				/>
			)}
		</Field>
	);
	const intentLocked = locksIntent(values, item);

	return (
		<form className="editor" onSubmit={submit} aria-busy={saving}>
			<div className="sheet-bar">
				<h2 id="editor-title">
					{correction && item ? `Correct result for ${item.ref}` : item ? `Edit ${item.ref}` : "New backlog item"}
				</h2>
				<IconButton label="Close" icon={<CloseIcon />} className="push-right" onClick={() => onClose()} />
			</div>
			{initial.notice && (
				<p className="callout tone-accent" role="note">
					{initial.notice}
				</p>
			)}
			<Field label="Title">
				{(props) => (
					<input
						{...props}
						data-autofocus=""
						required
						value={values.title}
						onChange={(event) => change("title", event.target.value)}
					/>
				)}
			</Field>
			<div className="field-grid">
				{pick("type", "Type", ITEM_TYPES)}
				{pick(
					"state",
					"State",
					states.map((state) => ({ value: state, label: STATE_TITLES[state] })),
					correction,
				)}
			</div>
			{text("reason", "Reason — why it matters", { disabled: intentLocked })}
			{text("goal", "Goal — what done means", {
				disabled: intentLocked,
				hint: intentLocked ? "Reopen the item to change its goal or reason." : undefined,
			})}
			<details className="disclosure">
				<summary>Relationships (optional)</summary>
				<Field label="Parent item">
					{(props) => (
						<input
							{...props}
							placeholder="B12"
							value={values.parentId}
							onChange={(event) => change("parentId", event.target.value)}
						/>
					)}
				</Field>
				{text("dependsOn", "Depends on (item IDs)", { rows: 1, hint: "Separate IDs with commas or spaces." })}
			</details>
			<details className="disclosure">
				<summary>More details (optional)</summary>
				{pick(
					"priority",
					"Priority",
					PRIORITIES.map((value) => ({ value, label: `${value} · ${PRIORITY_TITLES[value]}` })),
				)}
				{text("tags", "Tags", { rows: 1, hint: "Separate tags with commas or spaces." })}
				{text("body", "Details", { rows: 4 })}
				{text("plan", "Approach", { rows: 3 })}
				{text("paths", "Scope paths (one per line)")}
				{text("evidence", "Evidence (one per line)")}
				{text("urls", "Related links (one URL per line)")}
			</details>
			{text("note", item?.state === "done" ? "Reason for reopening" : "Note (optional)")}
			{needsCompletion(values, item, correction) && (
				<fieldset className="completion">
					<legend>Completion</legend>
					{text("summary", "What changed?")}
					{text("files", "Related files (one path per line; empty for none)")}
					<div className="field-grid">
						{pick("fileRole", "File role", FILE_ROLES)}
						{pick(
							"verificationStatus",
							"Verification",
							VERIFICATION_STATUSES.map((value) => ({ value, label: VERIFICATION_LABELS[value] })),
						)}
					</div>
					{text("verificationSummary", "Check result")}
					{text("lesson", "Lesson (optional)")}
				</fieldset>
			)}
			<p className="form-error" role="alert">
				{error}
			</p>
			<div className="form-actions">
				<Button type="submit" variant="primary" loading={saving}>
					Save item
				</Button>
				<Button variant="ghost" onClick={discard}>
					Discard draft
				</Button>
			</div>
		</form>
	);
}

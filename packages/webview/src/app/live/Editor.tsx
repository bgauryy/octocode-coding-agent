import { type FormEvent, type ReactNode, useEffect, useRef, useState } from "react";
import { useStore } from "zustand";
import type { EditorProps } from "../extension.ts";
import { ITEM_TYPES, PRIORITY_OPTIONS, STATE_TITLES } from "../model/backlog.ts";
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
 * operation key for completion records, so stale drafts cannot overwrite newer work.
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
	const [savedRef, setSavedRef] = useState<string>();
	const pending = useRef(false);
	const mounted = useRef(true);
	useEffect(() => {
		mounted.current = true;
		return () => {
			mounted.current = false;
		};
	}, []);
	const stale = Boolean(item && initial.version !== item.version);
	const notice = stale
		? "This item changed after your draft started. Copy your changes, then discard the draft to load the latest item."
		: initial.notice;

	function change(name: keyof EditorValues, value: string) {
		const next = { ...values, [name]: value };
		setValues(next);
		workspace
			.getState()
			.setDraft(draftKey, { id: initial.operationKey, text: JSON.stringify(next), version: initial.version });
	}
	async function openSaved() {
		if (!savedRef || pending.current) return;
		pending.current = true;
		setSaving(true);
		try {
			await refresh();
			if (mounted.current) onClose(savedRef);
		} catch (failure) {
			if (mounted.current) setError(`Item saved. ${errorMessage(failure)} Refresh again to open it.`);
		} finally {
			pending.current = false;
			if (mounted.current) setSaving(false);
		}
	}
	async function discard() {
		if (pending.current) return;
		pending.current = true;
		setSaving(true);
		const discardedDraft = workspace.getState().drafts[draftKey];
		try {
			if (item) await refresh();
			if (workspace.getState().drafts[draftKey] === discardedDraft) workspace.getState().setDraft(draftKey, null);
			if (mounted.current) onClose();
		} catch (failure) {
			if (mounted.current) setError(`${errorMessage(failure)} Your draft was not discarded.`);
		} finally {
			pending.current = false;
			if (mounted.current) setSaving(false);
		}
	}
	async function submit(event: FormEvent) {
		event.preventDefault();
		if (pending.current || savedRef || stale) return;
		pending.current = true;
		setSaving(true);
		setError("");
		const submittedDraft = workspace.getState().drafts[draftKey];
		let accepted = false;
		try {
			const mutation = toMutation(values, {
				item,
				correction,
				baseVersion: initial.version,
				operationKey: initial.operationKey,
				states,
			});
			const result = await api.mutate(mutation);
			accepted = true;
			if (workspace.getState().drafts[draftKey] === submittedDraft) workspace.getState().setDraft(draftKey, null);
			if (mounted.current) setSavedRef(result.item.ref);
			await refresh();
			if (mounted.current) onClose(result.item.ref);
		} catch (failure) {
			if (mounted.current)
				setError(
					accepted
						? `Item saved. ${errorMessage(failure)} The board could not refresh; your changes are saved.`
						: `${errorMessage(failure)} Your changes are still here. Copy them before using Discard draft to load the latest item.`,
				);
		} finally {
			pending.current = false;
			if (mounted.current) setSaving(false);
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
			{notice && !savedRef && (
				<p className="callout tone-accent" role="note">
					{notice}
				</p>
			)}
			<fieldset className="editor-fields" disabled={saving || Boolean(savedRef)}>
				<legend className="visually-hidden">Item details</legend>
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
					{pick("priority", "Priority", PRIORITY_OPTIONS)}
					{text("tags", "Tags", { rows: 1, hint: "Separate tags with commas or spaces." })}
					{text("body", "Details", { rows: 4 })}
					{text("plan", "Approach", { rows: 3 })}
					{text("paths", "Scope paths (one per line)")}
					{text("evidence", "Evidence (one per line)")}
					{text("urls", "Related links (one URL per line)")}
				</details>
				{text("note", item?.state === "done" && values.state !== "done" ? "Reason for reopening" : "Note (optional)")}
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
			</fieldset>
			<p className="form-error" role="alert">
				{error}
			</p>
			<div className="form-actions">
				{savedRef ? (
					<Button variant="primary" loading={saving} onClick={openSaved}>
						Open saved item
					</Button>
				) : (
					<Button type="submit" variant="primary" loading={saving} disabled={stale}>
						Save item
					</Button>
				)}
				<Button variant="ghost" onClick={discard} disabled={saving || Boolean(savedRef)}>
					Discard draft
				</Button>
			</div>
		</form>
	);
}

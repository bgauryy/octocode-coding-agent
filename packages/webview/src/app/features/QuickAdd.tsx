import { errorMessage } from "@octocodeai/octocode-contracts/guards";
import type { State } from "@octocodeai/octocode-contracts/snapshot";
import { type KeyboardEvent, type SubmitEvent, useEffect, useRef, useState } from "react";
import { STATE_TITLES } from "../model/backlog.ts";
import { useBoardActions } from "./board-context.tsx";

/** A "+ Add a card" row: one title, Enter adds it and keeps the row open for the next, Escape cancels. */
export function QuickAdd({ state }: { state: State }) {
	const actions = useBoardActions();
	const [open, setOpen] = useState(false);
	const [title, setTitle] = useState("");
	const [pending, setPending] = useState(false);
	const [error, setError] = useState("");
	const input = useRef<HTMLInputElement>(null);
	const refocus = useRef(false);
	// The field is disabled while saving, and a disabled field cannot take focus: refocus once it is enabled again.
	useEffect(() => {
		if (pending || !refocus.current) return;
		refocus.current = false;
		input.current?.focus();
	}, [pending]);
	if (!actions) return null;
	const label = `Title of the new card in ${STATE_TITLES[state]}`;
	async function submit(event: SubmitEvent) {
		event.preventDefault();
		const text = title.trim();
		if (!text || pending || !actions) return;
		setPending(true);
		setError("");
		try {
			await actions.add(text, state);
			setTitle("");
			refocus.current = true;
		} catch (failure) {
			setError(errorMessage(failure));
		} finally {
			setPending(false);
		}
	}
	function keys(event: KeyboardEvent) {
		if (event.key !== "Escape") return;
		event.preventDefault();
		setOpen(false);
		setTitle("");
		setError("");
	}
	if (!open)
		return (
			<button type="button" className="quick-add-open" onClick={() => setOpen(true)}>
				+ Add a card
				<span className="visually-hidden"> to {STATE_TITLES[state]}</span>
			</button>
		);
	return (
		<form className="quick-add" onSubmit={submit}>
			<input
				ref={input}
				// oxlint-disable-next-line jsx-a11y/no-autofocus -- the person just asked for this field.
				autoFocus
				aria-label={label}
				placeholder="Title, then Enter"
				value={title}
				disabled={pending}
				onKeyDown={keys}
				maxLength={500}
				onChange={(event) => setTitle(event.target.value)}
			/>
			{error && (
				<p className="form-error" role="alert">
					{error}
				</p>
			)}
		</form>
	);
}

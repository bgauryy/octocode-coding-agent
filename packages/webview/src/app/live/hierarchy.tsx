import {
	type BacklogTask,
	DEFAULT_ITEM_TYPE,
	TASK_STATES,
	type TaskState,
} from "@octocodeai/octocode-contracts/backlogs";
import { errorMessage } from "@octocodeai/octocode-contracts/guards";
import type { SnapshotItem, State } from "@octocodeai/octocode-contracts/snapshot";
import { type ComponentProps, type FormEvent, type KeyboardEvent, useEffect, useRef, useState } from "react";
import { TaskList } from "../features/Tasks.tsx";
import type { HierarchyControls } from "../extension.ts";
import { navigate } from "../hooks.ts";
import { STATE_TITLES } from "../model/backlog.ts";
import { epicsFor, isEpic, movedPosition, TASK_STATE_TITLES } from "../model/hierarchy.ts";
import { Select } from "../ui/fields.tsx";
import { Button, Section } from "../ui/primitives.tsx";
import { useLive } from "./session.tsx";

/**
 * Runs one edit at a time and keeps the host's one-line refusal next to the control. The host decides every rule; a
 * success or a version conflict reloads the board so the page shows the current copy.
 */
function useEdit() {
	const { refresh } = useLive();
	const [pending, setPending] = useState(false);
	const [error, setError] = useState("");
	const busy = useRef(false);
	const mounted = useRef(true);
	useEffect(() => {
		mounted.current = true;
		return () => {
			mounted.current = false;
		};
	}, []);
	async function run(send: () => Promise<unknown>): Promise<boolean> {
		if (busy.current) return false;
		busy.current = true;
		setPending(true);
		setError("");
		let saved = false;
		try {
			await send();
			saved = true;
		} catch (failure) {
			if (mounted.current) setError(errorMessage(failure));
		}
		// The live push also delivers the change; reloading here covers a missed push and shows the current copy after a conflict.
		await refresh().catch(() => undefined);
		busy.current = false;
		if (mounted.current) setPending(false);
		return saved;
	}
	return { run, pending, error };
}

function Refusal({ error }: { error: string }) {
	if (!error) return null;
	return (
		<p className="form-error" role="alert">
			{error}
		</p>
	);
}

/** One line of text and an Add button; the text is kept when the host refuses. */
function AddForm({
	label,
	button,
	onAdd,
}: {
	label: string;
	button: string;
	onAdd: (text: string) => Promise<unknown>;
}) {
	const { run, pending, error } = useEdit();
	const [text, setText] = useState("");
	async function submit(event: FormEvent) {
		event.preventDefault();
		if (!text.trim()) return;
		if (await run(() => onAdd(text.trim()))) setText("");
	}
	return (
		<form className="inline-add" onSubmit={submit}>
			<input
				aria-label={label}
				placeholder={label}
				value={text}
				disabled={pending}
				maxLength={500}
				onChange={(event) => setText(event.target.value)}
			/>
			<Button type="submit" size="sm" loading={pending} disabled={!text.trim()}>
				{button}
			</Button>
			<Refusal error={error} />
		</form>
	);
}

/** State, goal edit and reorder for one task. Reorder works by buttons and by Alt+Up / Alt+Down inside the row. */
function TaskTools({ task, siblings }: { task: BacklogTask; siblings: readonly BacklogTask[] }) {
	const { api } = useLive();
	const { run, pending, error } = useEdit();
	const [editing, setEditing] = useState(false);
	const [goal, setGoal] = useState(task.goal);
	async function move(delta: -1 | 1) {
		const position = movedPosition(siblings, task.ref, delta);
		if (position === undefined) return;
		await run(() => api.backlogCommand({ command: "task.move", task: task.ref, version: task.version, position }));
		const pick = (dir: string) =>
			document.querySelector<HTMLElement>(`[data-move="${task.ref}:${dir}"]:not(:disabled)`);
		(pick(delta < 0 ? "up" : "down") ?? pick(delta < 0 ? "down" : "up"))?.focus();
	}
	function keys(event: KeyboardEvent) {
		if (!event.altKey || (event.key !== "ArrowUp" && event.key !== "ArrowDown")) return;
		event.preventDefault();
		void move(event.key === "ArrowUp" ? -1 : 1);
	}
	async function save(event: FormEvent) {
		event.preventDefault();
		if (!goal.trim()) return;
		if (
			goal.trim() === task.goal ||
			(await run(() =>
				api.backlogCommand({ command: "task.update", task: task.ref, version: task.version, goal: goal.trim() }),
			))
		)
			setEditing(false);
	}
	const tooltip = (dir: string) => `Move ${task.ref} ${dir} (Alt+Arrow${dir === "up" ? "Up" : "Down"})`;
	return (
		// oxlint-disable-next-line jsx-a11y/no-static-element-interactions -- the row only listens for the Alt+Arrow shortcut that the buttons inside it also offer.
		<span className="task-tools" onKeyDown={keys}>
			<Select
				aria-label={`State of ${task.ref}`}
				value={task.state}
				disabled={pending}
				options={TASK_STATES.map((value) => ({ value, label: TASK_STATE_TITLES[value] }))}
				onChange={(event) =>
					void run(() =>
						api.backlogCommand({
							command: "task.update",
							task: task.ref,
							version: task.version,
							state: event.target.value as TaskState,
						}),
					)
				}
			/>
			<Button
				size="sm"
				aria-label={`Move ${task.ref} up`}
				title={tooltip("up")}
				data-move={`${task.ref}:up`}
				aria-keyshortcuts="Alt+ArrowUp"
				disabled={pending || movedPosition(siblings, task.ref, -1) === undefined}
				onClick={() => void move(-1)}
			>
				↑
			</Button>
			<Button
				size="sm"
				aria-label={`Move ${task.ref} down`}
				title={tooltip("down")}
				data-move={`${task.ref}:down`}
				aria-keyshortcuts="Alt+ArrowDown"
				disabled={pending || movedPosition(siblings, task.ref, 1) === undefined}
				onClick={() => void move(1)}
			>
				↓
			</Button>
			{editing ? (
				<form className="inline-add" onSubmit={save}>
					<input
						aria-label={`Goal of ${task.ref}`}
						value={goal}
						maxLength={500}
						onChange={(event) => setGoal(event.target.value)}
					/>
					<Button type="submit" size="sm" loading={pending}>
						Save
					</Button>
					<Button size="sm" onClick={() => setEditing(false)}>
						Cancel
					</Button>
				</form>
			) : (
				<Button
					size="sm"
					aria-label={`Edit ${task.ref}`}
					onClick={() => {
						setGoal(task.goal);
						setEditing(true);
					}}
				>
					Edit
				</Button>
			)}
			<Refusal error={error} />
		</span>
	);
}

function ItemTools({ item, index }: ComponentProps<HierarchyControls["ItemTools"]>) {
	const { api } = useLive();
	const { run, pending, error } = useEdit();
	const epics = epicsFor(index, item);
	const legacyParent = item.parentId && !epics.some((epic) => epic.ref === item.parentId) ? item.parentId : undefined;
	return (
		<div className="tree-tools">
			{isEpic(item) ? (
				<AddForm
					label={`Add item to ${item.ref}`}
					button="Add item"
					onAdd={(title) => api.mutate({ op: "add", title, parentId: item.ref, type: DEFAULT_ITEM_TYPE })}
				/>
			) : (
				<>
					<Select
						aria-label={`Epic of ${item.ref}`}
						value={item.parentId ?? ""}
						disabled={pending}
						options={[
							{ value: "", label: "No epic" },
							...(legacyParent ? [{ value: legacyParent, label: `${legacyParent} (not an epic)` }] : []),
							...epics.map((epic) => ({ value: epic.ref, label: `${epic.ref} · ${epic.title}` })),
						]}
						onChange={(event) =>
							void run(() =>
								api.backlogCommand({
									command: "item.reparent",
									id: item.ref,
									version: item.version,
									parentId: event.target.value || null,
								}),
							)
						}
					/>
					<AddForm
						label={`Add task to ${item.ref}`}
						button="Add task"
						onAdd={(goal) => api.backlogCommand({ command: "task.add", goal, item: item.ref })}
					/>
				</>
			)}
			<Refusal error={error} />
		</div>
	);
}

/** The item's tasks in its detail sheet: the list with its controls and an inline add. */
function ItemTasks({ item }: { item: SnapshotItem }) {
	const { api } = useLive();
	const tasks = item.tasks ?? [];
	return (
		<Section title="Tasks" count={tasks.length}>
			{tasks.length ? (
				<TaskList tasks={tasks} TaskTools={TaskTools} label={`Tasks of ${item.ref}`} />
			) : (
				<p className="muted">No tasks yet.</p>
			)}
			<AddForm
				label={`Add a task to ${item.ref}`}
				button="Add task"
				onAdd={(goal) => api.backlogCommand({ command: "task.add", goal, item: item.ref })}
			/>
		</Section>
	);
}

/** A board card's state, changed in place. Closing needs a result, so it opens the editor instead. */
function StateControl({ item }: { item: SnapshotItem }) {
	const { api, backlog } = useLive();
	const { run, pending, error } = useEdit();
	const states: readonly State[] = backlog.getState().snapshot.states;
	return (
		<div className="state-control">
			<Select
				aria-label={`State of ${item.ref}`}
				value={item.state}
				disabled={pending}
				options={states.map((value) => ({ value, label: STATE_TITLES[value] }))}
				onChange={(event) => {
					const state = event.target.value as State;
					if (state === "done") navigate(`#${item.ref}/edit`);
					else
						void run(() => api.backlogCommand({ command: "item.state", id: item.ref, version: item.version, state }));
				}}
			/>
			<Refusal error={error} />
		</div>
	);
}

/** Promote a session task to an item, or hand it to an existing item. */
function SessionTaskTools({ task, index }: ComponentProps<HierarchyControls["SessionTaskTools"]>) {
	const { api } = useLive();
	const { run, pending, error } = useEdit();
	const open = task.state === "todo" || task.state === "ongoing";
	const items = index.items.filter((item) => !isEpic(item) && item.state !== "done");
	return (
		<span className="task-tools">
			{open && (
				<Button
					size="sm"
					aria-label={`Promote ${task.ref} to an item`}
					loading={pending}
					onClick={() =>
						void run(() => api.backlogCommand({ command: "task.promote", task: task.ref, version: task.version }))
					}
				>
					Promote to item
				</Button>
			)}
			<Select
				aria-label={`Move ${task.ref} under an item`}
				value=""
				disabled={pending || !items.length}
				options={[
					{ value: "", label: "Move under item…" },
					...items.map((item) => ({ value: item.ref, label: `${item.ref} · ${item.title}` })),
				]}
				onChange={(event) =>
					event.target.value &&
					void run(() =>
						api.backlogCommand({
							command: "task.reparent",
							task: task.ref,
							version: task.version,
							item: event.target.value,
						}),
					)
				}
			/>
			<Refusal error={error} />
		</span>
	);
}

export const hierarchyControls: HierarchyControls = { ItemTools, TaskTools, StateControl, ItemTasks, SessionTaskTools };

import type { BacklogTask } from "@octocodeai/octocode-contracts/backlogs";
import type { ReactNode } from "react";
import type { HierarchyControls } from "../extension.ts";
import type { BacklogIndex } from "../model/backlog.ts";
import { rollup, rollupText, TASK_STATE_TITLES, sessionGroups, taskTallyText } from "../model/hierarchy.ts";
import { cx, Section } from "../ui/primitives.tsx";

/** One task: its state mark, reference, goal and reason; `children` holds the edit controls on a live page. */
function TaskRow({ task, children }: { task: BacklogTask; children?: ReactNode }) {
	return (
		<span className={cx("task-line", `task-${task.state}`)}>
			<span className="task-state" title={TASK_STATE_TITLES[task.state]}>
				<span aria-hidden="true" className="task-mark" />
				<span className="visually-hidden">{TASK_STATE_TITLES[task.state]}: </span>
			</span>
			<span className="ref">{task.ref}</span>
			<span className="task-goal">{task.goal}</span>
			{task.reason && <span className="muted task-reason"> — {task.reason}</span>}
			{task.result && <span className="muted task-result">Result: {task.result}</span>}
			{task.assignee && task.state === "ongoing" && <span className="muted"> · {task.assignee}</span>}
			{children}
		</span>
	);
}

/** A task list with the edit controls the page offers; a read-only page shows the same rows without them. */
export function TaskList({
	tasks,
	TaskTools,
	label,
}: {
	tasks: readonly BacklogTask[];
	TaskTools?: HierarchyControls["TaskTools"];
	label: string;
}) {
	return (
		<ul className="task-list" aria-label={label}>
			{tasks.map((task) => (
				<li key={task.ref}>
					<TaskRow task={task}>{TaskTools ? <TaskTools task={task} siblings={tasks} /> : null}</TaskRow>
				</li>
			))}
		</ul>
	);
}

/** An epic's derived state and roll-up counts as one line; nothing for an epic that holds nothing yet. */
export function RollupLine({ index, epic }: { index: BacklogIndex; epic: Parameters<typeof rollup>[1] }) {
	const text = rollupText(rollup(index, epic));
	return text ? <span className="count rollup">{text}</span> : null;
}

/** Tasks that belong to a session and no item, grouped by session; the page offers promotion on a live board. */
export function SessionTasks({
	index,
	controls,
	sessionLabel,
}: {
	index: BacklogIndex;
	controls?: HierarchyControls;
	sessionLabel?: (id: string) => string;
}) {
	const groups = sessionGroups(index.sessionTasks);
	if (!groups.length) return null;
	return (
		<div className="session-tasks">
			<Section title="Session tasks" count={index.sessionTasks.length}>
				<p className="muted">Steps belonging to a session. They stay with it until you promote one to an item.</p>
				{groups.map((group) => (
					<div key={group.session} className="session-group">
						<h4>Session {sessionLabel?.(group.session) ?? group.session}</h4>
						<p className="muted">{taskTallyText(group.tasks)}</p>
						<ul className="task-list" aria-label={`Tasks of session ${group.session}`}>
							{group.tasks.map((task) => (
								<li key={task.ref}>
									<TaskRow task={task}>
										{controls ? <controls.SessionTaskTools task={task} index={index} /> : null}
									</TaskRow>
								</li>
							))}
						</ul>
					</div>
				))}
			</Section>
		</div>
	);
}

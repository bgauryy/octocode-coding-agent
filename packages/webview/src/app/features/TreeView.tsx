import { useMemo, useState } from "react";
import type { ViewProps } from "../extension.ts";
import { type BacklogIndex, buildTree, type TreeNode } from "../model/backlog.ts";
import { isEpic, taskTallyText } from "../model/hierarchy.ts";
import { TreeIcon } from "../ui/icons.tsx";
import { Button, EmptyState } from "../ui/primitives.tsx";
import { ItemLine, ShowClosedToggle, Toolbar, visibleIndex } from "./shared.tsx";
import { RollupLine, SessionTasks, TaskList } from "./Tasks.tsx";

type Expansion = "default" | "all" | "none";
type Controls = ViewProps["controls"];

/**
 * Epics, their items and each item's tasks. On an editable live page every row also carries its edit controls
 * (`controls`); a read-only page and the static export show the same structure without them.
 * Expand/collapse all remounts the disclosures with a new key, so each one stays natively toggleable afterwards.
 */
export function TreeView({ index: full, params, setParams, controls }: ViewProps) {
	const index = useMemo(() => visibleIndex(full, params), [full, params]);
	const tree = useMemo(() => buildTree(index), [index]);
	const [expansion, setExpansion] = useState<{ mode: Expansion; generation: number }>({
		mode: "default",
		generation: 0,
	});
	const set = (mode: Expansion) => setExpansion((current) => ({ mode, generation: current.generation + 1 }));
	const branch = (node: TreeNode, depth: number) => (
		<TreeBranch key={node.item.ref} node={node} depth={depth} mode={expansion.mode} index={index} controls={controls} />
	);

	return (
		<div className="view tree-view">
			<Toolbar label="Tree controls">
				<Button size="sm" onClick={() => set("all")}>
					Expand all
				</Button>
				<Button size="sm" onClick={() => set("none")}>
					Collapse all
				</Button>
				<ShowClosedToggle index={full} params={params} setParams={setParams} />
			</Toolbar>
			<div className="tree" key={expansion.generation}>
				{tree.roots.length ? (
					<ul>{tree.roots.map((node) => branch(node, 0))}</ul>
				) : (
					<EmptyState icon={<TreeIcon size={20} />} title="No epics or groups yet">
						Create an item of type epic and put related items under it to group work here.
					</EmptyState>
				)}
				{tree.alone.length > 0 && (
					<details className="fold tree-alone" open={expansion.mode === "all"}>
						<summary>Items without an epic ({tree.alone.length})</summary>
						<ul>{tree.alone.map((item) => branch({ item, children: [] }, 2))}</ul>
					</details>
				)}
			</div>
			<SessionTasks index={index} controls={controls} />
		</div>
	);
}

function TreeBranch({
	node,
	depth,
	mode,
	index,
	controls,
}: {
	node: TreeNode;
	depth: number;
	mode: Expansion;
	index: BacklogIndex;
	controls: Controls;
}) {
	const { item, children } = node;
	const tasks = item.tasks ?? [];
	if (!children.length && !tasks.length && !controls)
		return (
			<li className="leaf">
				<ItemLine item={item} />
			</li>
		);
	const tally = taskTallyText(tasks);
	return (
		<li>
			<details open={mode === "all" || (mode === "default" && depth < 2)}>
				<summary>
					<ItemLine item={item}>
						{children.length > 0 && !isEpic(item) && <span className="count">{children.length} children</span>}
						{isEpic(item) && <RollupLine index={index} epic={item} />}
						{tally && <span className="count">{tally}</span>}
					</ItemLine>
				</summary>
				{controls && <controls.ItemTools item={item} index={index} />}
				{tasks.length > 0 && <TaskList tasks={tasks} TaskTools={controls?.TaskTools} label={`Tasks of ${item.ref}`} />}
				{children.length > 0 && (
					<ul>
						{children.map((child) => (
							<TreeBranch
								key={child.item.ref}
								node={child}
								depth={depth + 1}
								mode={mode}
								index={index}
								controls={controls}
							/>
						))}
					</ul>
				)}
			</details>
		</li>
	);
}

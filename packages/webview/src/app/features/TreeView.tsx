import { useMemo, useState } from "react";
import type { ViewProps } from "../extension.ts";
import { buildTree, type TreeNode } from "../model/backlog.ts";
import { TreeIcon } from "../ui/icons.tsx";
import { Button, EmptyState } from "../ui/primitives.tsx";
import { ItemLine, Toolbar } from "./shared.tsx";

type Expansion = "default" | "all" | "none";

/** Expand/collapse all remounts the disclosures with a new key, so each one stays natively toggleable afterwards. */
export function TreeView({ index }: ViewProps) {
	const tree = useMemo(() => buildTree(index), [index]);
	const [expansion, setExpansion] = useState<{ mode: Expansion; generation: number }>({
		mode: "default",
		generation: 0,
	});
	const set = (mode: Expansion) => setExpansion((current) => ({ mode, generation: current.generation + 1 }));

	return (
		<div className="view tree-view">
			<Toolbar label="Tree controls">
				<Button size="sm" onClick={() => set("all")}>
					Expand all
				</Button>
				<Button size="sm" onClick={() => set("none")}>
					Collapse all
				</Button>
			</Toolbar>
			<div className="tree" key={expansion.generation}>
				{tree.roots.length ? (
					<ul>
						{tree.roots.map((node) => (
							<TreeBranch key={node.item.ref} node={node} depth={0} mode={expansion.mode} />
						))}
					</ul>
				) : (
					<EmptyState icon={<TreeIcon size={20} />} title="No derived items yet">
						Items created from another item, or added as its children, appear here as a tree.
					</EmptyState>
				)}
				{tree.alone.length > 0 && (
					<details className="fold tree-alone">
						<summary>Items without a link ({tree.alone.length})</summary>
						<ul>
							{tree.alone.map((it) => (
								<li key={it.ref} className="leaf">
									<ItemLine item={it} />
								</li>
							))}
						</ul>
					</details>
				)}
			</div>
		</div>
	);
}

function TreeBranch({ node, depth, mode }: { node: TreeNode; depth: number; mode: Expansion }) {
	if (!node.children.length)
		return (
			<li className="leaf">
				<ItemLine item={node.item} />
			</li>
		);
	return (
		<li>
			<details open={mode === "all" || (mode === "default" && depth < 2)}>
				{/* oxlint-disable-next-line jsx-a11y/control-has-associated-label -- named by ItemLine's ref and title text, which the rule cannot see through a component. */}
				<summary>
					<ItemLine item={node.item}>
						<span className="count">{node.children.length} derived</span>
					</ItemLine>
				</summary>
				<ul>
					{node.children.map((child) => (
						<TreeBranch key={child.item.ref} node={child} depth={depth + 1} mode={mode} />
					))}
				</ul>
			</details>
		</li>
	);
}

import type { SessionTreeNode } from "../../../../core/session-manager.ts";

/** Gutter info: position (displayIndent where connector was) and whether to show │ */
export interface GutterInfo {
	position: number; // displayIndent level where the connector was shown
	show: boolean; // true = show │, false = show spaces
}

/** Flattened tree node for navigation */
export interface FlatNode {
	node: SessionTreeNode;
	/** Indentation level (each level = 3 chars) */
	indent: number;
	/** Whether to show connector (├─ or └─) - true if parent has multiple children */
	showConnector: boolean;
	/** If showConnector, true = last sibling (└─), false = not last (├─) */
	isLast: boolean;
	/** Gutter info for each ancestor branch point */
	gutters: GutterInfo[];
	/** True if this node is a root under a virtual branching root (multiple roots) */
	isVirtualRootChild: boolean;
}

/** Filter mode for tree display */
export type FilterMode = "default" | "no-tools" | "user-only" | "labeled-only" | "all";

/** Tool call info for lookup */
export interface ToolCallInfo {
	name: string;
	arguments: Record<string, unknown>;
}

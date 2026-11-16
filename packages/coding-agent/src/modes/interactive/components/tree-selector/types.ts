import type { SessionTreeNode } from "../../../../core/session-manager.ts";

/** Gutter info: position (displayIndent where connector was) and whether to show │ */
export interface GutterInfo {
	position: number; // displayIndent level where the connector was shown
	show: boolean; // true = show │, false = show spaces
}

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

export type FilterMode = "default" | "no-tools" | "user-only" | "labeled-only" | "all";

/** The status-line suffix that names the active filter. */
export const FILTER_LABELS: Record<FilterMode, string> = {
	default: "",
	"no-tools": " [no-tools]",
	"user-only": " [user]",
	"labeled-only": " [labeled]",
	all: " [all]",
};

export interface ToolCallInfo {
	name: string;
	arguments: Record<string, unknown>;
}

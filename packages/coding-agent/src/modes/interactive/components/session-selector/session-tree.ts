import type { SessionInfo } from "../../../../core/session-manager.ts";
import { canonicalizePath } from "../../../../../../common/src/paths.ts";

interface SessionTreeNode {
	session: SessionInfo;
	children: SessionTreeNode[];
	latestActivity: number;
}

/** Flattened node for display with tree structure info */
export interface FlatSessionNode {
	session: SessionInfo;
	depth: number;
	isLast: boolean;
	/** For each ancestor level, whether there are more siblings after it */
	ancestorContinues: boolean[];
}

/**
 * Build a tree structure from sessions based on parentSessionPath.
 * Returns root nodes sorted by modified date (descending).
 */
export function buildSessionTree(sessions: SessionInfo[]): SessionTreeNode[] {
	const byPath = new Map<string, SessionTreeNode>();

	for (const session of sessions) {
		const sessionPath = canonicalizePath(session.path);
		byPath.set(sessionPath, { session, children: [], latestActivity: session.modified.getTime() });
	}

	const roots: SessionTreeNode[] = [];

	for (const session of sessions) {
		const sessionPath = canonicalizePath(session.path);
		const node = byPath.get(sessionPath)!;
		const parentPath = session.parentSessionPath && canonicalizePath(session.parentSessionPath);

		if (parentPath && byPath.has(parentPath)) {
			byPath.get(parentPath)!.children.push(node);
		} else {
			roots.push(node);
		}
	}

	// Post-order through an explicit stack: long fork chains must not consume the call stack.
	const ordered: SessionTreeNode[] = [];
	const pending = [...roots];
	const seen = new Set<SessionTreeNode>();
	while (pending.length > 0) {
		const node = pending.pop()!;
		if (seen.has(node)) continue;
		seen.add(node);
		ordered.push(node);
		for (const child of node.children) pending.push(child);
	}
	for (let i = ordered.length - 1; i >= 0; i--) {
		const node = ordered[i];
		for (const child of node.children) node.latestActivity = Math.max(node.latestActivity, child.latestActivity);
		node.children.sort((a, b) => b.latestActivity - a.latestActivity);
	}
	roots.sort((a, b) => b.latestActivity - a.latestActivity);

	return roots;
}

/**
 * Flatten tree into display list with tree structure metadata.
 */
export function flattenSessionTree(roots: SessionTreeNode[]): FlatSessionNode[] {
	const result: FlatSessionNode[] = [];

	const pending = roots
		.map((node, index) => ({ node, depth: 0, ancestorContinues: [] as boolean[], isLast: index === roots.length - 1 }))
		.reverse();
	const seen = new Set<SessionTreeNode>();
	while (pending.length > 0) {
		const { node, depth, ancestorContinues, isLast } = pending.pop()!;
		if (seen.has(node)) continue;
		seen.add(node);
		result.push({ session: node.session, depth, isLast, ancestorContinues });
		for (let i = node.children.length - 1; i >= 0; i--) {
			pending.push({
				node: node.children[i],
				depth: depth + 1,
				ancestorContinues: [...ancestorContinues, depth > 0 ? !isLast : false],
				isLast: i === node.children.length - 1,
			});
		}
	}

	return result;
}

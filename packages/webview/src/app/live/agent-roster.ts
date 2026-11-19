import type { Member, Traffic } from "@octocodeai/octocode-contracts";

export interface AgentNode {
	agent: Member;
	/** The host marked it `waiting` for the user, messages wait on its answer, or a message to it, not a child's request to its parent, is still awaiting reply. */
	attention: boolean;
	/** The newest message this agent sent or received. */
	last: Traffic | undefined;
	children: AgentNode[];
}

const PREVIEW = 90;

/** The newest message involving the agent; traffic arrives oldest first. */
export function lastMessage(id: string, traffic: readonly Traffic[]): Traffic | undefined {
	for (let index = traffic.length - 1; index >= 0; index--) {
		const message = traffic[index];
		if (message.from === id || message.to.includes(id)) return message;
	}
	return undefined;
}

/** `↳ to main · awaiting reply · “text…”`, or `from` when the agent received it. */
export function describeLast(id: string, message: Traffic): string {
	const text = message.text.replace(/\s+/g, " ").trim();
	const clipped = text.length > PREVIEW ? `${text.slice(0, PREVIEW - 1)}…` : text;
	const direction = message.from === id ? `to ${message.to.join(", ")}` : `from ${message.from}`;
	return `↳ ${direction} · ${message.state} · “${clipped}”`;
}

const rank = (node: AgentNode) => (node.attention ? 0 : node.agent.status === "working" ? 1 : 2);
const order = (a: AgentNode, b: AgentNode) => rank(a) - rank(b) || a.agent.id.localeCompare(b.agent.id);

/**
 * The agents as a forest by `parentId`, those that need attention first, then working, then idle. An agent whose parent
 * is not listed is a root, and members of a parent cycle are rooted at the first one met so none disappears.
 */
export function buildRoster(agents: readonly Member[], traffic: readonly Traffic[]): AgentNode[] {
	const parentOf = new Map(agents.map((agent) => [agent.id, agent.parentId]));
	// A child asking its parent waits on the parent, not the user: the terminal panel labels it "asks parent".
	const fromChild = (message: Traffic, recipient: string) => parentOf.get(message.from) === recipient;
	const waiting = new Map<string, number>();
	const fromChildren = new Map<string, number>();
	for (const message of traffic) {
		if (message.state !== "awaiting reply") continue;
		for (const id of message.to) {
			const counts = fromChild(message, id) ? fromChildren : waiting;
			counts.set(id, (counts.get(id) ?? 0) + 1);
		}
	}
	const nodes = new Map<string, AgentNode>(
		agents.map((agent) => [
			agent.id,
			{
				agent,
				attention:
					Boolean(agent.waiting) || (agent.pending ?? 0) > (fromChildren.get(agent.id) ?? 0) || waiting.has(agent.id),
				last: lastMessage(agent.id, traffic),
				children: [],
			},
		]),
	);
	const roots: AgentNode[] = [];
	for (const node of nodes.values()) {
		const parent = nodes.get(node.agent.parentId ?? "");
		if (parent && parent !== node) parent.children.push(node);
		else roots.push(node);
	}
	// Members of a parent cycle are reachable from no root: root the first of each in list order.
	const reached = new Set<string>();
	const visit = (node: AgentNode) => {
		if (reached.has(node.agent.id)) return;
		reached.add(node.agent.id);
		node.children.forEach(visit);
	};
	roots.forEach(visit);
	for (const node of nodes.values()) {
		if (reached.has(node.agent.id)) continue;
		const parent = nodes.get(node.agent.parentId ?? "");
		parent?.children.splice(parent.children.indexOf(node), 1);
		roots.push(node);
		visit(node);
	}
	const sortTree = (list: AgentNode[]) => {
		list.sort(order);
		for (const node of list) sortTree(node.children);
	};
	sortTree(roots);
	return roots;
}

import type { GraphEdge, GraphNode, NodeId, WorkGraph } from "./model.ts";

const CLOSED = new Set(["done", "closed"]);

const nodesOf = (graph: WorkGraph, edges: readonly GraphEdge[], pick: (edge: GraphEdge) => NodeId): GraphNode[] =>
	edges.flatMap((edge) => graph.node(pick(edge)) ?? []);

const unique = <T>(list: readonly T[]): T[] => [...new Set(list)];

/** The agents that hold or serve an item. */
function agentsOf(graph: WorkGraph, item: NodeId): GraphNode[] {
	const edges = [...graph.into(item, "holds"), ...graph.into(item, "serves")];
	return unique(nodesOf(graph, edges, (edge) => edge.from).filter((node) => node.kind === "agent"));
}

/** The jobs serving an item or owned by its agents. */
function jobsOf(graph: WorkGraph, item: NodeId, agents: readonly GraphNode[]): GraphNode[] {
	const serving = nodesOf(graph, graph.into(item, "serves"), (edge) => edge.from).filter((node) => node.kind === "job");
	const owned = agents.flatMap((agent) => nodesOf(graph, graph.out(agent.id, "owns"), (edge) => edge.to));
	return unique([...serving, ...owned]);
}

/** The resources a node holds. */
const heldBy = (graph: WorkGraph, node: NodeId): GraphNode[] =>
	nodesOf(graph, graph.out(node, "holds"), (edge) => edge.to).filter((each) => each.kind === "resource");

/** Every node of one item's tree, the item first. */
function itemTree(graph: WorkGraph, item: NodeId): GraphNode[] {
	const self = graph.node(item);
	if (!self) return [];
	const steps = nodesOf(graph, graph.into(item, "parent"), (edge) => edge.from).filter((node) => node.kind === "step");
	const agents = agentsOf(graph, item);
	const jobs = jobsOf(graph, item, agents);
	const serving = nodesOf(graph, graph.into(item, "serves"), (edge) => edge.from).filter(
		(node) => node.kind === "resource",
	);
	const resources = unique([...[...agents, ...jobs].flatMap((node) => heldBy(graph, node.id)), ...serving]);
	const waits = nodesOf(graph, graph.into(item, "waits"), (edge) => edge.from);
	const needs = nodesOf(graph, graph.into(item, "blocks"), (edge) => edge.from);
	const deps = nodesOf(graph, graph.out(item, "depends"), (edge) => edge.to);
	return unique([self, ...steps, ...agents, ...jobs, ...resources, ...waits, ...needs, ...deps]);
}

/** The open items to print, or one named item (shown whatever its state). */
function roots(graph: WorkGraph, only?: string): GraphNode[] {
	if (only !== undefined) {
		const found = graph.node(`item:${only}`);
		if (!found || found.state === "missing") throw new Error(`No backlog item ${only}.`);
		return [found];
	}
	return graph.nodes.filter(
		(node) => node.kind === "item" && !CLOSED.has(node.state) && node.state !== "missing" && hasWork(graph, node.id),
	);
}

/** An item shows in the tree when something runs for it or it waits on something. */
const hasWork = (graph: WorkGraph, item: NodeId): boolean =>
	graph.into(item, "holds").length + graph.into(item, "serves").length + graph.into(item, "waits").length > 0 ||
	graph.into(item, "blocks").length > 0 ||
	graph.out(item, "depends").some((edge) => !CLOSED.has(graph.node(edge.to)?.state ?? "missing"));

const line = (depth: number, text: string) => `${"  ".repeat(depth)}${text}`;

function itemLines(graph: WorkGraph, item: GraphNode): string[] {
	const lines = [`${item.label} · ${item.state}`];
	const deps = graph.out(item.id, "depends").flatMap((edge) => graph.node(edge.to) ?? []);
	const open = deps.filter((dep) => !CLOSED.has(dep.state));
	if (open.length) lines.push(line(1, `after ${open.map((dep) => `${dep.ref} (${dep.state})`).join(", ")}`));
	for (const step of nodesOf(graph, graph.into(item.id, "parent"), (edge) => edge.from).filter(
		(n) => n.kind === "step",
	))
		lines.push(line(1, `step ${step.label} · ${step.state}`));
	const agents = agentsOf(graph, item.id);
	const placed = new Set<NodeId>();
	for (const agent of agents) {
		lines.push(line(1, `agent ${agent.ref} · ${agent.state}`));
		for (const job of nodesOf(graph, graph.out(agent.id, "owns"), (edge) => edge.to)) {
			placed.add(job.id);
			lines.push(...jobLines(graph, job, 2));
		}
		for (const held of heldBy(graph, agent.id)) {
			if (!graph.into(held.id, "holds").some((edge) => placed.has(edge.from)))
				lines.push(line(2, `holds ${held.ref}: ${held.label}`));
		}
	}
	for (const job of jobsOf(graph, item.id, []).filter((each) => !placed.has(each.id)))
		lines.push(...jobLines(graph, job, 1));
	for (const wait of nodesOf(graph, graph.into(item.id, "waits"), (edge) => edge.from))
		lines.push(line(1, `wait ${wait.ref} · ${wait.label}`));
	for (const need of nodesOf(graph, graph.into(item.id, "blocks"), (edge) => edge.from))
		lines.push(line(1, `blocked by ${need.kind} ${need.ref}`));
	return lines;
}

function jobLines(graph: WorkGraph, job: GraphNode, depth: number): string[] {
	const held = heldBy(graph, job.id)
		.map((resource) => ` · holds ${resource.ref}`)
		.join("");
	return [line(depth, `job ${job.ref} · ${job.label}${held}`)];
}

/** Work that serves no item: a job, an agent or a lock nothing names. */
function unattached(graph: WorkGraph): string[] {
	const loose = graph.nodes.filter(
		(node) =>
			(node.kind === "job" || node.kind === "agent" || node.kind === "resource") &&
			!["serves", "holds"].some((kind) => graph.out(node.id, kind as "serves").some((e) => e.to.startsWith("item:"))) &&
			!graph.into(node.id, "owns").length &&
			!(
				node.kind === "resource" &&
				graph.into(node.id).some((e) => e.kind === "holds" && graph.node(e.from)?.kind === "job")
			),
	);
	return loose.length ? ["No item:", ...loose.map((node) => line(1, `${node.kind} ${node.ref} · ${node.label}`))] : [];
}

/** The tree: item → steps → agents → jobs → resources, with waits and what blocks. */
export function graphText(graph: WorkGraph, only?: string): string {
	const items = roots(graph, only);
	const blocks = items.map((item) => itemLines(graph, item).join("\n"));
	const rest = only === undefined ? unattached(graph) : [];
	const body = [...blocks, ...(rest.length ? [rest.join("\n")] : [])];
	return body.length ? body.join("\n\n") : "Nothing runs and nothing waits.";
}

/** The nodes and edges as JSON, each node with its source row; one item's tree when `only` names it. */
export function graphJson(
	graph: WorkGraph,
	only?: string,
): { nodes: readonly GraphNode[]; edges: readonly GraphEdge[] } {
	if (only === undefined) return { nodes: graph.nodes, edges: graph.edges };
	const item = roots(graph, only)[0];
	const nodes = itemTree(graph, item?.id ?? (`item:${only}` as NodeId));
	const ids = new Set(nodes.map((node) => node.id));
	return { nodes, edges: graph.edges.filter((edge) => ids.has(edge.from) && ids.has(edge.to)) };
}

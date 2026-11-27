import path from "node:path";
import { type AgentDb, workspaces } from "../../../db/src/api.ts";
import { BacklogStore } from "../../src/octocode/backlog/store.ts";

/** Supply catalog parents for store tests that inject a workspace ID instead of opening a checkout. */
export function registerFixtureWorkspace(agent: AgentDb, id: string): string {
	const root = path.basename(id) === ".git" ? path.dirname(id) : id;
	if (workspaces.byId(agent.db, id)) return id;
	workspaces.register(agent.db, { id, root, name: path.basename(root), binding: id });
	return id;
}

export function fixtureBacklog(agent: () => AgentDb, workspaceId: string, now?: () => number): BacklogStore {
	return new BacklogStore(agent, registerFixtureWorkspace(agent(), workspaceId), now);
}

/**
 * The tool that takes `op`: `backlogPlan` plans and triages (add, edit, list, stat), `backlog` works one item (get, claim,
 * note, done, close). The two share no operation name, so a test names the operation and this picks the tool.
 */
export const backlogToolName = (op: unknown): "backlog" | "backlogPlan" =>
	op === "add" || op === "edit" || op === "list" || op === "stat" ? "backlogPlan" : "backlog";

type EntryField = { description?: string; type?: string; enum?: string[]; anyOf?: unknown[]; items?: unknown };

/** The typed fields of one `items` entry, as `backlogPlan` declares them: the fields `add` and `edit` write. */
export const planEntryFields = (plan: { parameters: unknown }): Record<string, EntryField> =>
	(plan.parameters as { properties: { items: { items: { properties: Record<string, EntryField> } } } }).properties.items
		.items.properties;

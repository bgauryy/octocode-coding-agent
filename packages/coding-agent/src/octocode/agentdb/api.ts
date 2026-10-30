/**
 * The agent database API: the one door to it. Every SQL statement against the `octocode.db` schema lives in `queries/`, one
 * module per table family, as a named function that takes the open `DatabaseSync` (`AgentDb.db`) and returns plain
 * values or rows already mapped. Features import the namespace they need from here and never call `prepare`/`exec`
 * themselves; `scripts/check-db-boundary.mjs` fails when they do. Transactions stay with `AgentDb.transaction`.
 */
export * as agents from "./queries/agents.ts";
export * as deliveries from "./queries/deliveries.ts";
export * as leases from "./queries/leases.ts";
export * as edits from "./queries/edits.ts";
export * as backlog from "./queries/backlog.ts";
export * as memories from "./queries/memories.ts";
export * as sessions from "./queries/sessions.ts";
export * as commands from "./queries/commands.ts";
export * as meta from "./queries/meta.ts";
export type { Db } from "./db.ts";

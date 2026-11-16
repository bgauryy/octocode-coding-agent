import type { DatabaseSync } from "node:sqlite";
import type { AgentRoute } from "@octocodeai/octocode-contracts/config";
import { AGENT_RUN_ROUTE_COLUMN } from "../schema-sql.ts";
import { inTransaction } from "./transaction.ts";

const routeEnsured = new WeakSet<DatabaseSync>();

/** The stored routes (`AgentRoute`); a local list, since the writer worker runs this module without the contracts build. */
const ROUTES: readonly AgentRoute[] = ["config", "subscription", "remote", "external"];

/** Reads a stored route; an unknown or missing value (a row an older build wrote) is undefined. */
export function parseRoute(value: unknown): AgentRoute | undefined {
	return ROUTES.find((route) => route === value);
}

/** Add the nullable `route` column to a file created before it existed; cached only after our own transaction committed. */
export function ensureRoute(db: DatabaseSync): void {
	if (routeEnsured.has(db)) return;
	const nested = db.isTransaction;
	const present = db.prepare("SELECT 1 FROM pragma_table_info('agent_runs') WHERE name = 'route'");
	if (!present.get())
		inTransaction(db, () => {
			if (!present.get()) db.exec(`ALTER TABLE agent_runs ADD COLUMN ${AGENT_RUN_ROUTE_COLUMN}`);
		});
	if (!nested) routeEnsured.add(db);
}

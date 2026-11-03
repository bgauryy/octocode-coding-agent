import type { DatabaseSync } from "node:sqlite";
import { num, type Row } from "../rows.ts";

/**
 * One change made from the web configuration page. Only kinds and codes are stored: `target` is a provider id,
 * `beforeKind` and `afterKind` name a credential source (`keychain`, `auth-json`, `none`...), and `errorCode` is a
 * short fixed code. A key, a `!` reference or any text read from `auth.json` never reaches a row.
 */
export interface ConfigAuditEntry {
	at: number;
	/** Who acted, such as `web:<daemon instance>`. */
	actor: string;
	/** `credential.set` or `credential.clear`. */
	action: string;
	target: string;
	scope?: string;
	beforeKind?: string;
	afterKind?: string;
	outcome: "ok" | "refused" | "failed";
	errorCode?: string;
}

export function record(db: DatabaseSync, entry: ConfigAuditEntry): void {
	db.prepare(
		`INSERT INTO config_audits(at, actor, action, target, scope, before_kind, after_kind, outcome, error_code)
		 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
	).run(
		entry.at,
		entry.actor,
		entry.action,
		entry.target,
		entry.scope ?? "",
		entry.beforeKind ?? "",
		entry.afterKind ?? "",
		entry.outcome,
		entry.errorCode ?? "",
	);
}

/** The newest `limit` rows, oldest first. */
export function recent(db: DatabaseSync, limit: number): ConfigAuditEntry[] {
	const rows = db
		.prepare("SELECT * FROM (SELECT * FROM config_audits ORDER BY id DESC LIMIT ?) ORDER BY id")
		.all(limit) as Row[];
	return rows.map((row) => ({
		at: num(row.at),
		actor: String(row.actor),
		action: String(row.action),
		target: String(row.target),
		scope: String(row.scope),
		beforeKind: String(row.before_kind),
		afterKind: String(row.after_kind),
		outcome: row.outcome as ConfigAuditEntry["outcome"],
		errorCode: String(row.error_code),
	}));
}

import type { AgentDb } from "../agentdb/db.ts";
import { Value } from "typebox/value";
import { WorkspaceCommandSchema } from "@octocodeai/octocode-contacts/protocol";
import { storedSecret } from "../shared/sanitize.ts";
import type { WorkspaceCommand, WorkspaceReceipt } from "@octocodeai/octocode-contacts/workspace";

type Row = {
	id: string;
	backlog_id: string | null;
	action: WorkspaceReceipt["action"];
	input: string;
	status: WorkspaceReceipt["status"];
	at: number;
	message: string;
};
const receipt = (row: Row): WorkspaceReceipt => ({
	id: row.id,
	...(row.backlog_id ? { backlogId: row.backlog_id } : {}),
	action: row.action,
	status: row.status,
	at: row.at,
	message: row.message,
});

/** Durable delivery receipts prevent reconnects or double clicks from launching the same request twice. */
export class WorkspaceCommands {
	private readonly db: AgentDb;
	private readonly repo: string;
	private readonly session: string;
	constructor(db: AgentDb, repo: string, session: string) {
		this.db = db;
		this.repo = repo;
		this.session = session;
	}
	list(): WorkspaceReceipt[] {
		return (
			this.db.db
				.prepare(
					"SELECT * FROM workspace_commands WHERE repo_key = ? AND session_id = ? AND action IN ('work', 'delegate', 'message', 'stop') ORDER BY at DESC LIMIT 100",
				)
				.all(this.repo, this.session) as unknown as Row[]
		)
			.reverse()
			.map(receipt);
	}
	begin(command: WorkspaceCommand): { fresh: boolean; receipt: WorkspaceReceipt } {
		if (!Value.Check(WorkspaceCommandSchema, command)) throw new Error("Invalid workspace command");
		if (storedSecret({ command: JSON.stringify(command) })) throw new Error("Remove credentials from this command.");
		const input = JSON.stringify({
			action: command.action,
			backlogId: command.backlogId,
			version: command.version,
			to: command.to,
			text: command.text,
		});
		return this.db.withActor({ id: "user", kind: "human" }, () =>
			this.db.transaction(() => {
				const existing = this.db.db
					.prepare("SELECT * FROM workspace_commands WHERE repo_key = ? AND session_id = ? AND id = ?")
					.get(this.repo, this.session, command.id) as Row | undefined;
				if (existing) {
					if (existing.input !== input) throw new Error("This request ID was already used for different input.");
					return { fresh: false, receipt: receipt(existing) };
				}
				const at = Date.now();
				const message = "Request recorded; delivery pending. Do not resend if the session disconnects.";
				this.db.db
					.prepare(
						"INSERT INTO workspace_commands(id, session_id, repo_key, backlog_id, action, input, status, at, message) VALUES (?, ?, ?, ?, ?, ?, 'pending', ?, ?)",
					)
					.run(command.id, this.session, this.repo, command.backlogId ?? null, command.action, input, at, message);
				return {
					fresh: true,
					receipt: {
						id: command.id,
						backlogId: command.backlogId,
						action: command.action,
						status: "pending",
						at,
						message,
					},
				};
			}),
		);
	}
	finish(id: string, status: "accepted" | "failed", message: string): WorkspaceReceipt {
		return this.db.withActor({ id: "user", kind: "human" }, () =>
			this.db.transaction(() => {
				this.db.db
					.prepare(
						"UPDATE workspace_commands SET status = ?, message = ? WHERE repo_key = ? AND session_id = ? AND id = ?",
					)
					.run(status, message, this.repo, this.session, id);
				return receipt(
					this.db.db
						.prepare("SELECT * FROM workspace_commands WHERE repo_key = ? AND session_id = ? AND id = ?")
						.get(this.repo, this.session, id) as Row,
				);
			}),
		);
	}
}

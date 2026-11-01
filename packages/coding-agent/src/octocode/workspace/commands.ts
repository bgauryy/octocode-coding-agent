import { type AgentDb, commands } from "../agentdb/api.ts";
import { Value } from "typebox/value";
import { WorkspaceCommandSchema } from "@octocodeai/octocode-contracts/protocol";
import { storedSecret } from "../../../../common/src/sanitize.ts";
import type { WorkspaceCommand, WorkspaceReceipt } from "@octocodeai/octocode-contracts/workspace";

type Row = Omit<commands.CommandRow, "action" | "status"> & {
	action: WorkspaceReceipt["action"];
	status: WorkspaceReceipt["status"];
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
		return (commands.recentWorkspace(this.db.db, this.repo, this.session) as Row[]).reverse().map(receipt);
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
				const existing = commands.byId(this.db.db, this.repo, this.session, command.id) as Row | undefined;
				if (existing) {
					if (existing.input !== input) throw new Error("This request ID was already used for different input.");
					return { fresh: false, receipt: receipt(existing) };
				}
				const at = Date.now();
				const message = "Request recorded; delivery pending. Do not resend if the session disconnects.";
				commands.insertPending(
					this.db.db,
					{
						id: command.id,
						session: this.session,
						repo: this.repo,
						backlogId: command.backlogId ?? null,
						action: command.action,
						input,
					},
					at,
					message,
				);
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
				commands.setStatus(this.db.db, this.repo, this.session, id, status, message);
				return receipt(commands.byId(this.db.db, this.repo, this.session, id) as Row);
			}),
		);
	}
}

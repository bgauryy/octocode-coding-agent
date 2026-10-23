import { applicationCommandFingerprint, type ApplicationCommand, type ApplicationReceipt } from "@octocodeai/octocode-contacts";
import type { ApplicationReceiptStore } from "../../core/application/index.ts";
import type { AgentDb } from "../agentdb/db.ts";
import { redactSecrets, storedSecret } from "../shared/sanitize.ts";

interface Row {
	id: string;
	status: ApplicationReceipt["status"];
	input: string;
	message: string;
}

export class ApplicationCommands implements ApplicationReceiptStore {
	private readonly db: AgentDb;
	private readonly repo: string;
	private session?: string;

	constructor(db: AgentDb, repo: string) {
		this.db = db;
		this.repo = repo;
	}

	begin(command: ApplicationCommand): { fresh: boolean; receipt: ApplicationReceipt } {
		const input = applicationCommandFingerprint(command);
		if (storedSecret({ command: input })) throw new Error("Remove credentials from this command.");
		if (this.session && this.session !== command.sessionId) throw new Error("Receipt store belongs to another session");
		this.session = command.sessionId;
		return this.db.transaction(() => {
			const previous = this.db.db.prepare(
				"SELECT id,status,input,message FROM workspace_commands WHERE repo_key=? AND session_id=? AND id=?",
			).get(this.repo, command.sessionId, `application:${command.id}`) as Row | undefined;
			if (previous) {
				if (previous.input !== input) throw new Error("Request ID already used with another command");
				return { fresh: false, receipt: { id: command.id, status: previous.status, message: previous.message } };
			}
			this.db.db.prepare(
				"INSERT INTO workspace_commands(id,session_id,repo_key,action,input,status,at,message) VALUES (?,?,?,?,?,?,?,?)",
			).run(
				`application:${command.id}`, command.sessionId, this.repo, command.action, input, "accepted", Date.now(),
				"Request recorded. Completion may be unknown after a disconnect.",
			);
			return { fresh: true, receipt: { id: command.id, status: "accepted" } };
		});
	}

	finish(id: string, status: "completed" | "failed", message?: string): ApplicationReceipt {
		if (!this.session) throw new Error("No command session");
		const safeMessage = message === undefined ? undefined : redactSecrets(message);
		this.db.db.prepare(
			"UPDATE workspace_commands SET status=?,message=? WHERE repo_key=? AND session_id=? AND id=?",
		).run(status, safeMessage ?? "", this.repo, this.session, `application:${id}`);
		return { id, status, ...(safeMessage ? { message: safeMessage } : {}) };
	}
}

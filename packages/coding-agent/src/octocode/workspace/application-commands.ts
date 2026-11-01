import {
	applicationCommandFingerprint,
	type ApplicationCommand,
	type ApplicationReceipt,
} from "@octocodeai/octocode-contracts";
import type { ApplicationReceiptStore } from "../../core/application/index.ts";
import { type AgentDb, commands } from "../agentdb/api.ts";
import { redactSecrets, storedSecret } from "../../../../common/src/sanitize.ts";

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
			const previous = commands.byId(this.db.db, this.repo, command.sessionId, `application:${command.id}`);
			if (previous) {
				if (previous.input !== input) throw new Error("Request ID already used with another command");
				return {
					fresh: false,
					receipt: {
						id: command.id,
						status: previous.status as ApplicationReceipt["status"],
						message: previous.message,
					},
				};
			}
			commands.insertAccepted(
				this.db.db,
				{ id: `application:${command.id}`, session: command.sessionId, repo: this.repo, action: command.action, input },
				Date.now(),
				"Request recorded. Completion may be unknown after a disconnect.",
			);
			return { fresh: true, receipt: { id: command.id, status: "accepted" } };
		});
	}

	finish(id: string, status: "completed" | "failed", message?: string): ApplicationReceipt {
		if (!this.session) throw new Error("No command session");
		const safeMessage = message === undefined ? undefined : redactSecrets(message);
		commands.setStatus(this.db.db, this.repo, this.session, `application:${id}`, status, safeMessage ?? "");
		return { id, status, ...(safeMessage ? { message: safeMessage } : {}) };
	}
}

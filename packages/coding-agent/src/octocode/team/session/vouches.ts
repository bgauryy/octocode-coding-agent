import type { Message } from "../model.ts";
import { parentProof, userProof } from "../proof.ts";

/** Secrets of the subagents this session started, by agent id (`Team.vouch`): what signs a message the user types for one, and this session's own. */
export class Vouches {
	private readonly secrets = new Map<string, string>();

	/** Registers the secret given to subagent `id`; returns what ends it, when the child is gone. */
	vouch(id: string, secret: string): () => void {
		this.secrets.set(id, secret);
		return () => {
			if (this.secrets.get(id) === secret) this.secrets.delete(id);
		};
	}

	/** Whether this session started subagent `id` and it is still running. */
	has(id: string): boolean {
		return this.secrets.has(id);
	}

	/** The signature of the user's message `text` (stored as message `id`) for child `recipient`; undefined when this session did not start it. */
	signed(id: number, recipient: string, text: string): string | undefined {
		const secret = this.secrets.get(recipient);
		return secret ? userProof(secret, { id, to: recipient, text }) : undefined;
	}

	/** The signature of this session's own message to child `message.to`; undefined when this session did not start it. */
	signedByParent(message: Pick<Message, "id" | "from" | "to" | "text" | "forwardedBy" | "note">): string | undefined {
		const secret = this.secrets.get(message.to);
		return secret ? parentProof(secret, message) : undefined;
	}

	clear(): void {
		this.secrets.clear();
	}
}

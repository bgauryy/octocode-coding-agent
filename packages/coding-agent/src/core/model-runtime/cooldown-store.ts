import { type AgentDb, providerCooldowns } from "../../../../db/src/api.ts";
import { sharedAgentDb, sharedAgentDbWriter } from "../../storage/database.ts";

/** A provider's rate-limit cool-down: no request to it should start before `until` (ms since the epoch). */
export type Cooldown = providerCooldowns.ProviderCooldown;

/** Where cool-downs are shared with other processes. */
export interface CooldownStore {
	/** The provider's last recorded cool-down, ended or not. */
	read(provider: string): Cooldown | undefined;
	/** Stores a cool-down; one that ends later, recorded meanwhile by another process, is kept. */
	write(provider: string, cooldown: Cooldown): Promise<void>;
}

/**
 * The agent database's cool-downs, seen by every Octocode process using it. A read is one primary-key probe on the
 * process's shared connection, which a writer in another process never blocks (WAL). A write goes through the database
 * writer, so a peer holding the write lock never stalls this thread; this process already holds its own copy.
 */
export function agentDbCooldownStore(env: NodeJS.ProcessEnv = process.env): CooldownStore {
	let agent: AgentDb | undefined;
	const db = () => {
		if (!agent?.db.isOpen) agent = sharedAgentDb(env);
		return agent.db;
	};
	return {
		read: (provider) => providerCooldowns.read(db(), provider),
		write: (provider, cooldown) => sharedAgentDbWriter(env).post({ kind: "provider-cooldown", provider, cooldown }),
	};
}

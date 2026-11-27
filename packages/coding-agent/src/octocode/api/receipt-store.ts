import { apiReceipts } from "../../../../db/src/api.ts";
import { sharedAgentDb } from "../../storage/database.ts";
import type { ReceiptStore } from "./receipts.ts";

/** Keeps keyed send receipts in the shared agent database, resolved at each call so tests and environments choose the file. */
export function agentReceiptStore(env: NodeJS.ProcessEnv): ReceiptStore {
	const db = () => sharedAgentDb(env).db;
	return {
		save: (sessionId, key, row) => apiReceipts.save(db(), sessionId, key, row, Date.now()),
		setPhase: (sessionId, key, phase) => apiReceipts.setPhase(db(), sessionId, key, phase, Date.now()),
		find: (sessionId, key) => apiReceipts.find(db(), sessionId, key),
		forget: (sessionId, key) => apiReceipts.forget(db(), sessionId, key),
	};
}

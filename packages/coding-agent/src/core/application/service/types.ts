import type { ApplicationCommand, ApplicationReceipt } from "@octocodeai/octocode-contracts";

/** Durable receipts; both writes wait for another process's write lock without holding the thread. */
export interface ApplicationReceiptStore {
	/** Records the command as accepted, or finds the receipt already recorded under its id (`fresh: false`). */
	begin(command: ApplicationCommand): Promise<{
		fresh: boolean;
		receipt: ApplicationReceipt;
	}>;
	finish(id: string, status: "completed" | "failed", message?: string): Promise<ApplicationReceipt>;
}

export type ToolOutputProjector = (owner: string, result: unknown) => string | undefined;

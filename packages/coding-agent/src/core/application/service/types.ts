import type { ApplicationCommand, ApplicationReceipt } from "@octocodeai/octocode-contacts";

export interface ApplicationReceiptStore {
	begin(command: ApplicationCommand): {
		fresh: boolean;
		receipt: ApplicationReceipt;
	};
	finish(id: string, status: "completed" | "failed", message?: string): ApplicationReceipt;
}

export type ToolOutputProjector = (owner: string, result: unknown) => string | undefined;

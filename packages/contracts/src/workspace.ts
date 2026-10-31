import type { Static } from "typebox";
import type { ApplicationPort } from "./application.ts";
import type { WorkspaceCommandSchema } from "./protocol.ts";
import type { Member, Traffic } from "./team.ts";

export interface WorkspaceEvent {
	id: number;
	at: number;
	type: string;
	outcome?: "succeeded" | "failed";
	text: string;
	details?: unknown;
}

export type WorkspaceCommand = Static<typeof WorkspaceCommandSchema>;

export interface WorkspaceReceipt {
	id: string;
	backlogId?: string;
	action: WorkspaceCommand["action"];
	status: "pending" | "accepted" | "failed";
	at: number;
	message: string;
}

export interface WorkspaceSnapshot {
	sessionId: string;
	agents: Member[];
	traffic: Traffic[];
	events: WorkspaceEvent[];
	receipts: WorkspaceReceipt[];
}

export interface WorkspaceConnection {
	application?: ApplicationPort;
	snapshot(): WorkspaceSnapshot;
	execute(command: WorkspaceCommand): Promise<WorkspaceReceipt>;
	subscribe(listener: () => void): () => void;
	close(): void;
}

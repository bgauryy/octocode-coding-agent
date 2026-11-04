/** Raised when a change to the RPC records or commands would break an existing driver; additions keep it. */
export const RPC_PROTOCOL_VERSION = 1;

/** The first record of every RPC session: what a driver checks before relying on the protocol. */
export interface RpcReady {
	type: "rpc_ready";
	protocolVersion: number;
	version: string;
	sessionId: string;
}

/** Private ACP worker startup control frame; never an agent event. */
export interface RpcSessionIdentity {
	type: "rpc_session_identity";
	sessionId: string;
}

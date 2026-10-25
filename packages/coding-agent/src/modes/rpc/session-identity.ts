/** Private ACP worker startup control frame; never an agent event. */
export interface RpcSessionIdentity {
	type: "rpc_session_identity";
	sessionId: string;
}

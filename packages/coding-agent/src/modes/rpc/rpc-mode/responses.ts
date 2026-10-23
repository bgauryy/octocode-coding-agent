import type { RpcCommand, RpcResponse } from "../rpc-types.ts";

export const success = <T extends RpcCommand["type"]>(
	id: string | undefined,
	command: T,
	data?: object | null,
): RpcResponse => {
	if (data === undefined) {
		return { id, type: "response", command, success: true } as RpcResponse;
	}
	return { id, type: "response", command, success: true, data } as RpcResponse;
};

export const error = (id: string | undefined, command: string, message: string): RpcResponse => {
	return { id, type: "response", command, success: false, error: message };
};

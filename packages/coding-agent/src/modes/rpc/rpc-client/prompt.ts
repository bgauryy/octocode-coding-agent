import type { ImageContent } from "@octocodeai/octocode-ai";
import type { RpcEvent } from "./types.ts";
import type { RpcConnection } from "./connection.ts";

/** The response owns completion; intermediate agent_settled events may precede extension follow-up work. */
export async function promptAndCollect(
	connection: Pick<RpcConnection, "onEvent" | "send">,
	message: string,
	images: ImageContent[] | undefined,
	timeout: number,
): Promise<RpcEvent[]> {
	const events: RpcEvent[] = [];
	const unsubscribe = connection.onEvent((event) => events.push(event));
	try {
		const response = await connection.send({ type: "prompt", message, images, waitForCompletion: true }, timeout);
		if (!response.success) throw Object.assign(new Error(response.error), { execution: response.execution });
		return events;
	} finally {
		unsubscribe();
	}
}

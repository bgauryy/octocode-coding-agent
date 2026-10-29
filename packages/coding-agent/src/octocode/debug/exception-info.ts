import { isRecord } from "../../utils/guards.ts";
import { body, type DapProtocol } from "./protocol.ts";

/** The adapter's exception id and message for an exception stop; reads state, evaluates nothing. */
export async function exceptionInfo(
	protocol: DapProtocol,
	threadId: number | undefined,
	signal?: AbortSignal,
): Promise<Record<string, unknown> | undefined> {
	try {
		const info = body(await protocol.request("exceptionInfo", { threadId }, signal));
		const details = isRecord(info.details) ? info.details : {};
		const text = (value: unknown) => (typeof value === "string" ? value.slice(0, 2_000) : undefined);
		return { id: text(info.exceptionId), description: text(info.description), message: text(details.message) };
	} catch {
		return undefined;
	}
}

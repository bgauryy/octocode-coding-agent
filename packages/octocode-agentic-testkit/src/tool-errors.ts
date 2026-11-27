import type { Wire } from "./forward.ts";
import { textOf } from "./trace.ts";

/** A tool result the harness itself marked as failed, read from the request history. */
export interface HarnessToolError {
	id: string;
	name: string;
	args: unknown;
	message: string;
}

type Block = {
	type?: string;
	id?: string;
	name?: string;
	input?: unknown;
	tool_use_id?: string;
	content?: unknown;
	is_error?: boolean;
};
type Part = {
	functionCall?: { id?: string; name?: string; args?: unknown };
	functionResponse?: { id?: string; name?: string; response?: { error?: unknown } };
};

/**
 * Failed tool results in a request: Anthropic `tool_result` blocks with `is_error: true` (built-in tools included)
 * and Gemini `functionResponse` parts whose response has an `error`. The chat and Responses wires carry no error flag.
 */
export function harnessToolErrors(wire: Wire, body: Record<string, unknown>): HarnessToolError[] {
	const out: HarnessToolError[] = [];
	if (wire === "anthropic") {
		const uses = new Map<string, Block>();
		for (const m of (Array.isArray(body.messages) ? body.messages : []) as { content?: unknown }[]) {
			if (!Array.isArray(m.content)) continue;
			for (const b of m.content as Block[]) {
				if (b.type === "tool_use" && b.id) uses.set(b.id, b);
				if (b.type === "tool_result" && b.is_error === true && b.tool_use_id) {
					const use = uses.get(b.tool_use_id);
					out.push({ id: b.tool_use_id, name: use?.name ?? "", args: use?.input, message: textOf(b.content) });
				}
			}
		}
	} else if (wire === "gemini") {
		const calls = new Map<string, Part["functionCall"]>();
		// Without call ids, the n-th response of a tool answers its n-th call; the history only grows, so keys stay stable.
		const seen = new Map<string, number>();
		for (const c of (Array.isArray(body.contents) ? body.contents : []) as { parts?: Part[] }[])
			for (const p of c.parts ?? []) {
				if (p.functionCall?.name) calls.set(p.functionCall.id ?? p.functionCall.name, p.functionCall);
				const r = p.functionResponse;
				if (!r?.name) continue;
				const n = (seen.get(r.name) ?? 0) + 1;
				seen.set(r.name, n);
				if (r.response && r.response.error !== undefined) {
					const id = r.id ?? `${r.name}#${n}`;
					out.push({ id, name: r.name, args: calls.get(r.id ?? r.name)?.args, message: textOf(r.response.error) });
				}
			}
	}
	return out;
}

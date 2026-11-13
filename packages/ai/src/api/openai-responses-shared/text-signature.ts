import type { TextSignatureV1 } from "../../types.ts";

export function encodeTextSignatureV1(id: string, phase?: TextSignatureV1["phase"]): string {
	const payload: TextSignatureV1 = { v: 1, id };
	if (phase) payload.phase = phase;
	return JSON.stringify(payload);
}

export function parseTextSignature(
	signature: string | undefined,
): { id: string; phase?: TextSignatureV1["phase"] } | undefined {
	if (!signature?.startsWith("{")) return undefined;
	try {
		const parsed = JSON.parse(signature) as Partial<TextSignatureV1>;
		if (parsed.v !== 1 || typeof parsed.id !== "string") return undefined;
		if (parsed.phase === "commentary" || parsed.phase === "final_answer") return { id: parsed.id, phase: parsed.phase };
		return { id: parsed.id };
	} catch {
		return undefined;
	}
}

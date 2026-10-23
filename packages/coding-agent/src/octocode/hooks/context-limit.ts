import { saveFullOutput } from "../shared/spill.ts";

// Codex's pinned output_spill.rs and utils/string/src/truncate.rs use four UTF-8 bytes per token.
const tokens = (text: string): number => Math.ceil(Buffer.byteLength(text) / 4);

function preview(text: string, limit: number): string {
	const bytes = Buffer.from(text);
	const budget = limit * 4;
	if (bytes.length <= budget) return text;
	let left = Math.floor(budget / 2);
	let right = bytes.length - (budget - left);
	while (left > 0 && (bytes[left] & 0xc0) === 0x80) left--;
	while (right < bytes.length && (bytes[right] & 0xc0) === 0x80) right++;
	const lines = text.split("\n").length - (text.endsWith("\n") ? 1 : 0);
	return (
		`Warning: truncated output (original token count: ${tokens(text)})\nTotal output lines: ${lines}\n\n` +
		`${bytes.subarray(0, left).toString()}…${Math.ceil((bytes.length - budget) / 4)} tokens truncated…${bytes.subarray(right).toString()}`
	);
}

/** Apply the Codex per-handler limit before Octocode's separate aggregate delivery limit. */
export function limitCodexContext(text: string, limit = 2500): string {
	if (limit === 0 || tokens(text) <= limit) return text;
	const file = saveFullOutput(text, "codex-hook");
	if (!file) return preview(text, limit);
	const footer = `\n\nFull hook output saved to: ${file}`;
	return preview(text, Math.max(0, limit - tokens(footer))) + footer;
}

import { GLYPH } from "@octocodeai/octocode-tui";
import { redactData, redactSecrets } from "../../../../common/src/sanitize.ts";
import { clip } from "../shared/render/text.ts";
import { capOutputToFile } from "../shared/spill.ts";
import { isRecord } from "@octocodeai/octocode-contracts/guards";

const asRecords = (value: unknown): Array<Record<string, unknown>> =>
	Array.isArray(value) ? value.filter(isRecord) : [];
const cell = (value: unknown, max = 120): string =>
	typeof value === "string" || typeof value === "number" ? clip(String(value), max) : "";
const row = (...cells: string[]): string => `  ${cells.filter(Boolean).join(" · ")}`;

/** Connected and discoverable external agents as readable rows; empty when there are none. */
export function externalRows(data: unknown): string[] {
	const found = isRecord(data) ? data : {};
	const connections = asRecords(found.connections).map((entry) =>
		row(
			`${GLYPH.live} ${cell(entry.id, 64)}`,
			[cell(entry.transport, 16), cell(entry.vendor, 32)].filter(Boolean).join(" "),
			cell(entry.model, 64),
			entry.busy === true ? "busy" : "idle",
			cell(entry.cwd),
		),
	);
	const instances = asRecords(found.instances).map((entry) =>
		row(
			`${GLYPH.pending} octocode ${cell(entry.id, 64)}`,
			entry.pid === undefined ? "" : `pid ${cell(entry.pid, 12)}`,
			cell(entry.cwd),
		),
	);
	const installed = asRecords(found.acpAgents).map((entry) =>
		row(
			`${GLYPH.pending} ${cell(entry.vendor, 32)}`,
			[cell(entry.command, 64), ...(Array.isArray(entry.args) ? entry.args.map((arg) => cell(arg, 32)) : [])]
				.filter(Boolean)
				.join(" "),
			cell(entry.path),
		),
	);
	return [
		...(connections.length ? ["Connected external agents", ...connections] : []),
		...(instances.length
			? ["Available Octocode instances (/agents external connect octocode <id>)", ...instances]
			: []),
		...(installed.length
			? [
					"Installed ACP agents, not started or signed-in checked (/agents external connect acp <vendor> <command> [args...])",
					...installed,
				]
			: []),
	];
}

/**
 * What `/agents external ...` tells the user: rows and sentences, never the JSON envelope or the untrusted fence (the fence
 * is for text the model reads; this is drawn for the person who typed the command). Secrets stay redacted; long text spills to a file.
 */
export function describeExternal(data: unknown): string {
	const safe = redactData(data);
	const found = isRecord(safe) ? safe : {};
	const id = cell(found.id, 64);
	const text = (() => {
		if ("connections" in found || "instances" in found || "acpAgents" in found)
			return externalRows(found).join("\n") || "No external agents connected or available.";
		if (isRecord(found.reply)) {
			const reply = found.reply;
			const stop = cell(reply.stopReason, 32);
			return `${id || "External agent"} replied${stop ? ` (${stop})` : ""}:\n${typeof reply.text === "string" ? reply.text : ""}`;
		}
		if (found.disconnected !== undefined) return `Disconnected ${cell(found.disconnected, 64)}.`;
		if (found.cancelled !== undefined) return `Cancelled ${cell(found.cancelled, 64)}.`;
		if (id && found.transport !== undefined) {
			const offered = Array.isArray(found.models) ? found.models.length + Number(found.modelsMore ?? 0) : 0;
			const model = found.model ? ` · model ${cell(found.model, 64)}${offered ? ` (${offered} available)` : ""}` : "";
			return `Connected ${id} · ${cell(found.transport, 16)} ${cell(found.vendor, 32)} · ${cell(found.cwd)}${model}`.replace(
				/ {2,}/g,
				" ",
			);
		}
		return JSON.stringify(found, null, 2);
	})();
	return capOutputToFile(redactSecrets(text), { label: "external-agent" });
}

/** A failed external command: the message, how far it got, and what came back before it failed. */
export function describeExternalFailure(failure: Record<string, unknown>): string {
	const partial = isRecord(failure.partial) && typeof failure.partial.text === "string" ? failure.partial.text : "";
	const lines = [
		`External agent error: ${cell(failure.error, 400) || "failed"}`,
		failure.execution ? `Execution: ${cell(failure.execution, 32)}` : "",
		partial ? `Partial output:\n${partial}` : "",
	];
	return capOutputToFile(redactSecrets(lines.filter(Boolean).join("\n")), { label: "external-agent" });
}

import type { ExtensionContext } from "../../core/extensions/index.ts";
import { type Subcommands, say, wordCompletions } from "../shared/commands.ts";
import { PERMISSION_ENV } from "../shared/env.ts";
import { shortcutText } from "../shared/keys.ts";
import { redactSecrets, sanitizeTerminalText } from "../shared/sanitize.ts";
import { modeSummary, type Permission } from "./ask.ts";
import type { AuditEntry } from "./audit.ts";
import {
	ACTION_CLASSES,
	ASK_REASONS,
	decide,
	PERMISSION_CYCLE,
	PERMISSION_ID,
	PERMISSION_MODES,
	type PermissionMode,
	reasonAsks,
} from "./mode.ts";

/** Audit entries `/permissions log` shows, newest last. */
const LOG_ENTRIES = 50;
const USAGE = `Usage: /permissions [${PERMISSION_MODES.join("|")}|grants [clear]|log]`;
const NOT_A_SANDBOX =
	"Modes and reasons decide what Octocode asks about and records; they are not a sandbox (the OS user's rights stay as they are).";

function status(permission: Permission, provenanceSize: number): string {
	const grants = permission.grants();
	return [
		`Permission mode: ${permission.mode} — ${modeSummary(permission.mode)}`,
		...ACTION_CLASSES.map((action) => `  ${action}: ${decide(permission.mode, action)}`),
		...ASK_REASONS.map((reason) => `  ${reason}: ${reasonAsks(permission.mode, reason) ? "ask" : "allow"}`),
		`Session grants: ${grants.length > 0 ? "" : "none"}`,
		...grants.map((grant) => `  ${grant}`),
		`Provenance index: ${provenanceSize} shingles`,
		`${shortcutText("app.permission.cycle")} in the editor cycles ${PERMISSION_CYCLE.join(" → ")}; start mode: ${PERMISSION_ENV}, else full.`,
		"Thinking level: /thinking.",
		NOT_A_SANDBOX,
	].join("\n");
}

/** One audit entry as a log line: redacted again at display time, so an entry written by an older build cannot leak a secret. */
function logLine(entry: AuditEntry): string {
	const time = new Date(entry.at).toTimeString().slice(0, 8);
	const what = entry.what.join(" | ");
	const line =
		entry.action === "mode" || entry.action === "rollup"
			? `${time} ${entry.action} ${what}${entry.suppressed ? ` ${JSON.stringify(entry.suppressed)}` : ""}`
			: `${time} ${entry.mode} ${entry.agent} ${entry.action} ${entry.allowed ? "allowed" : "denied"} (${entry.via}) ${what}${entry.reasons?.length ? ` [${entry.reasons.join(" ")}]` : ""}${entry.purpose ? ` — says: ${entry.purpose}` : ""}${entry.snapshot ? ` — snapshot: ${entry.snapshot}` : ""}${entry.note ? ` — note: ${entry.note}` : ""}`;
	return sanitizeTerminalText(redactSecrets(line));
}

function logLines(ctx: ExtensionContext, permission: Permission): string {
	permission.flushAudit();
	const all = ctx.sessionManager
		.getEntries()
		.flatMap((entry) =>
			entry.type === "custom" &&
			entry.customType === PERMISSION_ID &&
			Array.isArray((entry.data as AuditEntry | undefined)?.what)
				? [entry.data as AuditEntry]
				: [],
		);
	if (all.length === 0) return "No permission decisions in this session yet.";
	const entries = all.slice(-LOG_ENTRIES);
	// The session file keeps every decision; say how many earlier ones the log leaves out.
	const earlier = all.length - entries.length;
	return [
		...(earlier > 0 ? [`(${earlier} earlier decision(s) not shown; the session file keeps them all)`] : []),
		...entries.map(logLine),
	].join("\n");
}

/**
 * `/permissions [manual|workspace|full|grants [clear]|log]`. The command works everywhere, RPC included; the
 * editor shortcut lives in `ui/editor`.
 */
export function registerPermissionCommand(
	commands: Subcommands,
	permission: Permission,
	provenanceSize: () => number,
): void {
	const select = async (mode: PermissionMode, ctx: ExtensionContext): Promise<void> => {
		permission.setMode(mode, ctx);
		if (!ctx.hasUI) say(ctx, `Permission mode: ${mode}. ${modeSummary(mode)}`);
	};

	commands.add("permissions", {
		aliases: ["permission"],
		description: `permissions [manual|workspace|full|grants [clear]|log] — what Octocode asks before it acts (${shortcutText("app.permission.cycle")} cycles in the editor)`,
		complete: (prefix) => wordCompletions([...PERMISSION_MODES, "grants", "grants clear", "log"], prefix),
		handler: async (args, ctx) => {
			const words = args.trim().toLowerCase().split(/\s+/).filter(Boolean);
			const [word = "", rest] = words;
			if (words.length === 0) return say(ctx, status(permission, provenanceSize()));
			if ((PERMISSION_MODES as readonly string[]).includes(word) && words.length === 1)
				return select(word as PermissionMode, ctx);
			if (word === "grants" && rest === "clear" && words.length === 2) {
				permission.clearGrants();
				return say(ctx, "Session grants cleared.");
			}
			if (word === "grants" && words.length === 1) {
				const grants = permission.grants();
				return say(
					ctx,
					grants.length > 0
						? `Session grants:\n${grants.map((grant) => `  ${grant}`).join("\n")}`
						: "Session grants: none",
				);
			}
			if (word === "log" && words.length === 1) return say(ctx, logLines(ctx, permission));
			return say(ctx, USAGE, "warning");
		},
	});
}

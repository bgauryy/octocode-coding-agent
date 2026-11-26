import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { type CompactionEntry } from "../../core/session-manager.ts";
import { type AgentDb, agentEvents, compactions, sessions } from "../../../../db/src/api.ts";
import { archiveFolder, segmentFiles } from "../history/archive.ts";
import { atomicWriteFile } from "@octocodeai/octocode-common/atomic-file";
import { workspaceDb } from "../../storage/workspace-database.ts";

export function saveCompaction(
	agent: AgentDb,
	cwd: string,
	sessionId: string,
	entry: CompactionEntry,
	options: {
		recovered?: boolean;
		env?: NodeJS.ProcessEnv;
		verified?: boolean;
		transcript?: string;
		activationId?: string;
		agentId?: string;
		detail?: { n: number; name: string } | null;
	} = {},
): void {
	// `agent` is the machine file (the mirror, the session row); the compaction event goes to the workspace's file.
	const bound = workspaceDb(cwd, options.env);
	const events = bound.agent;
	const workspace = bound.workspace.id;
	const known = compactions.get(agent.mirror.db, sessionId, entry.id);
	if (known && known.workspace !== workspace) throw new Error("Compaction belongs to another workspace");
	const segment =
		options.detail !== undefined
			? options.detail
			: segmentFiles(archiveFolder(sessionId, options.env, cwd)).find(({ name }) => name.endsWith(`-${entry.id}.md`));
	if (
		known?.originVerified &&
		known.summary === entry.summary &&
		(known.detailState === "expired" || known.detailFile || !segment)
	)
		return;
	const timestamp = Date.parse(entry.timestamp);
	const committedAt = Number.isFinite(timestamp) ? timestamp : null;
	const verified = options.verified ?? true;
	// The summary lives in the transcript mirror, the session's binding in the machine file and its event in the
	// workspace's file: one transaction of each, nested in that lock order, so a failed event rolls the others back too.
	agent.mirror.transaction(() => {
		compactions.save(agent.mirror.db, {
			workspace,
			sessionId,
			entryId: entry.id,
			summary: entry.summary,
			committedAt,
			originVerified: verified,
			metadata: {
				...known?.metadata,
				tokensBefore: entry.tokensBefore,
				firstKeptEntryId: entry.firstKeptEntryId,
				...(options.transcript ? { transcript: options.transcript } : {}),
				...(segment ? { segment: segment.n } : {}),
			},
			detailFile: segment ? path.join(archiveFolder(sessionId, options.env, cwd), segment.name) : null,
			detailState: segment ? "present" : "missing",
		});
		agent.transaction(() => {
			sessions.bind(agent.db, sessionId, workspace);
			const member = options.agentId ? agentEvents.member(events.db, options.agentId) : undefined;
			if (verified && committedAt !== null)
				events.transaction(() =>
					agentEvents.append(
						events.db,
						workspace,
						{
							id: randomUUID(),
							time: new Date(committedAt).toISOString(),
							name: options.agentId ?? null,
							parentId: (member?.parent_id as string | null) ?? null,
							sessionId,
							type: "compaction",
							version: 1,
							data: {
								agentId: options.agentId ?? null,
								registrationId: member?.registration_id ?? null,
								parentRegistrationId: member?.parent_registration_id ?? null,
								activationId: options.activationId ?? null,
								compactionId: `compaction:${sessionId}:${entry.id}`,
								recovered: options.recovered ?? false,
							},
						},
						`compaction:${sessionId}:${entry.id}`,
					),
				);
		});
	});
}

/** LIBRARY is a projection of retained summaries, including expired detail pointers. */
export async function writeSummaryLibrary(
	agent: AgentDb,
	sessionId: string,
	env: NodeJS.ProcessEnv = process.env,
	cwd?: string,
): Promise<void> {
	const rows = compactions.forSession(agent.mirror.db, sessionId);
	if (!rows.length) return;
	const folder = archiveFolder(sessionId, env, cwd);
	await fs.promises.mkdir(folder, { recursive: true, mode: 0o700 });
	const content = [
		"# Compaction archive",
		"",
		"Full summaries remain available through archive. Detail copies may expire.",
		"",
		...rows.flatMap((row) => [
			`## compaction:${row.sessionId}:${row.entryId}`,
			"",
			`Committed: ${row.committedAt === null ? "unknown" : new Date(row.committedAt).toISOString()} · detail: ${row.detailState}`,
			...(row.detailState === "present" && row.detailFile ? [`File: ${row.detailFile}`] : []),
			"",
			row.summary.slice(0, 800),
			"",
		]),
	].join("\n");
	await atomicWriteFile(path.join(folder, "LIBRARY.md"), content, undefined, { mode: 0o600 });
}

import { sha256 } from "@octocodeai/octocode-common/atomic-file";
import { envFlag, LEAN_ENV } from "@octocodeai/octocode-common/env";
import { homeTilde } from "@octocodeai/octocode-common/home-tilde";
import type { FeatureContext, FeatureSetup } from "../../../core/features/index.ts";
import { renderPrompt } from "../../../core/prompt-template.ts";
import { notify } from "../../shared/commands.ts";
import { loadableLines, type MemoryLine, memoryLineKey, parseMemoryFile, serializeMemoryFile } from "./format.ts";
import { trackedByGit } from "./paths.ts";
import {
	globalMemoryFile,
	type MemoryFileRef,
	type MemoryFileScope,
	workspaceMemoryFile,
} from "../../permission/memory-files.ts";
import { type MemorySettings, memorySettings } from "./settings.ts";
import { readMemoryFile } from "./writer.ts";

/**
 * The `memory` system-prompt section: the global MEMORY.md, then the repository's, in the session tier after
 * `project_context`. It is read when a session's first request is built and kept for the session, so the cached prefix
 * stays byte-identical while the files change; a compaction, which rebuilds the messages anyway, reads them again and
 * takes the new text only when a file changed.
 */

export const MEMORY_SECTION = "memory";

interface LoadedMemoryFile {
	ref: MemoryFileRef;
	/** SHA-256 of the file as read; undefined when it does not exist. */
	sha: string | undefined;
	lines: MemoryLine[];
	/** Lines left out of the prompt (a secret, a line over 200 characters, past the cap) and content outside a section. */
	skipped: Array<{ text: string; reason: string }>;
	tracked: boolean;
}

/** One file as a session may read it: placeable lines within the caps, secrets and stray content left out. */
async function loadMemoryFile(ref: MemoryFileRef, env: NodeJS.ProcessEnv = process.env): Promise<LoadedMemoryFile> {
	const text = await readMemoryFile(ref, env);
	if (text === undefined) return { ref, sha: undefined, lines: [], skipped: [], tracked: false };
	const parsed = parseMemoryFile(text);
	const loadable = loadableLines(parsed.lines, ref.scope);
	return {
		ref,
		sha: sha256(text),
		lines: loadable.lines,
		skipped: [
			...parsed.problems.map((problem) => ({ text: problem.text.slice(0, 80), reason: problem.reason })),
			...loadable.skipped,
		],
		tracked: trackedByGit(ref),
	};
}

/** The files a session reads: main both, a subagent per `memory.subagents`, a lean subagent none. */
function memoryFileScopes(
	role: { isSubagent: boolean; lean: boolean },
	settings: Pick<MemorySettings, "file" | "subagents">,
): MemoryFileScope[] {
	if (!settings.file || role.lean) return [];
	if (!role.isSubagent || settings.subagents === "all") return ["global", "workspace"];
	return settings.subagents === "workspace" ? ["workspace"] : [];
}

/** The section text for `files` (global first): the header, then each file with lines under its label; "" for none. */
function renderMemorySection(files: readonly LoadedMemoryFile[]): string {
	const blocks = files
		.filter((file) => file.lines.length > 0)
		.map((file) =>
			[
				renderPrompt("notices/memory-file.md", {
					global: file.ref.scope === "global",
					path: homeTilde(file.ref.path),
					tracked: file.tracked,
				}),
				serializeMemoryFile(file.lines).trimEnd(),
			].join("\n"),
		);
	return blocks.length > 0 ? [renderPrompt("notices/memory-file-header.md"), ...blocks].join("\n") : "";
}

interface Snapshot {
	session: string;
	text: string;
	files: LoadedMemoryFile[];
}

/**
 * Keeps the `memory` section of each session: read at its first request, frozen, and read again after a compaction,
 * replaced only when a file's SHA changed. A main session with a screen is told about lines left out whenever a
 * snapshot is taken into use.
 */
export function registerMemorySection(
	api: Pick<FeatureSetup, "bus" | "settings">,
	options: { isSubagent: boolean; env?: NodeJS.ProcessEnv },
): { lineKeys: () => ReadonlySet<string> } {
	const env = options.env ?? process.env;
	const lean = options.isSubagent && envFlag(env, LEAN_ENV);
	let snapshot: Snapshot | undefined;

	const take = async (ctx: FeatureContext): Promise<Snapshot> => {
		const scopes = memoryFileScopes({ isSubagent: options.isSubagent, lean }, memorySettings(api.settings.get()));
		const files = await Promise.all(
			scopes.map((scope) =>
				loadMemoryFile(scope === "global" ? globalMemoryFile(env) : workspaceMemoryFile(ctx.cwd), env),
			),
		);
		return { session: ctx.sessionManager.getSessionId(), text: renderMemorySection(files), files };
	};
	const adopt = (next: Snapshot, ctx: FeatureContext) => {
		snapshot = next;
		if (!ctx.hasUI || options.isSubagent) return;
		for (const file of next.files.filter((loaded) => loaded.skipped.length > 0))
			notify(
				ctx.ui,
				`${homeTilde(file.ref.path)}: ${file.skipped.length} line(s) left out of the prompt (${file.skipped[0].reason}: ${file.skipped[0].text})`,
				"warning",
			);
	};

	api.bus.on("before_agent_start", async (event, ctx) => {
		if (snapshot?.session !== ctx.sessionManager.getSessionId()) adopt(await take(ctx), ctx);
		event.systemPromptOptions.sections[MEMORY_SECTION] = snapshot?.text ?? "";
		return undefined;
	});

	api.bus.on("session_compact", async (_event, ctx) => {
		const current = snapshot;
		if (!current || current.session !== ctx.sessionManager.getSessionId()) return;
		const next = await take(ctx);
		if (next.files.some((file, index) => file.sha !== current.files[index]?.sha)) adopt(next, ctx);
	});

	// What the session's prompt already carries, so recall from the database does not send it again.
	let keys: { snapshot: Snapshot | undefined; set: ReadonlySet<string> } | undefined;
	return {
		lineKeys: () => {
			if (!keys || keys.snapshot !== snapshot)
				keys = {
					snapshot,
					set: new Set(snapshot?.files.flatMap((file) => file.lines.map((line) => memoryLineKey(line.text)))),
				};
			return keys.set;
		},
	};
}

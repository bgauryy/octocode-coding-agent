import path from "node:path";

/** The project folder `<workspace>/.octocode`: configuration the user writes, and what the Octocode MCP and browser servers write themselves. */
export const OCTOCODE_DIR = ".octocode";

/** `<workspace>/.octocode/agent`: the root of everything Octocode writes in a workspace. */
export const AGENT_DIR = path.join(OCTOCODE_DIR, "agent");

/** Folders directly under `AGENT_DIR`. Any other folder there is a topic: durable output that nothing loads and retention keeps. */
export const AGENT_FOLDERS = {
	/** The workspace id (`workspace/id`). */
	marker: "workspace",
	/** Session transcripts. */
	sessions: "sessions",
	/** Per-session durable data (archive, checkpoints). */
	sessionData: "session-data",
	/** Session-keyed runtime output and each subagent's scratch folder; retention follows the session. */
	temp: "temp",
	/** Throwaways agents and skills write by name; retention expires them by idle time. */
	tmp: "tmp",
	/** Checkouts made by `/worktree` and isolated subagents. */
	worktrees: "worktrees",
} as const;

/** The workspace's curated memory file, in `AGENT_DIR`. */
export const MEMORY_FILE = "MEMORY.md";

/** Files Octocode generates directly in `AGENT_DIR`, as glob names: its own `.gitignore`, the event view, the backlog exports and atomic-write leftovers. */
const GENERATED_FILES = [".gitignore", "agents.txt*", "backlog.md", "backlog.html", ".octocode-*.tmp"] as const;

/** What Git must never track in `AGENT_DIR`, as names relative to it (folders first, then generated file globs). */
export const AGENT_IGNORED = {
	folders: Object.values(AGENT_FOLDERS),
	files: GENERATED_FILES,
} as const;

/** The `.gitignore` written into `AGENT_DIR`: runtime state, scratch and checkouts are ignored; `MEMORY.md` and topics are not. */
export const AGENT_GITIGNORE = `${[
	...AGENT_IGNORED.folders.map((name) => `/${name}/`),
	...AGENT_IGNORED.files.map((name) => `/${name}`),
].join("\n")}\n`;

const GLOB_NAMES = [...AGENT_IGNORED.files].map(
	(glob) => new RegExp(`^${glob.replace(/[.]/g, "\\.").replace(/\*/g, ".*")}$`, "i"),
);

/** Whether `name`, an entry directly in `AGENT_DIR`, is runtime state that Git ignores (case-insensitive: the folder is read so on macOS and Windows). */
export function isIgnoredAgentEntry(name: string): boolean {
	return (
		AGENT_IGNORED.folders.some((folder) => folder === name.toLowerCase()) || GLOB_NAMES.some((glob) => glob.test(name))
	);
}

/** Whether `relative` (from a workspace root, any separator) lies in an `AGENT_DIR`'s runtime state, at any depth (a nested checkout's too). */
export function inAgentState(relative: string): boolean {
	const parts = relative.split(/[\\/]/);
	const [octocode, agent] = AGENT_DIR.split(path.sep);
	return parts.some(
		(part, at) =>
			part.toLowerCase() === octocode &&
			parts[at + 1]?.toLowerCase() === agent &&
			parts[at + 2] !== undefined &&
			isIgnoredAgentEntry(parts[at + 2]),
	);
}

import { ELLIPSIS } from "@octocodeai/octocode-tui";
import { runtimeTempDir } from "../../config/runtime-paths.ts";
import { getApplicationPort } from "../../core/application/index.ts";
import { type ChildProcess, spawn } from "node:child_process";
import * as crypto from "node:crypto";
import * as fs from "node:fs";

import * as path from "node:path";
import type { Container, EditorComponent, TUI } from "@octocodeai/octocode-tui";
import { getShareViewerUrl } from "../../config.ts";
import type { AgentSession } from "../../core/agent-session.ts";
import { BorderedLoader } from "./components/bordered-loader.ts";
import { theme } from "../../theme/theme.ts";
import type { StatusText } from "./interactive-mode/types.ts";

interface SessionShareContext {
	session: AgentSession;
	ui: TUI;
	editorContainer: Container;
	editor: EditorComponent;
	showStatus: (message: StatusText) => void;
	showError: (message: string) => void;
}

/** Trailing `octocode.share` entry carrying the system prompt and tool schemas for the session viewer. */
export function createShareTrailingEntries(
	session: AgentSession,
	parentId: string | null,
	timestamp: string,
): object[] {
	return [
		{
			type: "custom",
			customType: "octocode.share",
			id: crypto.randomUUID().slice(0, 8),
			parentId,
			timestamp,
			data: {
				systemPrompt: session.state.systemPrompt,
				tools: session.state.tools.map((tool) => ({
					name: tool.name,
					description: tool.description,
					parameters: tool.parameters,
				})),
			},
		},
	];
}

interface GhResult {
	stdout: string;
	stderr: string;
	code: number | null;
	/** Set when gh could not be started; Node then also emits `close` with a negative code. */
	error?: NodeJS.ErrnoException;
}

/** Run gh without blocking the terminal; a spawn failure resolves with `error` instead of throwing. */
function runGh(args: string[], onSpawn?: (proc: ChildProcess) => void): Promise<GhResult> {
	return new Promise((resolve) => {
		const proc = spawn("gh", args);
		onSpawn?.(proc);
		let stdout = "";
		let stderr = "";
		proc.stdout?.on("data", (data) => {
			stdout += data.toString();
		});
		proc.stderr?.on("data", (data) => {
			stderr += data.toString();
		});
		proc.on("error", (error: NodeJS.ErrnoException) => resolve({ stdout, stderr: error.message, code: null, error }));
		proc.on("close", (code) => resolve({ stdout, stderr, code }));
	});
}

/** Share the current session as a secret GitHub gist: unlisted, but readable by anyone who has the link. */
export async function shareSession(context: SessionShareContext): Promise<void> {
	const tempDir = fs.mkdtempSync(path.join(runtimeTempDir(), "octocode-share-"));
	const htmlFile = path.join(tempDir, "session.html");

	try {
		const authResult = await runGh(["auth", "status"]);
		if (authResult.error?.code === "ENOENT") {
			context.showError("GitHub CLI (gh) is not installed. Install it from https://cli.github.com/");
			return;
		}
		if (authResult.error) {
			context.showError(`Could not run GitHub CLI: ${authResult.error.message}`);
			return;
		}
		if (authResult.code !== 0) {
			context.showError("GitHub CLI is not logged in. Run 'gh auth login' first.");
			return;
		}

		try {
			await getApplicationPort(context.session).invoke("exportToHtml", htmlFile, { themeName: theme.name });
		} catch (error: unknown) {
			context.showError(`Failed to export session: ${error instanceof Error ? error.message : "Unknown error"}`);
			return;
		}
		await shareViaGist(htmlFile, context);
	} finally {
		try {
			fs.rmSync(tempDir, { recursive: true, force: true });
		} catch {
			// Ignore cleanup errors
		}
	}
}

async function shareViaGist(tmpFile: string, context: SessionShareContext): Promise<void> {
	const loader = new BorderedLoader(context.ui, theme, `Creating gist${ELLIPSIS}`);
	context.editorContainer.clear();
	context.editorContainer.addChild(loader);
	context.ui.setFocus(loader);
	context.ui.requestRender();

	let proc: ChildProcess | undefined;
	loader.onAbort = () => {
		proc?.kill();
		restoreEditor(loader, context);
		context.showStatus("Share cancelled");
	};

	try {
		const result = await runGh(["gist", "create", "--public=false", tmpFile], (child) => {
			proc = child;
		});

		if (loader.signal.aborted) return;
		restoreEditor(loader, context);

		if (result.code !== 0) {
			context.showError(`Failed to create gist: ${result.stderr?.trim() || "Unknown error"}`);
			return;
		}

		const gistUrl = result.stdout?.trim();
		const gistId = gistUrl?.split("/").pop();
		if (!gistId) {
			context.showError("Failed to parse gist ID from gh output");
			return;
		}

		const previewUrl = getShareViewerUrl(gistId);
		context.showStatus([
			"Share URL: ",
			{ url: previewUrl },
			"\nGist: ",
			{ url: gistUrl },
			`\nAnyone with the link can read it; delete it with: gh gist delete ${gistId}`,
		]);
	} catch (error: unknown) {
		if (!loader.signal.aborted) {
			restoreEditor(loader, context);
			context.showError(`Failed to create gist: ${error instanceof Error ? error.message : "Unknown error"}`);
		}
	}
}

function restoreEditor(loader: BorderedLoader, context: SessionShareContext): void {
	loader.dispose();
	context.editorContainer.clear();
	context.editorContainer.addChild(context.editor);
	context.ui.setFocus(context.editor);
}

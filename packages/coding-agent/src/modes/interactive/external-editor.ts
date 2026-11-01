import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { errorMessage } from "@octocodeai/octocode-contracts/guards";
import { stripBom } from "../../../../common/src/text.ts";

interface ExternalEditorOptions {
	command: string;
	content: string;
}

/** `failed` without `error` means the editor exited unsuccessfully (for example vim `:cq`); with `error`, it could not run. */
export type ExternalEditorResult = { status: "complete"; content: string } | { status: "failed"; error?: string };

/**
 * Edit `content` in the external editor. Never rejects: an editor that cannot start or an unusable temporary
 * directory is `failed` with an `error` the caller can show.
 */
export async function editInExternalEditor(options: ExternalEditorOptions): Promise<ExternalEditorResult> {
	let directory: string | undefined;
	try {
		directory = mkdtempSync(join(tmpdir(), "octocode-editor-"));
		const filePath = join(directory, "prompt.md");
		writeFileSync(filePath, options.content, "utf-8");
		const [editor, ...editorArgs] = options.command.split(" ");
		process.stdout.write(
			`Launching external editor: ${options.command}\nOctocode will resume when the editor exits.\n`,
		);

		// Do not use spawnSync here. On Windows, synchronous child_process calls can keep
		// Node/libuv's console input read active after the parent pauses stdin, racing
		// vim/nvim for the console input buffer until Ctrl+C cancels the pending read.
		const exit = await new Promise<{ code: number | null } | { error: unknown }>((resolve) => {
			const child = spawn(editor, [...editorArgs, filePath], {
				stdio: "inherit",
				shell: process.platform === "win32",
			});
			child.on("error", (error) => resolve({ error }));
			child.on("close", (code) => resolve({ code }));
		});

		if ("error" in exit) return { status: "failed", error: errorMessage(exit.error) };
		if (exit.code !== 0) return { status: "failed" };

		return { status: "complete", content: stripBom(readFileSync(filePath, "utf-8")).replace(/\n$/, "") };
	} catch (error) {
		// Callers drop the promise from key handlers; a rejection here would end the process.
		return { status: "failed", error: errorMessage(error) };
	} finally {
		try {
			if (directory) rmSync(directory, { recursive: true, force: true });
		} catch {
			// Cleanup is best effort.
		}
	}
}

import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SettingsManager } from "../../src/core/settings-manager.ts";
import { assertSessionCwdExists, MissingSessionCwdError } from "../../src/core/session-cwd.ts";
import { SessionManager } from "../../src/core/session-manager.ts";
import { promptForMissingSessionCwd as promptInTui } from "../../src/modes/interactive/interactive-mode/extension-dialogs.ts";
import type * as StartupUi from "../../src/cli/startup-ui.ts";
import { promptForMissingSessionCwd as promptAtStartup } from "../../src/main/startup.ts";

const { select } = vi.hoisted(() => ({ select: vi.fn<(...args: unknown[]) => Promise<unknown>>() }));
vi.mock("../../src/cli/startup-ui.ts", async (importOriginal) => ({
	...(await importOriginal<typeof StartupUi>()),
	showStartupSelector: select,
}));

const tempDirs: string[] = [];
afterEach(() => {
	select.mockReset();
	for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** The error `--session`, `--continue` or `/resume` meet for a session saved in `cwd`, which is then removed. */
function missingCwdError(relative: string): MissingSessionCwdError {
	const root = realpathSync(mkdtempSync(join(tmpdir(), "octocode-missing-cwd-")));
	tempDirs.push(root);
	const cwd = join(root, relative);
	mkdirSync(cwd, { recursive: true });
	const session = SessionManager.create(cwd, join(root, "sessions"));
	session.appendMessage({ role: "user", content: "hello", timestamp: 1 });
	rmSync(join(root, relative.split("/")[0]), { recursive: true });
	const fallback = join(root, "elsewhere");
	try {
		assertSessionCwdExists(session, fallback);
	} catch (error) {
		if (error instanceof MissingSessionCwdError) return error;
		throw error;
	}
	throw new Error("the session folder should be missing");
}

const WORKTREE = ".octocode/worktrees/feature";

describe("resuming a session whose worktree is gone", () => {
	it("the startup prompt (--session, --continue) offers recreating the worktree", async () => {
		const error = missingCwdError(WORKTREE);
		select.mockResolvedValueOnce(undefined);
		await promptAtStartup(error.issue, SettingsManager.inMemory());
		const question = String(select.mock.calls[0][1]);
		expect(question).toContain("/worktree new feature");
		expect(question).toContain("octocode --worktree feature");
		expect(question).toContain(error.issue.sessionCwd);
		expect(question).toContain("continue in current cwd");
	});

	it("the /resume prompt in the terminal offers it too", async () => {
		const error = missingCwdError(WORKTREE);
		const showExtensionConfirm = vi.fn(async (_title: string, _message: string) => false);
		await promptInTui({ showExtensionConfirm } as never, error);
		expect(String(showExtensionConfirm.mock.calls[0][1])).toContain("/worktree new feature");
	});

	it("the non-interactive error (--print, --continue) names it as well", () => {
		expect(missingCwdError(WORKTREE).message).toContain("octocode --worktree feature");
	});

	it("adds nothing for a folder that was not an Octocode worktree", async () => {
		const error = missingCwdError("project/sub");
		select.mockResolvedValueOnce(undefined);
		await promptAtStartup(error.issue, SettingsManager.inMemory());
		expect(String(select.mock.calls[0][1])).not.toContain("/worktree new");
		expect(error.message).not.toContain("--worktree");
	});
});

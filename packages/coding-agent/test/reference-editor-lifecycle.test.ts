import { EventEmitter } from "node:events";
import { beforeEach, expect, it, vi } from "vitest";
import { runReferenceEditor } from "../src/modes/interactive/reference-opener.ts";

const { spawn, release } = vi.hoisted(() => ({ spawn: vi.fn(), release: vi.fn() }));
vi.mock("node:child_process", () => ({ spawn }));
vi.mock("../src/utils/foreground-child.ts", () => ({ holdTerminalForChild: () => release }));

beforeEach(() => {
	spawn.mockReset();
	release.mockReset();
});

function host() {
	return {
		ui: {
			stop: vi.fn(),
			start: vi.fn(),
			requestRender: vi.fn(),
			terminal: { drainOutput: vi.fn().mockResolvedValue(undefined) },
		},
	} as unknown as Parameters<typeof runReferenceEditor>[0];
}

it("hands off the terminal with separate arguments and restores it on editor failure", async () => {
	const ui = host();
	const child = new EventEmitter();
	spawn.mockReturnValue(child);
	const running = runReferenceEditor(ui, { command: "editor", args: ["/work/a;$(bad).ts"] });
	await Promise.resolve();
	expect(spawn).toHaveBeenCalledWith("editor", ["/work/a;$(bad).ts"], { stdio: "inherit", shell: false });
	child.emit("error", new Error("missing editor"));
	await expect(running).rejects.toThrow("missing editor");
	expect(release).toHaveBeenCalledOnce();
	expect(ui.ui.start).toHaveBeenCalledOnce();
	expect(ui.ui.requestRender).toHaveBeenCalledWith(true);
});

it("restores the terminal when pending output cannot drain", async () => {
	const ui = host();
	vi.mocked(ui.ui.terminal.drainOutput!).mockRejectedValue(new Error("closed output"));
	await expect(runReferenceEditor(ui, { command: "editor", args: [] })).rejects.toThrow("closed output");
	expect(spawn).not.toHaveBeenCalled();
	expect(release).toHaveBeenCalledOnce();
	expect(ui.ui.start).toHaveBeenCalledOnce();
});

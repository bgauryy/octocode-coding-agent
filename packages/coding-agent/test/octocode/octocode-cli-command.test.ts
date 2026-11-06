import { describe, expect, it, vi } from "vitest";
import type { ExtensionCommandContext } from "../../src/core/features/index.ts";
import { octocodeCommand } from "../../src/octocode/cli/command.ts";
import { parseCliHelp } from "../../src/octocode/cli/help.ts";
import { resolveOctocodeCli } from "../../src/octocode/cli/resolve.ts";

/** A command context without a terminal UI, as RPC and web modes give: `custom` never builds its component. */
function headless() {
	const notify = vi.fn();
	const custom = vi.fn(async () => undefined);
	// As in RPC mode: no terminal input to listen to, a status the client may show.
	const ui = { notify, custom, setStatus: vi.fn(), onTerminalInput: () => () => undefined };
	const ctx = { hasUI: true, cwd: process.cwd(), ui } as unknown as ExtensionCommandContext;
	return { ctx, notify, custom };
}

describe("/octocode without a terminal", () => {
	it("shows the real CLI's output as the result, the arguments passed as typed", async () => {
		const { ctx, notify, custom } = headless();
		await octocodeCommand.handler("--version", ctx);
		expect(custom).not.toHaveBeenCalled();
		expect(notify).toHaveBeenCalledWith(`octocode ${resolveOctocodeCli()!.version}`, "info");
	});

	it("has no aliases: `login` reaches the CLI unchanged and the CLI's own answer is the result", async () => {
		const { ctx, notify } = headless();
		await octocodeCommand.handler("login", ctx);
		const [text, level] = notify.mock.calls[0] as [string, string];
		expect(text).toMatch(/login/);
		expect(text).not.toMatch(/needs an interactive terminal/);
		expect(level).toBe("warning");
	});
});

describe("/octocode completions from the CLI's own help", () => {
	it("reads commands and options in both help layouts", () => {
		const help = [
			"Usage: tool [OPTIONS] <COMMAND>",
			"",
			"Commands:",
			"  status  Show the status",
			"  login   Sign in",
			"",
			"Options:",
			"      --json  Print JSON",
			"  -h, --help",
			"          Print help",
			"      --input <FILE>  Read input",
		].join("\n");
		expect(parseCliHelp(help)).toEqual({
			commands: [
				["status", "Show the status"],
				["login", "Sign in"],
			],
			options: [
				["--json", "Print JSON"],
				["--help", "Print help"],
				["--input", "Read input"],
			],
		});
		expect(parseCliHelp("no sections here")).toEqual({ commands: [], options: [] });
	});

	it("completes the real CLI's commands, nested commands and options, with no `login` alias", () => {
		const names = octocodeCommand.complete?.("")?.map((item) => item.value) ?? [];
		expect(names).toEqual(expect.arrayContaining(["auth", "localSearch", "config"]));
		expect(names).not.toContain("login");
		expect(octocodeCommand.complete?.("loc")?.map((item) => item.value)).toEqual(["localSearch", "localFetch"]);
		expect(octocodeCommand.complete?.("auth lo")?.map((item) => item.value)).toEqual(["auth login", "auth logout"]);
		expect(octocodeCommand.complete?.("auth status --j")?.map((item) => item.value)).toEqual(["auth status --json"]);
		// A free argument is never looked up as a command path.
		expect(octocodeCommand.complete?.(`localSearch '{"q":1}' `)).toBeNull();
	});
});

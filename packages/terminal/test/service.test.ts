import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { DriverProcess } from "../src/driver-process.ts";
import { findOnPath } from "@octocodeai/octocode-common/find-on-path";
import { gitBranches } from "../src/git-refs.ts";
import { parseShellLine } from "../src/line.ts";
import { ShellCompletionService, toCompletions } from "../src/service.ts";

const root = mkdtempSync(join(tmpdir(), "octocode-terminal-test-"));
afterAll(() => rmSync(root, { recursive: true, force: true }));
const signal = () => new AbortController().signal;

/** A repository with two branches as loose refs and one packed, made without running git. */
function fakeRepo(): string {
	const repo = join(root, "repo");
	mkdirSync(join(repo, ".git", "refs", "heads", "feature"), { recursive: true });
	writeFileSync(join(repo, ".git", "refs", "heads", "main"), "0".repeat(40));
	writeFileSync(join(repo, ".git", "refs", "heads", "feature", "login"), "0".repeat(40));
	writeFileSync(join(repo, ".git", "packed-refs"), `# pack-refs\n${"1".repeat(40)} refs/heads/release\n`);
	mkdirSync(join(repo, "src"), { recursive: true });
	return repo;
}

describe("gitBranches", () => {
	it("reads loose and packed branches", async () => {
		expect(await gitBranches(join(fakeRepo(), "src"))).toEqual(["feature/login", "main", "release"]);
		expect(await gitBranches(tmpdir())).toEqual([]);
	});
});

describe("toCompletions", () => {
	it("quotes, marks directories and drops a trailing space", () => {
		const result = toCompletions(
			[
				{ value: "my file", description: "", flags: "" },
				{ value: "src", description: "", flags: "d" },
				{ value: "checkout ", description: "Switch", flags: "" },
				{ value: "--out=", description: "", flags: "" },
				{ value: "checkout", description: "", flags: "" },
			],
			parseShellLine("cmd "),
			0,
			"test",
		);
		expect(result.items).toEqual([
			{ value: "my\\ file", label: "my file" },
			{ value: "src/", label: "src/", kind: "directory", noSpace: true },
			{ value: "checkout", label: "checkout", description: "Switch" },
			{ value: "--out=", label: "--out=", noSpace: true },
		]);
		expect(result.start).toBe(4);
	});

	it("keeps an open quote in front of a shell-quoted value and reads a start offset", () => {
		const line = parseShellLine("ls 'my f");
		expect(toCompletions([{ value: "my file'", description: "", flags: "q" }], line, 0, "zsh").items[0].value).toBe(
			"'my file'",
		);
		expect(
			toCompletions([{ value: "Get-Item", description: "", flags: "q@0" }], parseShellLine("Get-I"), 0, "pwsh").start,
		).toBe(0);
	});
});

describe("ShellCompletionService without a shell", () => {
	it("completes PATH programs, branches, and nothing else in an untrusted folder", async () => {
		const bin = join(root, "bin");
		mkdirSync(bin, { recursive: true });
		writeFileSync(join(bin, "octo-tool"), "#!/bin/sh\n", { mode: 0o755 });
		writeFileSync(join(bin, "octo-data"), "", { mode: 0o644 });
		const service = new ShellCompletionService({
			cwd: fakeRepo(),
			env: { PATH: bin },
			shell: "none",
			loadRc: false,
			carapace: true,
			trusted: () => false,
		});
		expect((await service.complete("octo", signal()))?.items.map((item) => item.label)).toEqual(["octo-tool"]);
		expect((await service.complete("git checkout fe", signal()))?.items.map((item) => item.label)).toEqual([
			"feature/login",
		]);
		expect(await service.complete("octo-tool --", signal())).toBeUndefined();
		service.dispose();
	});
});

describe("DriverProcess", () => {
	const script = (body: string) => {
		const file = join(root, `driver-${Math.random().toString(36).slice(2)}.mjs`);
		writeFileSync(file, body);
		return { command: process.execPath, args: [file], env: process.env, cwd: root };
	};

	it("ignores output before READY and answers by id", async () => {
		const driver = new DriverProcess(
			script(`
				import { createInterface } from "node:readline";
				console.log("welcome from rc");
				console.log("\\x1eREADY");
				createInterface({ input: process.stdin }).on("line", (line) => {
					const [id, text] = line.split("\\t");
					console.log("noise");
					console.log(id + "\\t" + text + "-one\\tdesc\\t");
					console.log(id + "\\t\\x1e");
				});
			`),
		);
		expect(await driver.request("abc", signal())).toEqual([{ value: "abc-one", description: "desc", flags: "" }]);
		expect(await driver.request("bad\x01", signal())).toBeUndefined();
		driver.close();
		expect(await driver.request("abc", signal())).toBeUndefined();
	});

	it("gives up on a driver that never starts or stalls", async () => {
		const silent = new DriverProcess(script("setInterval(() => {}, 1000);"), { startMs: 200, stallMs: 200 });
		expect(await silent.whenReady()).toBe(false);
		expect(silent.isClosed).toBe(true);
		const stuck = new DriverProcess(script(`console.log("\\x1eREADY"); setInterval(() => {}, 1000);`), {
			startMs: 2000,
			stallMs: 200,
		});
		expect(await stuck.request("x", signal())).toBeUndefined();
		expect(stuck.isClosed).toBe(true);
	});
});

const zsh = findOnPath("zsh");
const bash = findOnPath("bash");

describe.skipIf(!zsh)("zsh driver", () => {
	it("captures options, descriptions and paths without the user's startup files", async () => {
		const cwd = fakeRepo();
		const service = new ShellCompletionService({
			cwd,
			env: process.env,
			shell: "zsh",
			loadRc: false,
			carapace: false,
			trusted: () => true,
		});
		const kill = await service.complete("kill -", signal());
		expect(kill?.source).toBe("zsh");
		expect(kill?.items.some((item) => item.value === "-KILL")).toBe(true);
		const dir = await service.complete("ls sr", signal());
		expect(dir?.items).toEqual([expect.objectContaining({ value: "src/", kind: "directory", noSpace: true })]);
		const quoted = await service.complete("ls 'sr", signal());
		expect(quoted?.items[0]?.value.startsWith("'src")).toBe(true);
		service.dispose();
	});
});

describe.skipIf(!zsh)("zsh driver with the user's startup files", () => {
	it("loads their completions and never substitutes $(...)", async () => {
		const home = join(root, "zhome");
		mkdirSync(home, { recursive: true });
		writeFileSync(
			join(home, ".zshrc"),
			[
				"autoload -Uz compinit && compinit -i -d $HOME/.zcompdump",
				"zstyle ':completion:*' completer _expand _complete",
				"_octo_demo() { compadd -d '(first\\ word second\\ word)' alpha beta }",
				"compdef _octo_demo octo-demo",
			].join("\n"),
		);
		const env: NodeJS.ProcessEnv = { ...process.env, HOME: home };
		delete env.ZDOTDIR;
		const service = new ShellCompletionService({
			cwd: root,
			env,
			shell: "zsh",
			loadRc: true,
			carapace: false,
			trusted: () => true,
		});
		const demo = await service.complete("octo-demo a", signal());
		expect(demo?.items).toEqual([expect.objectContaining({ value: "alpha" })]);
		const marker = join(root, "expanded");
		await service.complete(`echo $(touch ${marker})`, signal());
		expect(existsSync(marker)).toBe(false);
		service.dispose();
	});
});

describe.skipIf(!bash)("bash driver", () => {
	it("starts and answers a completion defined in the shell", async () => {
		const rc = join(root, "home");
		mkdirSync(rc, { recursive: true });
		writeFileSync(join(rc, ".bashrc"), "complete -W 'alpha beta' octo-demo\n");
		const service = new ShellCompletionService({
			cwd: root,
			env: { ...process.env, HOME: rc },
			shell: "bash",
			loadRc: true,
			carapace: false,
			trusted: () => true,
		});
		const result = await service.complete("echo x; octo-demo al", signal());
		expect(result).toMatchObject({ source: "bash", items: [{ value: "alpha" }] });
		service.dispose();
	});
});

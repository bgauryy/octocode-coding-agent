import fs from "node:fs";
import path from "node:path";
import { fauxAssistantMessage } from "@octocodeai/octocode-ai";
import { afterAll, afterEach, describe, expect, it } from "vitest";
import { NEEDS_APPROVAL } from "../../src/octocode/permission/ask/text.ts";
import { nativeCall } from "./e2e-calls.ts";
import { disposeSessions, headless, restoreEnv, say, type ToolResult } from "./e2e-headless.ts";

/**
 * Behavioral contracts of the permission gate and the `file` tool through a real headless session: a scripted model calls
 * the tools, and each case asserts what reached disk and what the model was told. Only the model provider is faked.
 */
afterEach(disposeSessions);
afterAll(restoreEnv);

type Call = ReturnType<typeof nativeCall>;
const turn =
	(...calls: Call[]) =>
	() =>
		fauxAssistantMessage(calls, { stopReason: "toolUse" });
const write = (target: string, content = "x") =>
	nativeCall("file", { reason: "write", queries: [{ reason: "write", type: "write", path: target, content }] });
const bash = (command: string) => nativeCall("bash", { command });
const exists = (...parts: string[]) => fs.existsSync(path.join(...parts));

/** A headless session whose repository has `link` pointing outside it and `statelink` into Octocode's state folder. */
const start = (mode: "workspace" | "full") =>
	headless({
		env: { OCTOCODE_PERMISSION: mode },
		setup: ({ cwd, outside, home }) => {
			fs.symlinkSync(outside, path.join(cwd, "link"));
			fs.mkdirSync(path.join(home, ".octocode"), { recursive: true });
			fs.symlinkSync(path.join(home, ".octocode"), path.join(cwd, "statelink"));
		},
	});

/** Runs `calls` in one model turn and returns their results in order. */
async function oneTurn(run: Awaited<ReturnType<typeof start>>["run"], calls: Call[]): Promise<ToolResult[]> {
	const [, after] = await run("go", [turn(...calls), say("done")]);
	expect(after).toHaveLength(calls.length);
	return after;
}

const stateTxt = (home: string) => fs.readdirSync(path.join(home, ".octocode")).filter((name) => name.endsWith(".txt"));

describe("file tool: where a change may land", () => {
	it("workspace mode refuses changes outside the repository, through symlinks and into files later sessions run", async () => {
		const { cwd, outside, run } = await start("workspace");
		const targets = [
			"../outside/up.txt",
			"link/via-link.txt",
			".git/hooks/pre-commit",
			"sub/.husky/pre-commit",
			".GIT/hooks/post-merge",
		];
		const results = await oneTurn(
			run,
			targets.map((target) => write(target)),
		);
		for (const result of results) {
			expect(result).toMatchObject({ toolName: "file", isError: true });
			expect(result.text).toContain(NEEDS_APPROVAL);
		}
		expect(fs.readdirSync(outside)).toEqual([]);
		expect(exists(cwd, ".git/hooks/pre-commit")).toBe(false);
		expect(exists(cwd, ".git/hooks/post-merge")).toBe(false);
		expect(exists(cwd, "sub/.husky/pre-commit")).toBe(false);
	}, 60_000);

	it("full mode still refuses Octocode's state folder, by absolute path and through a symlink", async () => {
		const { home, run } = await start("full");
		const results = await oneTurn(run, [
			write(path.join(home, ".octocode", "direct.txt")),
			write("statelink/linked.txt"),
		]);
		for (const result of results) {
			expect(result.isError).toBe(true);
			expect(result.text).toContain("in Octocode's state folder");
		}
		expect(stateTxt(home)).toEqual([]);
	}, 60_000);
});

describe("file tool: read before change", () => {
	it("refuses to overwrite or edit an unread file, and continues a batch after a failed item", async () => {
		const { cwd, run } = await start("full");
		const results = await oneTurn(run, [
			write("app.ts", "clobbered"),
			nativeCall("file", {
				reason: "edit",
				queries: [{ reason: "edit", type: "edit", path: "app.ts", edits: [{ oldText: "41", newText: "42" }] }],
			}),
			nativeCall("file", {
				reason: "batch",
				queries: [
					{ reason: "gone", type: "delete", path: "missing.ts" },
					{ reason: "new", type: "write", path: "new.txt", content: "fresh" },
				],
			}),
		]);
		expect(results[0].isError).toBe(true);
		expect(results[0].text).toContain("was not read in this session");
		expect(results[1].isError).toBe(true);
		expect(results[1].text).toContain("was not read in this session");
		expect(results[2].text).toMatch(/1\. FAILED delete missing\.ts[\s\S]*2\. OK write new\.txt/);
		expect(fs.readFileSync(path.join(cwd, "app.ts"), "utf8")).toBe("export const answer = 41;\n");
		expect(fs.readFileSync(path.join(cwd, "new.txt"), "utf8")).toBe("fresh");
	}, 60_000);

	it("after a bash read, applies an edit; after an outside change, refuses a whole write but re-validates an edit", async () => {
		const { cwd, run } = await start("full");
		const file = path.join(cwd, "app.ts");
		const edit = (oldText: string, newText: string) =>
			nativeCall("file", {
				reason: "edit",
				queries: [{ reason: "edit", type: "edit", path: "app.ts", edits: [{ oldText, newText }] }],
			});
		const turns = await run("go", [
			turn(bash("cat app.ts")),
			turn(edit("41", "42")),
			() => {
				fs.writeFileSync(file, "export const answer = 42; // changed by the user\n");
				return turn(write("app.ts", "model's whole file"))();
			},
			turn(edit("42", "43")),
			say("done"),
		]);
		const [, read, edited, stale, revalidated] = turns;
		expect(read[0]).toMatchObject({ toolName: "bash", isError: false });
		expect(edited[0]).toMatchObject({ toolName: "file", isError: false });
		expect(stale[0].isError).toBe(true);
		expect(stale[0].text).toContain("changed on disk since you last read it");
		expect(revalidated[0].isError).toBe(false);
		expect(fs.readFileSync(file, "utf8")).toBe("export const answer = 43; // changed by the user\n");
	}, 60_000);
});

describe("bash: where a command writes", () => {
	it("workspace mode refuses redirects and tee that leave the repository or reach a hook, and runs none of them", async () => {
		const { cwd, outside, run } = await start("workspace");
		const commands = [
			"echo x > ../outside/redirect.txt",
			"echo x > link/through-link.txt",
			"cd .. && echo x > outside/after-cd.txt",
			"echo x | tee ../outside/tee.txt",
			"echo x &> ../outside/both.txt",
			"echo x 2> ../outside/stderr.txt",
			"echo x >| ../outside/clobber.txt",
			"D=../outside; echo x > $D/dynamic.txt",
			`echo x > ${path.join(outside, "absolute.txt")}`,
			"echo x > .git/hooks/pre-commit",
		];
		const results = await oneTurn(run, commands.map(bash));
		for (const result of results) {
			expect(result.isError).toBe(true);
			expect(result.text.startsWith(NEEDS_APPROVAL)).toBe(true);
		}
		expect(fs.readdirSync(outside)).toEqual([]);
		expect(exists(cwd, ".git/hooks/pre-commit")).toBe(false);
	}, 60_000);

	it("full mode refuses a redirect into Octocode's state folder named by its path", async () => {
		const { home, run } = await start("full");
		const target = path.join(home, ".octocode", "redirect.txt");
		const [result] = await oneTurn(run, [bash(`echo x > ${target}`)]);
		expect(result.isError).toBe(true);
		expect(result.text).toContain("in Octocode's state folder");
		expect(fs.existsSync(target)).toBe(false);
	}, 60_000);

	it("aborting the session stops a running command before it writes, and the model is told it was aborted", async () => {
		const { cwd, run, session } = await start("full");
		let toolStarted = 0;
		const unsubscribe = session.subscribe((event) => {
			if (event.type !== "tool_execution_start" || toolStarted) return;
			toolStarted = Date.now();
			setTimeout(() => void session.abort(), 300);
		});
		await run("go", [turn(bash("sleep 3; echo late > marker")), say("unreached")]);
		unsubscribe();
		expect(toolStarted).toBeGreaterThan(0);
		expect(Date.now() - toolStarted).toBeLessThan(3_000);
		const result = session.messages.find((message) => message.role === "toolResult");
		expect(JSON.stringify(result?.content)).toContain("aborted");
		await new Promise((resolve) => setTimeout(resolve, Math.max(0, toolStarted + 3_500 - Date.now())));
		expect(exists(cwd, "marker")).toBe(false);
	}, 60_000);

	// D1 (.octocode/review/2026-10-31/E-behavioral-tests.md): command operands are write targets too
	// (`permission/shell/write-targets.ts` from `shell/mutation.ts`), not only redirects and `tee`.
	it("workspace mode refuses cp, touch and mv that write outside the repository or install a git hook", async () => {
		const { cwd, outside, run } = await start("workspace");
		const results = await oneTurn(run, [
			bash("cp app.ts .git/hooks/pre-push"),
			bash("cp app.ts ../outside/copied.txt"),
			bash("touch link/touched.txt"),
			bash("cp app.ts tmp.ts && mv tmp.ts ../outside/moved.txt"),
		]);
		for (const result of results) expect(result.text.startsWith(NEEDS_APPROVAL)).toBe(true);
		expect(exists(cwd, ".git/hooks/pre-push")).toBe(false);
		expect(fs.readdirSync(outside)).toEqual([]);
	}, 60_000);

	it("workspace mode refuses writes outside the repository through wrappers, option destinations and cd", async () => {
		const { cwd, outside, run } = await start("workspace");
		const commands = [
			"sh -c 'touch ../outside/sh.txt'",
			'bash -c "cp app.ts ../outside/bash.txt"',
			"eval 'touch ../outside/eval.txt'",
			"echo 'touch ../outside/stdin.txt' | sh",
			"echo ../outside/xargs.txt | xargs touch",
			"find . -name app.ts -exec cp {} ../outside/find.txt \\;",
			"env touch ../outside/env.txt",
			"(cd .. && touch outside/subshell.txt)",
			"install -m 644 app.ts ../outside/install.txt",
			"dd if=app.ts of=../outside/dd.txt",
			"ln -s ../app.ts link/ln.txt",
			"rsync app.ts ../outside/rsync.txt",
			"tar -cf ../outside/archive.tar app.ts",
			"tar -xf archive.tar -C ../outside",
			"git -C ../outside init",
			"git config core.hooksPath ../outside",
		];
		const results = await oneTurn(run, commands.map(bash));
		for (const [index, result] of results.entries())
			expect(result.text.startsWith(NEEDS_APPROVAL), commands[index]).toBe(true);
		expect(fs.readdirSync(outside)).toEqual([]);
		expect(fs.readFileSync(path.join(cwd, ".git/config"), "utf8")).not.toContain("hooksPath");
	}, 60_000);

	it("workspace mode still runs commands that change only the repository", async () => {
		const { cwd, run } = await start("workspace");
		const commands = [
			"cp app.ts copy.ts",
			"mkdir -p sub && touch sub/a.txt",
			"find . -name app.ts -exec grep -l . {} +",
			"git add app.ts",
			"tar -cf repo.tar app.ts",
			"sh -c 'touch inner.txt'",
			// Octocode's scratch folder loads nothing in later sessions, so it is written without asking.
			"mkdir -p .octocode/code/temp/x && cp app.ts .octocode/code/temp/x/",
		];
		const results = await oneTurn(run, commands.map(bash));
		for (const [index, result] of results.entries())
			expect(result.text.startsWith(NEEDS_APPROVAL), commands[index]).toBe(false);
		for (const file of ["copy.ts", "sub/a.txt", "repo.tar", "inner.txt", ".octocode/code/temp/x/app.ts"])
			expect(exists(cwd, file), file).toBe(true);
	}, 60_000);

	// D2 (same report): "no mode skips" the Octocode-home invariant (`permission/mode.ts`): `~` and `$HOME` spellings and
	// command operands reach the state-folder check (`permission/file-access.ts`) before any uncertain target is allowed.
	it("full mode refuses shell writes into Octocode's state folder however the path is spelled", async () => {
		const { home, run } = await start("full");
		const results = await oneTurn(run, [
			bash('echo x > "$HOME/.octocode/dollar-home.txt"'),
			bash("echo x > ~/.octocode/tilde.txt"),
			bash("cp app.ts ~/.octocode/copied.txt"),
			bash("touch statelink/touched.txt"),
			bash('cp app.ts "${HOME}/.octocode/braced.txt"'),
			bash("sh -c 'touch ~/.octocode/sh.txt'"),
			bash("git config --file ~/.octocode/config.txt a.b c"),
		]);
		for (const result of results) expect(result.text).toContain("in Octocode's state folder");
		expect(stateTxt(home)).toEqual([]);
	}, 60_000);
});

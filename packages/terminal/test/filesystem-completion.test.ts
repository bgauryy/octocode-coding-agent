import { chmod, mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { PathCommands } from "../src/executables.ts";
import { ShellCompletionService } from "../src/service.ts";
import { untilAborted } from "../src/abort.ts";

const roots: string[] = [];
afterEach(async () => {
	vi.restoreAllMocks();
	await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

it("shares asynchronous PATH scans, filters executables and refreshes changed PATH values", async () => {
	const root = await mkdtemp(join(tmpdir(), "octocode-path-"));
	roots.push(root);
	const other = join(root, "other");
	await mkdir(other);
	const ext = process.platform === "win32" ? ".cmd" : "";
	await writeFile(join(root, `run-me${ext}`), "echo run", { mode: 0o700 });
	await writeFile(join(other, `other-command${ext}`), "echo other", { mode: 0o700 });
	if (process.platform !== "win32") {
		await writeFile(join(root, "not-executable"), "data", { mode: 0o600 });
		await chmod(join(root, `run-me${ext}`), 0o700);
		await symlink(join(root, `run-me${ext}`), join(root, "alias"));
	}
	const commands = new PathCommands();
	const env = { PATH: [root, root].join(delimiter), PATHEXT: ".CMD" };
	const first = commands.list(env);
	const second = commands.list(env);
	const [a, b] = await Promise.all([first, second]);
	expect(a).toBe(b);
	expect(a).toEqual(process.platform === "win32" ? ["run-me"] : ["alias", "run-me"]);
	expect(await commands.list(env)).toBe(a);
	expect(await commands.list({ PATH: other, PATHEXT: ".CMD" })).toEqual(["other-command"]);
});

it("cancels a completion whose shared PATH scan has not settled, then allows a new query", async () => {
	let finish!: (names: string[]) => void;
	const scan = new Promise<string[]>((resolve) => {
		finish = resolve;
	});
	vi.spyOn(PathCommands.prototype, "list").mockReturnValue(scan);
	const service = new ShellCompletionService({
		cwd: tmpdir(),
		env: {},
		trusted: () => false,
		shell: "none",
		loadRc: false,
		carapace: false,
	});
	const controller = new AbortController();
	const old = service.complete("r", controller.signal);
	controller.abort();
	expect(await old).toBeUndefined();
	const next = service.complete("ru", new AbortController().signal);
	finish(["run-me"]);
	expect(await next).toMatchObject({ source: "path", items: [{ value: "run-me", label: "run-me" }] });
	service.dispose();
});

it("observes a shared scan that fails after its waiter was canceled", async () => {
	let fail!: (error: Error) => void;
	const scan = new Promise<never>((_resolve, reject) => {
		fail = reject;
	});
	const controller = new AbortController();
	const waiting = untilAborted(scan, controller.signal);
	controller.abort();
	expect(await waiting).toBeUndefined();
	fail(new Error("late scan failure"));
	await new Promise((resolve) => setImmediate(resolve));
});

import { registeredWorkspace } from "../../src/storage/workspace-database.ts";
import { BacklogStore } from "../../src/octocode/backlog/store.ts";
import { fixtureBacklog } from "./backlog-fixture.ts";
import { webCommand } from "../../src/octocode/workspace/command.ts";
import { startWorkspaceWeb } from "../../src/octocode/workspace/server.ts";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { KeybindingsManager } from "../../src/core/keybindings.ts";
import { closeSharedAgentDb } from "../../../db/src/api.ts";
import { sharedAgentDb } from "../../src/storage/database.ts";
import { embeddedJson, renderBacklogHtml } from "@octocodeai/octocode-webview";
import { type Snapshot, STATES } from "@octocodeai/octocode-contracts/snapshot";
import { registerBacklog } from "../../src/octocode/backlog/index.ts";
import { backlogSnapshot } from "../../src/octocode/backlog/snapshot.ts";
import { Subcommands } from "../../src/octocode/shared/commands.ts";
import { fakeCtx, fakeHost, theme } from "./fake-host.ts";

const SECRET = `ghp_${"a1B2c3D4e5".repeat(4)}`;
const NOW = Date.UTC(2026, 9, 15, 12, 0, 0);
const XSS = "</script><img src=x onerror=alert(1)>";
const LINE_SEPARATORS = "a\u2028b\u2029c";

let tmp: string;
let savedDb: string | undefined;

beforeEach(() => {
	tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "octo-backlog-html-")));
	savedDb = process.env.OCTOCODE_AGENT_DB;
	process.env.OCTOCODE_AGENT_DB = path.join(tmp, "home", "octocode.db");
});

afterEach(() => {
	closeSharedAgentDb();
	if (savedDb === undefined) delete process.env.OCTOCODE_AGENT_DB;
	else process.env.OCTOCODE_AGENT_DB = savedDb;
	fs.rmSync(tmp, { recursive: true, force: true });
});

const storeFor = (repo: string) => fixtureBacklog(() => sharedAgentDb(), repo);

/** The JSON block of a page, parsed back, and the page script. */
function parts(html: string): { data: Snapshot; script: string } {
	const data = /<script type="application\/json" id="data">([\s\S]*?)<\/script>/.exec(html)?.[1];
	const script = /<script>([\s\S]*?)<\/script>/.exec(html)?.[1];
	expect(data).toBeDefined();
	expect(script).toBeDefined();
	return { data: JSON.parse(data!) as Snapshot, script: script! };
}

/** One item in every state, notes of both kinds, and a derivation chain. */
function populate(store: BacklogStore): void {
	store.add({
		title: "root",
		goal: "g",
		state: "backlog",
		createdBy: "agent",
		tags: ["one", "two"],
		paths: ["src/a.ts"],
		evidence: ["a:1 — x"],
		why: "because",
		plan: "steps",
	});
	store.add({
		title: "child",
		goal: "g",
		why: "Required work",
		state: "todo",
		createdBy: "agent",
		from: "B1",
	});
	store.add({
		title: "grandchild",
		goal: "g",
		why: "Required work",
		state: "todo",
		createdBy: "agent",
		from: "B2",
		priority: 0,
	});
	store.add({
		title: "working",
		goal: "g",
		why: "Required work",
		state: "todo",
		createdBy: "agent",
		from: "B1",
	});
	store.update("B4", { state: "ongoing", note: "started it" }, { id: "session-live" });
	store.add({ title: "finished", goal: "g", why: "Required work", state: "todo", createdBy: "user" });
	store.update("B5", { state: "ongoing" }, { id: "session-live" });
	store.update(
		"B5",
		{
			state: "done",
			completion: {
				summary: "did it",
				files: [],
				verification: { status: "passed", summary: "checked by running x" },
				operationKey: "done",
			},
			note: "did it; checked by running x",
		},
		{ id: "session-live" },
	);
}

describe("backlog snapshot", () => {
	it("holds every item in every state with every note, link and derived ref, uncut", () => {
		const store = storeFor("snap");
		populate(store);
		// Notes far past the tool's default page of 10, with long text.
		const long = "x".repeat(5000);
		for (let index = 0; index < 25; index++) store.update("B1", { note: `note ${index} ${long}` }, { id: "agent-1" });
		const snapshot = backlogSnapshot(store, "snap-repo", NOW, "session-live");
		expect(snapshot).toMatchObject({ repo: "snap-repo", generatedAt: NOW, states: STATES });
		expect(snapshot.items.map((item) => item.ref).sort()).toEqual(["B1", "B2", "B3", "B4", "B5"]);
		expect(new Set(snapshot.items.map((item) => item.state))).toEqual(new Set(STATES));
		const ref = (name: string) => snapshot.items.find((item) => item.ref === name)!;
		expect(ref("B1").notes).toHaveLength(store.noteCount(store.get("B1")!));
		expect(ref("B1").notes.filter((note) => note.kind === "note")).toHaveLength(25);
		expect(ref("B1").notes.at(-1)!.text).toBe(`note 24 ${long}`);
		expect(ref("B2").notes[0]).toMatchObject({ kind: "change", text: "created from B1" });
		expect(ref("B4").notes.map((note) => note.kind)).toEqual(["change", "change", "note"]);
		expect(ref("B1")).toMatchObject({
			derived: expect.arrayContaining(["B2", "B4"]),
			title: "root",
			tags: ["one", "two"],
			paths: ["src/a.ts"],
			evidence: ["a:1 — x"],
			why: "because",
			plan: "steps",
			priority: "p2",
		});
		expect(ref("B1").derived).toHaveLength(2);
		expect(ref("B2")).toMatchObject({ from: "B1", derived: ["B3"] });
		expect(ref("B3")).toMatchObject({ from: "B2", priority: "p0" });
		expect(ref("B5")).toMatchObject({ state: "done" });
		expect(ref("B5").doneAt).toBeGreaterThan(0);
		expect(ref("B5").startedAt).toBeGreaterThan(0);
	});

	it("marks an assignee live when it is the writing session or a running one, not a finished one", () => {
		const db = sharedAgentDb();
		db.db.prepare("INSERT INTO sessions (id, pid) VALUES (?, ?)").run("session-running", process.ppid);
		db.db.prepare("INSERT INTO sessions (id, pid) VALUES (?, ?)").run("session-gone", null);
		const store = storeFor("live");
		for (const holder of ["session-running", "session-gone", "session-self"]) {
			store.add({ title: holder, goal: "g", why: "Required work", state: "todo", createdBy: "agent" });
			store.update(`B${store.list().total}`, { state: "ongoing" }, { id: holder });
		}
		const live = Object.fromEntries(
			backlogSnapshot(store, "r", NOW, "session-self").items.map((item) => [item.assignee, item.assigneeLive]),
		);
		expect(live).toEqual({ "session-running": true, "session-gone": false, "session-self": true });
	});

	it("refuses to snapshot text that looks like a secret, naming the item and the field", () => {
		const store = storeFor("secret");
		populate(store);
		const raw = sharedAgentDb().db;
		// Text stored before the write-time check, or by another build, bypasses `refuseSecrets`: plant it directly.
		raw.prepare("UPDATE backlog SET body = ? WHERE seq = 3 AND workspace_id = 'secret'").run(`token at ${SECRET}`);
		expect(() => backlogSnapshot(store, "r", NOW)).toThrow(
			/Not written: the body of B3 looks like it contains a GitHub token/,
		);
		raw.prepare("UPDATE backlog SET body = '' WHERE seq = 3 AND workspace_id = 'secret'").run();
		const item = store.get("B2")!;
		raw
			.prepare("INSERT INTO backlog_notes (item, at, author, kind, text) VALUES (?, 1, 'agent', 'note', ?)")
			.run(item.rowId, `see ${SECRET}`);
		expect(() => backlogSnapshot(store, "r", NOW)).toThrow(
			/Not written: the note \d+ of B2 looks like it contains a GitHub token/,
		);
		expect(() => backlogSnapshot(store, SECRET, NOW)).toThrow(/Not written: the repository name/);
	});
});

describe("backlog html page", () => {
	/** The store sanitizes text it writes (U+2028 becomes a visible escape), so rows another build wrote are planted directly. */
	const snapshotWith = (title: string, note: string): Snapshot => {
		const store = storeFor("xss");
		store.add({
			title: "placeholder",
			goal: "g",
			why: "Required work",
			state: "todo",
			createdBy: "agent",
			tags: ["t"],
		});
		const raw = sharedAgentDb().db;
		raw
			.prepare("UPDATE backlog SET title = ?, body = ? WHERE seq = 1 AND workspace_id = 'xss'")
			.run(title, `${title}\n${note}`);
		raw
			.prepare("INSERT INTO backlog_notes (item, at, author, kind, text) VALUES (?, 1, 'agent-1', 'note', ?)")
			.run(store.get("B1")!.rowId, note);
		return backlogSnapshot(store, "repo", NOW);
	};

	it("cannot be closed or broken by item text: </script>, markup, U+2028 and U+2029 stay inside the JSON", () => {
		const snapshot = snapshotWith(`${XSS} ${LINE_SEPARATORS}`, `${XSS}\n<!-- ${LINE_SEPARATORS}`);
		const html = renderBacklogHtml(snapshot);
		expect(html).not.toContain("<img");
		expect(html).not.toContain("<!--");
		expect(html).not.toMatch(/[\u2028\u2029]/);
		// Only the page's own two script elements close.
		expect(html.match(/<\/script/g)).toHaveLength(2);
		expect(html).toContain("\\u003c/script>\\u003cimg src=x onerror=alert(1)>");
		expect(html).toContain("a\\u2028b\\u2029c");
		// The data reads back exactly.
		expect(parts(html).data).toEqual(JSON.parse(JSON.stringify(snapshot)));
		expect(parts(html).data.items[0].title).toBe(`${XSS} ${LINE_SEPARATORS}`);
		expect(embeddedJson({ a: "<" })).toBe('{"a":"\\u003c"}');
	});

	it("is one offline page: a CSP that allows only inline script and style, no URL, no network, light and dark", () => {
		const html = renderBacklogHtml(snapshotWith("t", "n"));
		const csp = /<meta http-equiv="Content-Security-Policy" content="([^"]+)">/.exec(html)?.[1];
		expect(csp).toContain("default-src 'none'");
		expect(csp).toContain("script-src 'unsafe-inline'");
		expect(csp).toContain("style-src 'unsafe-inline'");
		expect(csp).toContain("img-src data:");
		expect(csp).not.toMatch(/https?:|\*/);
		expect(html).toContain("prefers-color-scheme: dark");
		// The inline script carries React DOM's namespace URIs and error links as plain strings; the markup has no URL.
		// The one link is the inline favicon, a data URI that loads nothing.
		const icons = html.match(/<link rel="icon" type="image\/png" href="data:image\/png;base64,[A-Za-z0-9+/=]+">/g);
		expect(icons).toHaveLength(1);
		const markup = html.replace(/<script>[\s\S]*?<\/script>/, "<script></script>").replace(icons![0], "");
		expect(markup).not.toMatch(/https?:\/\//);
		expect(markup).not.toMatch(/<(?:link|iframe|form|object|embed)\b|\bsrc=/);
		expect(html).not.toMatch(/\bfetch\(|XMLHttpRequest|WebSocket|EventSource|sendBeacon|importScripts|import\(/);
	});

	it("has a script that parses and renders data only through createElement and text nodes", () => {
		const { script } = parts(renderBacklogHtml(snapshotWith("t", "n")));
		// Parse only (the function is never called): a syntax error in the template fails here, not in a user's browser.
		// oxlint-disable-next-line typescript/no-implied-eval -- parses the page script to catch template syntax errors; never called
		expect(() => new Function(script)).not.toThrow();
		// React DOM contains HTML-sink code paths this page never uses. webview/test/security.test.ts keeps every sink out
		// of the renderer's source and runs this page on hostile data with each sink and network API trapped.
		expect(script).toContain("createElement");
		expect(script).toContain("createTextNode");
		expect(script).toContain("JSON.parse");
		expect(script).toContain("getElementById");
		// Every view and the deep link are present.
		for (const view of ["Board", "Table", "Tree", "Attention", "hashchange", "idleMs", "assigneeLive"])
			expect(script, view).toContain(view);
	});
});

describe("/backlog html", () => {
	function setup(open: (file: string) => Promise<void>) {
		const fake = fakeHost();
		const commands = new Subcommands();
		const backlogWeb = registerBacklog(fake.api, {
			commands,
			isSubagent: false,
			open,
			openWeb: (_ctx, backlog, changed) => startWorkspaceWeb(backlog, changed),
		});
		commands.add("web", webCommand(backlogWeb.open));
		const cwd = path.join(tmp, "repo");
		fs.mkdirSync(cwd, { recursive: true });
		return {
			...fake,
			commands,
			cwd,
			command: commands.get("backlog")!,
			store: new BacklogStore(() => sharedAgentDb(), registeredWorkspace(cwd).id),
		};
	}

	it("opens the live board by default and closes its server with the session", async () => {
		const open = vi.fn(async (_url: string) => undefined);
		const t = setup(open);
		const ctx = fakeCtx({ cwd: t.cwd });
		await t.command.handler("", ctx);
		const url = new URL(open.mock.calls[0][0]);
		expect(url.hostname).toBe("127.0.0.1");
		expect(url.hash).toMatch(/^#access=/);
		expect((await fetch(url.origin)).status).toBe(200);
		// `/backlog` runs `/web backlogs`: the same page and the same words.
		expect(new URLSearchParams(url.hash.slice(1)).get("view")).toBe("board");
		expect(ctx.ui.notes.at(-1)?.message).toContain("Opened the web workspace at");
		await t.fire("session_shutdown", {}, ctx);
		await expect(fetch(url.origin)).rejects.toThrow();
	});

	it("opens Activity and Backlogs in the same SPA server, including concurrent requests", async () => {
		const open = vi.fn(async (_url: string) => undefined);
		const t = setup(open);
		const ctx = fakeCtx({ cwd: t.cwd });
		try {
			await Promise.all([t.commands.get("web")!.handler("", ctx), t.command.handler("", ctx)]);
			const urls = open.mock.calls.map(([url]) => new URL(url));
			expect(urls[0].origin).toBe(urls[1].origin);
			expect(urls.map((url) => new URLSearchParams(url.hash.slice(1)).get("view"))).toEqual(["activity", "board"]);
			expect(urls.every((url) => !url.search)).toBe(true);
			await t.commands.get("web")!.handler("backlogs", ctx);
			expect(open.mock.calls[2][0]).toBe(urls[1].href);
			await t.commands.get("web")!.handler("unknown", ctx);
			expect(open).toHaveBeenCalledTimes(3);
			expect(ctx.ui.notes.at(-1)?.message).toBe("Usage: /web [backlogs | item <id>]");
			await t.fire("session_start", {}, ctx);
			await expect(fetch(urls[0].origin)).rejects.toThrow();
			await t.commands.get("web")!.handler("", ctx);
			expect(new URL(open.mock.calls[3][0]).hash).not.toBe(urls[0].hash);
		} finally {
			await t.fire("session_shutdown", {}, ctx);
		}
	});

	it.each(["html"])(
		"command %s writes <repo>/.octocode/agent/backlog.html atomically with every item, opens it with a UI and says where it is",
		async (command) => {
			const open = vi.fn(async () => undefined);
			const t = setup(open);
			populate(t.store);
			const ctx = fakeCtx({ cwd: t.cwd });
			await t.command.handler(command, ctx);
			const file = path.join(fs.realpathSync(t.cwd), ".octocode", "agent", "backlog.html");
			expect(open).toHaveBeenCalledExactlyOnceWith(file);
			expect(ctx.ui.notes.at(-1)!.message).toContain(file);
			expect(ctx.ui.notes.at(-1)!.message).toMatch(/snapshot, not live/);
			const { data } = parts(fs.readFileSync(file, "utf8"));
			expect(data.items).toHaveLength(t.store.list().total);
			expect(data.items.flatMap((item) => item.notes)).toHaveLength(
				t.store.list().items.reduce((sum, item) => sum + t.store.noteCount(item), 0),
			);
			// No temp file is left beside it.
			expect(fs.readdirSync(path.dirname(file)).filter((name) => name.endsWith(".tmp"))).toEqual([]);
		},
	);

	it("only writes without a UI, and names the file when the opener fails", async () => {
		const open = vi.fn(async () => undefined);
		const t = setup(open);
		t.store.add({ title: "one", state: "todo", createdBy: "user" });
		const headless = fakeCtx({ cwd: t.cwd, hasUI: false });
		const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
		await t.command.handler("html", headless);
		stderr.mockRestore();
		expect(open).not.toHaveBeenCalled();
		expect(headless.ui.notes.at(-1)!.message).toMatch(/^Wrote .*backlog\.html/);
		expect(fs.existsSync(path.join(fs.realpathSync(t.cwd), ".octocode", "agent", "backlog.html"))).toBe(true);

		const failing = setup(async () => {
			throw new Error("spawn xdg-open ENOENT");
		});
		const ctx = fakeCtx({ cwd: failing.cwd });
		await failing.command.handler("html", ctx);
		expect(ctx.ui.notes.at(-1)).toMatchObject({
			type: "warning",
			message: expect.stringMatching(/backlog\.html but could not open it: spawn xdg-open ENOENT/),
		});
	});

	it("refuses to write when an item holds a secret, and leaves an earlier page untouched", async () => {
		const open = vi.fn(async () => undefined);
		const t = setup(open);
		t.store.add({ title: "one", state: "todo", createdBy: "user" });
		const file = path.join(fs.realpathSync(t.cwd), ".octocode", "agent", "backlog.html");
		await t.command.handler("html", fakeCtx({ cwd: t.cwd }));
		const before = fs.readFileSync(file, "utf8");
		sharedAgentDb().db.prepare("UPDATE backlog SET why = ? WHERE seq = 1").run(`key ${SECRET}`);
		const ctx = fakeCtx({ cwd: t.cwd });
		await t.command.handler("html", ctx);
		expect(ctx.ui.notes.at(-1)).toMatchObject({
			type: "error",
			message: expect.stringMatching(/HTML export failed: Not written: the why of B1/),
		});
		expect(open).toHaveBeenCalledTimes(1);
		expect(fs.readFileSync(file, "utf8")).toBe(before);
		expect(fs.readFileSync(file, "utf8")).not.toContain(SECRET);
	});

	it("rejects extra arguments, lists itself in the usage and completes", async () => {
		const open = vi.fn(async () => undefined);
		const t = setup(open);
		const ctx = fakeCtx({ cwd: t.cwd });
		await t.command.handler("html now", ctx);
		expect(ctx.ui.notes.at(-1)).toMatchObject({ type: "warning", message: "Usage: /backlog html" });
		expect(open).not.toHaveBeenCalled();
		expect(t.command.argumentHint).toMatch(/\bhtml\b/);
		expect(t.commands.complete("backlog h")).toEqual([expect.objectContaining({ value: "backlog html" })]);
	});

	it('is in the select-list picker as "Open as HTML"', async () => {
		const open = vi.fn(async () => undefined);
		const t = setup(open);
		t.store.add({ title: "one", state: "todo", createdBy: "user" });
		const ctx = fakeCtx({ cwd: t.cwd, mode: "rpc", ui: { selects: ["Open as HTML", undefined] } });
		await t.command.handler("tui", ctx);
		expect(open).toHaveBeenCalledExactlyOnceWith(
			path.join(fs.realpathSync(t.cwd), ".octocode", "agent", "backlog.html"),
		);
	});

	it("opens from the board with a configured HTML action key", async () => {
		const open = vi.fn(async () => undefined);
		const t = setup(open);
		t.store.add({ title: "one", state: "todo", createdBy: "user" });
		let boards = 0;
		const tui = { requestRender: () => undefined, terminal: { rows: 40, columns: 100 } };
		const ctx = fakeCtx({
			cwd: t.cwd,
			ui: {
				custom: (factory) =>
					new Promise((resolve) => {
						const board = factory(tui, theme, new KeybindingsManager({ "app.backlog.html": "o" }), resolve);
						board.handleInput("h");
						board.handleInput(boards++ === 0 ? "o" : "q");
					}),
			},
		});
		await t.command.handler("tui", ctx);
		expect(boards).toBe(2);
		expect(open).toHaveBeenCalledTimes(1);
	});
});

describe("backlog store fixes found by the HTML review", () => {
	it("keeps a title on one line, however the title arrives", () => {
		const store = storeFor("title");
		expect(
			store.add({ title: "  two\nlines\t here  ", goal: "g", why: "Required work", createdBy: "agent" }).title,
		).toBe("two lines here");
		expect(store.update("B1", { title: "a\n\nb" }, { id: "agent" }).title).toBe("a b");
		expect(() => store.update("B1", { title: " \n " }, { id: "agent" })).toThrow(/needs a title/);
	});
});

import fs from "node:fs";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { TeamStore } from "../../src/octocode/team/store.ts";
import { fixture } from "./permission-session-fixture.ts";

afterEach(() => vi.unstubAllEnvs());
const decision = (updatedInput: unknown) => ({
	hookSpecificOutput: {
		hookEventName: "PermissionRequest",
		decision: { behavior: "allow", updatedInput },
	},
});
function replaceHook(f: Awaited<ReturnType<typeof fixture>>, output: unknown) {
	fs.writeFileSync(
		path.join(f.root, "hook.cjs"),
		`const fs=require('node:fs');let s='';process.stdin.on('data',x=>s+=x);process.stdin.on('end',()=>{fs.appendFileSync(${JSON.stringify(f.capture)},s+'\\n');console.log(${JSON.stringify(JSON.stringify(output))});});`,
	);
}
const write = (target: string, content = "ORIGINAL") => ({
	type: "write",
	path: target,
	content,
	reason: "File rewrite acceptance",
});
it("Claude Write permission replacement writes only its new path and content", async () => {
	const f = await fixture("claude");
	try {
		const original = path.join(f.cwd, "original.txt"),
			replacement = path.join(f.cwd, "replacement.txt");
		replaceHook(f, decision({ file_path: replacement, content: "REWRITTEN" }));
		await f.run("file", { queries: [write(original)] });
		expect(fs.existsSync(original)).toBe(false);
		expect(fs.readFileSync(replacement, "utf8")).toBe("REWRITTEN");
		expect(f.inputs()).toHaveLength(1);
		expect(f.session.messages.findLast((m) => m.role === "toolResult")).toMatchObject({ isError: false });
	} finally {
		await f.close();
	}
});

function indexedHook(f: Awaited<ReturnType<typeof fixture>>, outputs: Record<string, unknown>) {
	const table = JSON.stringify(outputs);
	fs.writeFileSync(
		path.join(f.root, "hook.cjs"),
		`const fs=require('node:fs'),path=require('node:path');let s='';process.stdin.on('data',x=>s+=x);process.stdin.on('end',()=>{fs.appendFileSync(${JSON.stringify(f.capture)},s+'\\n');console.log(JSON.stringify((${table})[path.basename(JSON.parse(s).tool_input.file_path)]||{hookSpecificOutput:{hookEventName:'PermissionRequest',decision:{behavior:'allow'}}}));});`,
	);
}
for (const boundary of ["deny", "ask", "unread"] as const) {
	it(`a later ${boundary} replacement leaves every original batch write untouched`, async () => {
		const f = await fixture("claude", {
			rules: boundary === "unread" ? {} : { [boundary]: ["Edit(./replacement.txt)"] },
		});
		try {
			const first = path.join(f.cwd, "first.txt"),
				second = path.join(f.cwd, "second.txt"),
				target = path.join(f.cwd, "replacement.txt");
			if (boundary === "unread") fs.writeFileSync(target, "BEFORE");
			indexedHook(f, {
				"second.txt": decision({ file_path: target, content: "REWRITTEN" }),
			});
			await f.run("file", {
				queries: [write(first, "FIRST"), write(second, "SECOND")],
			});
			expect(fs.existsSync(first)).toBe(false);
			expect(fs.existsSync(second)).toBe(false);
			expect(fs.existsSync(target) ? fs.readFileSync(target, "utf8") : null).toBe(
				boundary === "unread" ? "BEFORE" : null,
			);
			expect(
				f
					.inputs()
					.map((x) => path.basename((x.tool_input as { file_path: string }).file_path))
					.sort(),
			).toEqual(["first.txt", "second.txt"]);
			expect(f.session.messages.findLast((m) => m.role === "toolResult")).toMatchObject({ isError: true });
		} finally {
			await f.close();
		}
	});
}
it("two indexed Write replacements preserve their own path and content", async () => {
	const f = await fixture("claude");
	try {
		const a = path.join(f.cwd, "a.txt"),
			b = path.join(f.cwd, "b.txt"),
			ra = path.join(f.cwd, "ra.txt"),
			rb = path.join(f.cwd, "rb.txt");
		indexedHook(f, {
			"a.txt": decision({ file_path: ra, content: "A_REPLACED" }),
			"b.txt": decision({ file_path: rb, content: "B_REPLACED" }),
		});
		await f.run("file", { queries: [write(a, "A"), write(b, "B")] });
		expect(fs.existsSync(a)).toBe(false);
		expect(fs.existsSync(b)).toBe(false);
		expect(fs.readFileSync(ra, "utf8")).toBe("A_REPLACED");
		expect(fs.readFileSync(rb, "utf8")).toBe("B_REPLACED");
	} finally {
		await f.close();
	}
});
for (const kind of ["write", "edit"] as const) {
	it(`unread existing ${kind} input is refused before PermissionRequest`, async () => {
		const f = await fixture("claude");
		try {
			const target = path.join(f.cwd, "original.txt");
			fs.writeFileSync(target, "BEFORE");
			replaceHook(
				f,
				decision({
					file_path: target,
					...(kind === "write" ? { content: "REWRITTEN" } : { old_string: "BEFORE", new_string: "REWRITTEN" }),
				}),
			);
			await f.run("file", {
				queries: [
					kind === "write"
						? write(target)
						: {
								type: "edit",
								path: target,
								edits: [{ oldText: "BEFORE", newText: "ORIGINAL" }],
								reason: "Edit acceptance",
							},
				],
			});
			expect(fs.readFileSync(target, "utf8")).toBe("BEFORE");
			expect(f.inputs()).toHaveLength(0);
			expect(f.session.messages.findLast((m) => m.role === "toolResult")).toMatchObject({ isError: true });
		} finally {
			await f.close();
		}
	});
}
it("a real prior read permits Edit replacement while preserving exact source fields", async () => {
	const f = await fixture("claude", { fileReadTool: true });
	try {
		const target = path.join(f.cwd, "original.txt");
		fs.writeFileSync(target, "BEFORE");
		await f.run("read", { path: target });
		replaceHook(
			f,
			decision({
				file_path: target,
				old_string: "BEFORE",
				new_string: "REWRITTEN",
				replace_all: false,
			}),
		);
		await f.run("file", {
			queries: [
				{
					type: "edit",
					path: target,
					edits: [{ oldText: "BEFORE", newText: "ORIGINAL" }],
					reason: "Edit acceptance",
				},
			],
		});
		expect(fs.readFileSync(target, "utf8")).toBe("REWRITTEN");
		expect(f.inputs()).toHaveLength(1);
		expect(f.inputs()[0]).toMatchObject({
			tool_name: "Edit",
			tool_input: {
				file_path: target,
				old_string: "BEFORE",
				new_string: "ORIGINAL",
			},
		});
	} finally {
		await f.close();
	}
});

it("PostToolUse receives the effective indexed Write inputs", async () => {
	const f = await fixture("claude");
	try {
		const original = path.join(f.cwd, "original.txt"),
			target = path.join(f.cwd, "replacement.txt"),
			capture = path.join(f.root, "post.jsonl"),
			script = path.join(f.root, "post.cjs");
		replaceHook(f, decision({ file_path: target, content: "REWRITTEN" }));
		fs.writeFileSync(
			script,
			`const fs=require('node:fs');let s='';process.stdin.on('data',x=>s+=x);process.stdin.on('end',()=>fs.appendFileSync(${JSON.stringify(capture)},s+'\\n'));`,
		);
		const config = path.join(f.configDir, "settings.json"),
			settings = JSON.parse(fs.readFileSync(config, "utf8"));
		const quote = (s: string) => `'${s.replaceAll("'", "'\\''")}'`;
		settings.hooks.PostToolUse = [
			{
				matcher: "Write",
				hooks: [
					{
						type: "command",
						command: `${quote(process.execPath)} ${quote(script)}`,
					},
				],
			},
		];
		fs.writeFileSync(config, JSON.stringify(settings));
		await f.session.reload();
		await f.run("file", { queries: [write(original)] });
		expect(fs.existsSync(original)).toBe(false);
		expect(fs.readFileSync(target, "utf8")).toBe("REWRITTEN");
		const posts = fs
			.readFileSync(capture, "utf8")
			.trim()
			.split("\n")
			.map((s) => JSON.parse(s));
		expect(posts).toHaveLength(1);
		expect(posts[0]).toMatchObject({
			tool_name: "Write",
			tool_input: { file_path: target, content: "REWRITTEN" },
		});
	} finally {
		await f.close();
	}
});

it("real read evidence permits the unchanged native Edit control", async () => {
	const f = await fixture("claude", { fileReadTool: true });
	try {
		const target = path.join(f.cwd, "original.txt");
		fs.writeFileSync(target, "BEFORE");
		await f.run("read", { path: target });
		expect(f.session.messages.findLast((m) => m.role === "toolResult")).toMatchObject({ isError: false });
		await f.run("file", {
			queries: [
				{
					type: "edit",
					path: target,
					edits: [{ oldText: "BEFORE", newText: "ORIGINAL" }],
					reason: "Read evidence control",
				},
			],
		});
		expect(fs.readFileSync(target, "utf8")).toBe("ORIGINAL");
	} finally {
		await f.close();
	}
});

it("overlapping rewritten targets refuse the whole staged batch", async () => {
	const f = await fixture("claude");
	try {
		const a = path.join(f.cwd, "a.txt"),
			b = path.join(f.cwd, "b.txt"),
			target = path.join(f.cwd, "shared.txt");
		indexedHook(f, {
			"a.txt": decision({ file_path: target, content: "A" }),
			"b.txt": decision({ file_path: target, content: "B" }),
		});
		await f.run("file", { queries: [write(a), write(b)] });
		for (const file of [a, b, target])
			expect(
				fs.existsSync(file),
				file + "\n" + JSON.stringify(f.session.messages.findLast((m) => m.role === "toolResult")),
			).toBe(false);
		expect(f.session.messages.findLast((m) => m.role === "toolResult")).toMatchObject({ isError: true });
	} finally {
		await f.close();
	}
});
it("an empty Write replacement retains original fields and rechecks the original source ask", async () => {
	const f = await fixture("claude", {
		rules: { ask: ["Write"] },
		output: decision({}),
	});
	try {
		const target = path.join(f.cwd, "original.txt");
		await f.run("file", { queries: [write(target)] });
		expect(fs.existsSync(target)).toBe(false);
		expect(f.inputs()).toHaveLength(1);
		expect(f.session.messages.findLast((m) => m.role === "toolResult")).toMatchObject({ isError: true });
	} finally {
		await f.close();
	}
});
it("empty Write replacement without a source ask retains original path and content", async () => {
	const f = await fixture("claude", { output: decision({}) });
	try {
		const target = path.join(f.cwd, "original.txt");
		await f.run("file", { queries: [write(target)] });
		expect(fs.readFileSync(target, "utf8")).toBe("ORIGINAL");
		expect(f.inputs()).toHaveLength(1);
	} finally {
		await f.close();
	}
});
it("Edit replacement to an unread target preserves both existing files", async () => {
	const f = await fixture("claude", { fileReadTool: true });
	try {
		const original = path.join(f.cwd, "original.txt"),
			target = path.join(f.cwd, "replacement.txt");
		fs.writeFileSync(original, "BEFORE");
		fs.writeFileSync(target, "BEFORE");
		await f.run("read", { path: original });
		replaceHook(
			f,
			decision({
				file_path: target,
				old_string: "BEFORE",
				new_string: "REWRITTEN",
			}),
		);
		await f.run("file", {
			queries: [
				{
					type: "edit",
					path: original,
					edits: [{ oldText: "BEFORE", newText: "ORIGINAL" }],
					reason: "Unread candidate",
				},
			],
		});
		expect(fs.readFileSync(original, "utf8")).toBe("BEFORE");
		expect(fs.readFileSync(target, "utf8")).toBe("BEFORE");
		expect(f.inputs()).toHaveLength(1);
		expect(f.session.messages.findLast((m) => m.role === "toolResult")).toMatchObject({ isError: true });
	} finally {
		await f.close();
	}
});
it("cancelling a later indexed permission hook commits none of the selected batch", async () => {
	const f = await fixture("claude", { hold: true });
	try {
		const first = path.join(f.cwd, "first.txt"),
			second = path.join(f.cwd, "second.txt");
		const script = path.join(f.root, "hook.cjs"),
			text = fs.readFileSync(script, "utf8");
		fs.writeFileSync(script, text.replace("if(true)", "if(JSON.parse(s).tool_input.file_path.endsWith('second.txt'))"));
		const running = f.run("file", { queries: [write(first), write(second)] });
		await vi.waitFor(() => expect(f.inputs()).toHaveLength(2));
		await f.session.abort();
		await running;
		expect(fs.existsSync(first)).toBe(false);
		expect(fs.existsSync(second)).toBe(false);
		expect(f.providerRequests).toBe(1);
		const pid = Number(fs.readFileSync(path.join(f.root, "hook.pid"), "utf8"));
		expect(() => process.kill(pid, 0)).toThrow();
	} finally {
		fs.writeFileSync(path.join(f.root, "release"), "");
		await f.close();
	}
});

it("a later candidate reserved in the real team store prevents all batch effects", async () => {
	const f = await fixture("claude");
	const store = TeamStore.open(f.cwd);
	try {
		const first = path.join(f.cwd, "first.txt"),
			second = path.join(f.cwd, "second.txt"),
			target = path.join(f.cwd, "reserved.txt");
		expect(
			store.join({
				id: "acceptance-other-owner",
				role: "worker",
				pid: process.pid,
				status: "idle",
				joinedAt: Date.now(),
				updatedAt: Date.now(),
				toolCalls: 0,
				input: 0,
				cacheRead: 0,
				output: 0,
				cost: 0,
				unpriced: false,
			}),
		).toBe(true);
		expect(
			store.lock("acceptance-other-owner", [{ path: target, kind: "file", reason: "Acceptance reservation" }]).ok,
		).toBe(true);
		indexedHook(f, {
			"second.txt": decision({ file_path: target, content: "REWRITTEN" }),
		});
		await f.run("file", { queries: [write(first), write(second)] });
		for (const file of [first, second, target])
			expect(
				fs.existsSync(file),
				file + "\n" + JSON.stringify(f.session.messages.findLast((m) => m.role === "toolResult")),
			).toBe(false);
		expect(f.session.messages.findLast((m) => m.role === "toolResult")).toMatchObject({ isError: true });
		expect(JSON.stringify(f.session.messages.findLast((m) => m.role === "toolResult"))).toMatch(
			/reserv|locked|acceptance-other-owner/i,
		);
	} finally {
		store.remove("acceptance-other-owner");
		store.close();
		await f.close();
	}
});

it("Codex PostToolUse apply_patch projection captures the committed Claude replacement", async () => {
	const f = await fixture("claude");
	try {
		const original = path.join(f.cwd, "original.txt"),
			target = path.join(f.cwd, "replacement.txt"),
			capture = path.join(f.root, "codex-post.jsonl"),
			script = path.join(f.root, "codex-post.cjs");
		replaceHook(f, decision({ file_path: target, content: "REWRITTEN\n" }));
		fs.writeFileSync(
			script,
			`const fs=require('node:fs');let s='';process.stdin.on('data',x=>s+=x);process.stdin.on('end',()=>fs.appendFileSync(${JSON.stringify(capture)},s+'\\n'));`,
		);
		const quote = (s: string) => `'${s.replaceAll("'", "'\\''")}'`;
		const codexHome = process.env.CODEX_HOME!;
		fs.mkdirSync(codexHome, { recursive: true });
		fs.writeFileSync(
			path.join(codexHome, "hooks.json"),
			JSON.stringify({
				hooks: {
					PostToolUse: [
						{
							matcher: "apply_patch",
							hooks: [
								{
									type: "command",
									command: `${quote(process.execPath)} ${quote(script)}`,
								},
							],
						},
					],
				},
			}),
		);
		await f.session.reload();
		await f.run("file", { queries: [write(original, "ORIGINAL\n")] });
		expect(fs.existsSync(original)).toBe(false);
		expect(fs.readFileSync(target, "utf8")).toBe("REWRITTEN\n");
		const post = JSON.parse(fs.readFileSync(capture, "utf8").trim());
		expect(post.tool_name).toBe("apply_patch");
		expect(post.tool_input.command).toContain(`*** Add File: ${target}\n+REWRITTEN\n`);
		expect(post.tool_input.command).not.toContain(original);
	} finally {
		await f.close();
	}
});

for (const candidate of [false, true]) {
	it(`${candidate ? "proposed replacement into hard state refuses the batch" : "original approved target cannot drift"} through an ancestor symlink while another gate waits`, async () => {
		const f = await fixture("claude");
		try {
			const inside = path.join(f.cwd, "inside"),
				outside = candidate
					? path.join(process.env.OCTOCODE_HOME!, "rewrite-state-target")
					: path.join(f.root, "outside", ".claude"),
				alias = path.join(f.cwd, "alias"),
				ready = path.join(f.root, "drift-ready"),
				release = path.join(f.root, "drift-release");
			fs.mkdirSync(inside);
			fs.mkdirSync(outside, { recursive: true });
			fs.symlinkSync(inside, alias);
			const original = path.join(f.cwd, "original.txt"),
				later = path.join(f.cwd, "later.txt"),
				target = path.join(alias, "target.txt");
			const rewrite = decision({ file_path: target, content: "REWRITTEN" });
			const allow = {
				hookSpecificOutput: {
					hookEventName: "PermissionRequest",
					decision: { behavior: "allow" },
				},
			};
			fs.writeFileSync(
				path.join(f.root, "hook.cjs"),
				`const fs=require('node:fs');let s='';process.stdin.on('data',x=>s+=x);process.stdin.on('end',()=>{fs.appendFileSync(${JSON.stringify(f.capture)},s+'\\n');const input=JSON.parse(s),first=${candidate}&&input.tool_input.file_path===${JSON.stringify(original)};if(!first){fs.writeFileSync(${JSON.stringify(ready)},'ready');while(!fs.existsSync(${JSON.stringify(release)}))Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,5);}const count=fs.readFileSync(${JSON.stringify(f.capture)},'utf8').trim().split('\\n').length;console.log(JSON.stringify(count>${candidate ? 2 : 1}?{hookSpecificOutput:{hookEventName:'PermissionRequest',decision:{behavior:'deny',message:'FRESH_TARGET_DENIED'}}}:first?${JSON.stringify(rewrite)}:${JSON.stringify(allow)}));});`,
			);
			const running = f.run("file", {
				queries: candidate ? [write(original), write(later)] : [write(target)],
			});
			await vi.waitFor(() => expect(fs.existsSync(ready)).toBe(true));
			fs.unlinkSync(alias);
			fs.symlinkSync(outside, alias);
			fs.writeFileSync(release, "");
			await running;
			for (const file of [original, later, path.join(inside, "target.txt"), path.join(outside, "target.txt")])
				expect(
					fs.existsSync(file),
					file + "\n" + JSON.stringify(f.session.messages.findLast((m) => m.role === "toolResult")),
				).toBe(false);
			expect(f.session.messages.findLast((m) => m.role === "toolResult")).toMatchObject({ isError: true });
		} finally {
			fs.writeFileSync(path.join(f.root, "drift-release"), "");
			await f.close();
		}
	});
}

for (const tool of ["Write", "Edit"] as const) {
	it(`${tool} replacement ignores unknown source fields without promoting native keys`, async () => {
		const f = await fixture("claude", { fileReadTool: true });
		try {
			const target = path.join(f.cwd, "original.txt"),
				forbidden = path.join(f.cwd, "wrong-native-path.txt");
			if (tool === "Edit") {
				fs.writeFileSync(target, "BEFORE");
				await f.run("read", { path: target });
			}
			replaceHook(
				f,
				decision({
					file_path: target,
					...(tool === "Write" ? { content: "REWRITTEN" } : { old_string: "BEFORE", new_string: "REWRITTEN" }),
					arbitrary: "IGNORED",
					path: forbidden,
					type: "delete",
				}),
			);
			await f.run("file", {
				queries: [
					tool === "Write"
						? write(target)
						: {
								type: "edit",
								path: target,
								edits: [{ oldText: "BEFORE", newText: "ORIGINAL" }],
								reason: "Unknown source fields",
							},
				],
			});
			expect(fs.readFileSync(target, "utf8")).toBe("REWRITTEN");
			expect(fs.existsSync(forbidden)).toBe(false);
		} finally {
			await f.close();
		}
	});
}
it("invalid replace_all type cannot change either occurrence", async () => {
	const f = await fixture("claude", { fileReadTool: true });
	try {
		const target = path.join(f.cwd, "original.txt");
		fs.writeFileSync(target, "BEFORE BEFORE");
		await f.run("read", { path: target });
		replaceHook(
			f,
			decision({
				file_path: target,
				old_string: "BEFORE",
				new_string: "AFTER",
				replace_all: "true",
			}),
		);
		await f.run("file", {
			queries: [
				{
					type: "edit",
					path: target,
					edits: [{ oldText: "BEFORE BEFORE", newText: "ORIGINAL" }],
					reason: "Unsupported replace all",
				},
			],
		});
		expect(fs.readFileSync(target, "utf8")).toBe("BEFORE BEFORE");
		expect(JSON.stringify(f.session.messages.findLast((m) => m.role === "toolResult"))).toMatch(
			/replace_all|unsupported/i,
		);
		expect(f.session.messages.findLast((m) => m.role === "toolResult")).toMatchObject({ isError: true });
	} finally {
		await f.close();
	}
});
it("canonical patch permission replacement remains an explicit unavailable mode", async () => {
	const f = await fixture("claude");
	try {
		const original = path.join(f.cwd, "original.txt"),
			target = path.join(f.cwd, "replacement.txt");
		replaceHook(f, decision({ file_path: target, content: "REWRITTEN\n" }));
		await f.run("file", {
			patch: `*** Begin Patch\n*** Add File: ${original}\n+ORIGINAL\n*** End Patch`,
			reason: "Unsupported patch replacement",
		});
		expect(fs.existsSync(original)).toBe(false);
		expect(fs.existsSync(target)).toBe(false);
		expect(f.session.messages.findLast((m) => m.role === "toolResult")).toMatchObject({ isError: true });
		expect(JSON.stringify(f.session.messages.findLast((m) => m.role === "toolResult"))).toMatch(
			/patch|unsupported|unavailable|input replacement requires/i,
		);
	} finally {
		await f.close();
	}
});

it("a fresh source ask for an unchanged sibling invalidates a held batch approval", async () => {
	const f = await fixture("claude");
	try {
		const first = path.join(f.cwd, "first.txt"),
			second = path.join(f.cwd, "second.txt"),
			target = path.join(f.cwd, "replacement.txt"),
			ready = path.join(f.root, "refresh-ready"),
			release = path.join(f.root, "refresh-release");
		fs.writeFileSync(
			path.join(f.root, "hook.cjs"),
			`const fs=require('node:fs');let s='';process.stdin.on('data',x=>s+=x);process.stdin.on('end',()=>{fs.appendFileSync(${JSON.stringify(f.capture)},s+'\\n');const second=JSON.parse(s).tool_input.file_path===${JSON.stringify(second)};if(second){fs.writeFileSync(${JSON.stringify(ready)},'ready');while(!fs.existsSync(${JSON.stringify(release)}))Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,5);}console.log(JSON.stringify(second?{hookSpecificOutput:{hookEventName:'PermissionRequest',decision:{behavior:'allow'}}}:${JSON.stringify(decision({ file_path: target, content: "REWRITTEN" }))}));});`,
		);
		const running = f.run("file", { queries: [write(first), write(second)] });
		await vi.waitFor(() => expect(fs.existsSync(ready)).toBe(true));
		const config = path.join(f.configDir, "settings.json"),
			settings = JSON.parse(fs.readFileSync(config, "utf8"));
		settings.permissions = { ask: ["Write(./second.txt)"] };
		fs.writeFileSync(config, JSON.stringify(settings));
		fs.writeFileSync(release, "");
		await running;
		for (const file of [first, second, target]) expect(fs.existsSync(file), file).toBe(false);
		expect(f.session.messages.findLast((m) => m.role === "toolResult")).toMatchObject({ isError: true });
	} finally {
		fs.writeFileSync(path.join(f.root, "refresh-release"), "");
		await f.close();
	}
});

for (const [name, body, anchor] of [
	["missing", "BEFORE", "MISSING"],
	["ambiguous", "BEFORE BEFORE", "BEFORE"],
] as const) {
	it(`an original ${name} Edit anchor is rejected before a hook can repair it`, async () => {
		const f = await fixture("claude", { fileReadTool: true });
		try {
			const target = path.join(f.cwd, "original.txt");
			fs.writeFileSync(target, body);
			await f.run("read", { path: target });
			replaceHook(
				f,
				decision({
					file_path: target,
					old_string: body,
					new_string: "REWRITTEN",
				}),
			);
			await f.run("file", {
				queries: [
					{
						type: "edit",
						path: target,
						edits: [{ oldText: anchor, newText: "ORIGINAL" }],
						reason: "Original invalid anchor",
					},
				],
			});
			expect(fs.readFileSync(target, "utf8")).toBe(body);
			expect(f.inputs()).toHaveLength(0);
			expect(f.session.messages.findLast((m) => m.role === "toolResult")).toMatchObject({ isError: true });
		} finally {
			await f.close();
		}
	});
}

for (const existing of [false, true]) {
	it(`unchanged sequential native ${existing ? "A to B to C" : "create then edit"} remains valid`, async () => {
		const f = await fixture("claude", { fileReadTool: true });
		try {
			const target = path.join(f.cwd, "sequence.txt");
			if (existing) {
				fs.writeFileSync(target, "A");
				await f.run("read", { path: target });
			}
			const edit = (oldText: string, newText: string) => ({
				type: "edit",
				path: target,
				edits: [{ oldText, newText }],
				reason: "Sequential unchanged original",
			});
			await f.run("file", {
				queries: existing ? [edit("A", "B"), edit("B", "C")] : [write(target, "A"), edit("A", "B")],
			});
			expect(fs.readFileSync(target, "utf8")).toBe(existing ? "C" : "B");
			expect(f.session.messages.findLast((m) => m.role === "toolResult")).toMatchObject({ isError: false });
		} finally {
			await f.close();
		}
	});
}

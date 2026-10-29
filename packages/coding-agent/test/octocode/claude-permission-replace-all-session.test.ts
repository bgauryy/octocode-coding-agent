import fs from "node:fs";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { fixture } from "./permission-session-fixture.ts";
afterEach(() => vi.unstubAllEnvs());
function hook(f: Awaited<ReturnType<typeof fixture>>, input: unknown) {
	const output = {
		hookSpecificOutput: {
			hookEventName: "PermissionRequest",
			decision: { behavior: "allow", updatedInput: input },
		},
	};
	fs.writeFileSync(
		path.join(f.root, "hook.cjs"),
		`const fs=require('node:fs');let s='';process.stdin.on('data',x=>s+=x);process.stdin.on('end',()=>{fs.appendFileSync(${JSON.stringify(f.capture)},s+'\\n');console.log(${JSON.stringify(JSON.stringify(output))});});`,
	);
}
const edit = (target: string, oldText: string, newText: string) => ({
	type: "edit",
	path: target,
	edits: [{ oldText, newText }],
	reason: "Replace all acceptance",
});
it("source Edit replace_all updates both original occurrences after a real read", async () => {
	const f = await fixture("claude", { fileReadTool: true });
	try {
		const target = path.join(f.cwd, "original.txt");
		fs.writeFileSync(target, "BEFORE BEFORE");
		await f.run("read", { path: target });
		hook(f, {
			file_path: target,
			old_string: "BEFORE",
			new_string: "AFTER",
			replace_all: true,
		});
		await f.run("file", {
			queries: [edit(target, "BEFORE BEFORE", "ORIGINAL")],
		});
		expect(fs.readFileSync(target, "utf8")).toBe("AFTER AFTER");
		expect(f.inputs()).toHaveLength(1);
		expect(f.session.messages.findLast((m) => m.role === "toolResult")).toMatchObject({ isError: false });
	} finally {
		await f.close();
	}
});

for (const [name, before, oldText, newText, after] of [
	["self-overlap is non-overlapping", "aaa", "aa", "X", "Xa"],
	["replacement containing old text is nonrecursive", "aa aa", "aa", "aaaa", "aaaa aaaa"],
	["exact quotes take priority over fuzzy copies", '"hello"\n“hello”\n', '"hello"', "AFTER", "AFTER\n“hello”\n"],
	["quote fallback applies only without exact matches", "“hello”\n“hello”\n", '"hello"', "AFTER", "AFTER\nAFTER\n"],
	["CRLF bytes survive normalized matching", "BEFORE\r\nBEFORE\r\n", "BEFORE\n", "AFTER\n", "AFTER\r\nAFTER\r\n"],
] as const) {
	it(`source replace_all ${name}`, async () => {
		const f = await fixture("claude", { fileReadTool: true });
		try {
			const target = path.join(f.cwd, "original.txt");
			fs.writeFileSync(target, before);
			await f.run("read", { path: target });
			hook(f, {
				file_path: target,
				old_string: oldText,
				new_string: newText,
				replace_all: true,
			});
			await f.run("file", { queries: [edit(target, before, "ORIGINAL")] });
			expect(fs.readFileSync(target)).toEqual(Buffer.from(after));
			expect(f.session.messages.findLast((m) => m.role === "toolResult")).toMatchObject({ isError: false });
		} finally {
			await f.close();
		}
	});
}
it("partial read permits all occurrences but does not grant whole-file write coverage", async () => {
	const f = await fixture("claude", { fileReadTool: true });
	try {
		const target = path.join(f.cwd, "original.txt"),
			before = "BEFORE\nother\nBEFORE\n",
			after = "AFTER\nother\nAFTER\n";
		fs.writeFileSync(target, before);
		await f.run("read", { path: target, offset: 1, limit: 1 });
		hook(f, {
			file_path: target,
			old_string: "BEFORE",
			new_string: "AFTER",
			replace_all: true,
		});
		await f.run("file", { queries: [edit(target, before, "ORIGINAL")] });
		expect(fs.readFileSync(target, "utf8")).toBe(after);
		expect(f.inputs()).toHaveLength(1);
		await f.run("file", {
			queries: [
				{
					type: "write",
					path: target,
					content: "OVERWRITE",
					reason: "Coverage must remain partial",
				},
			],
		});
		expect(fs.readFileSync(target, "utf8")).toBe(after);
		expect(f.inputs()).toHaveLength(1);
		expect(f.session.messages.findLast((m) => m.role === "toolResult")).toMatchObject({ isError: true });
	} finally {
		await f.close();
	}
});
it("stale source prefix and an extra exact occurrence are preserved and replaced respectively", async () => {
	const f = await fixture("claude", { fileReadTool: true });
	try {
		const target = path.join(f.cwd, "original.txt"),
			before = "BEFORE|BEFORE";
		fs.writeFileSync(target, before);
		await f.run("read", { path: target });
		fs.writeFileSync(target, "PREFIX BEFORE|BEFORE;BEFORE");
		hook(f, {
			file_path: target,
			old_string: "BEFORE",
			new_string: "AFTER",
			replace_all: true,
		});
		await f.run("file", { queries: [edit(target, before, "ORIGINAL")] });
		expect(fs.readFileSync(target, "utf8")).toBe("PREFIX AFTER|AFTER;AFTER");
		expect(f.session.messages.findLast((m) => m.role === "toolResult")).toMatchObject({ isError: false });
	} finally {
		await f.close();
	}
});

it("native replaceAll projects source replace_all consistently before and after execution", async () => {
	const f = await fixture("claude", { fileReadTool: true });
	try {
		const target = path.join(f.cwd, "original.txt"),
			capture = path.join(f.root, "events.jsonl"),
			script = path.join(f.root, "events.cjs");
		fs.writeFileSync(
			script,
			`const fs=require('node:fs');let s='';process.stdin.on('data',x=>s+=x);process.stdin.on('end',()=>{fs.appendFileSync(${JSON.stringify(capture)},s+'\\n');console.log('{}');});`,
		);
		const quote = (s: string) => `'${s.replaceAll("'", "'\\''")}'`,
			config = path.join(f.configDir, "settings.json"),
			settings = JSON.parse(fs.readFileSync(config, "utf8"));
		for (const event of ["PreToolUse", "PostToolUse"])
			settings.hooks[event] = [
				{
					matcher: "Edit",
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
		fs.writeFileSync(target, "BEFORE BEFORE");
		await f.run("read", { path: target });
		await f.run("file", {
			queries: [
				{
					type: "edit",
					path: target,
					edits: [{ oldText: "BEFORE", newText: "AFTER", replaceAll: true }],
					reason: "Native flag projection",
				},
			],
		});
		expect(fs.readFileSync(target, "utf8")).toBe("AFTER AFTER");
		const events = fs
			.readFileSync(capture, "utf8")
			.trim()
			.split("\n")
			.map((s) => JSON.parse(s));
		expect(events.map((e) => e.hook_event_name)).toEqual(["PreToolUse", "PostToolUse"]);
		for (const event of events)
			expect(event).toMatchObject({
				tool_name: "Edit",
				tool_input: {
					file_path: target,
					old_string: "BEFORE",
					new_string: "AFTER",
					replace_all: true,
				},
			});
		expect(f.inputs()[0]).toMatchObject({ tool_input: { replace_all: true } });
	} finally {
		await f.close();
	}
});

for (const overlap of [false, true]) {
	it(`native all-occurrence spans ${overlap ? "reject overlapping edits atomically" : "compose with a disjoint exact edit"}`, async () => {
		const f = await fixture("claude", {
			fileReadTool: true,
			hooksEnabled: false,
			mode: "full",
		});
		try {
			const target = path.join(f.cwd, "original.txt"),
				body = "aa b aa";
			fs.writeFileSync(target, body);
			await f.run("read", { path: target });
			await f.run("file", {
				queries: [
					{
						type: "edit",
						path: target,
						edits: [
							{ oldText: "aa", newText: "X", replaceAll: true },
							{ oldText: overlap ? "aa b" : "b", newText: "Y" },
						],
						reason: "Original-span combination",
					},
				],
			});
			expect(fs.readFileSync(target, "utf8")).toBe(overlap ? body : "X Y X");
			expect(f.session.messages.findLast((m) => m.role === "toolResult")).toMatchObject({ isError: overlap });
		} finally {
			await f.close();
		}
	});
}

for (const [name, before, anchor] of [
	["trailing whitespace", "hello   \nhello   \n", "hello\n"],
	["Unicode width folding", "ＢＥＦＯＲＥ ＢＥＦＯＲＥ", "BEFORE"],
] as const) {
	it(`all-occurrence candidate does not broaden matching through ${name}`, async () => {
		const f = await fixture("claude", { fileReadTool: true });
		try {
			const target = path.join(f.cwd, "original.txt");
			fs.writeFileSync(target, before);
			await f.run("read", { path: target });
			hook(f, {
				file_path: target,
				old_string: anchor,
				new_string: "AFTER",
				replace_all: true,
			});
			await f.run("file", { queries: [edit(target, before, "ORIGINAL")] });
			expect(fs.readFileSync(target, "utf8")).toBe(before);
			expect(f.inputs()).toHaveLength(1);
			expect(f.session.messages.findLast((m) => m.role === "toolResult")).toMatchObject({ isError: true });
		} finally {
			await f.close();
		}
	});
}

for (const mixed of [false, true]) {
	it(`a broad fuzzy default edit ${mixed ? "cannot be mixed with all-occurrence edits" : "retains its existing standalone behavior"}`, async () => {
		const f = await fixture("claude", {
			fileReadTool: true,
			hooksEnabled: false,
			mode: "full",
		});
		try {
			const target = path.join(f.cwd, "original.txt"),
				body = "aa\nb   \naa";
			fs.writeFileSync(target, body);
			await f.run("read", { path: target });
			await f.run("file", {
				queries: [
					{
						type: "edit",
						path: target,
						edits: [
							...(mixed ? [{ oldText: "aa", newText: "X", replaceAll: true }] : []),
							{ oldText: "b\n", newText: "Y\n" },
						],
						reason: "Fuzzy combination boundary",
					},
				],
			});
			expect(fs.readFileSync(target, "utf8")).toBe(mixed ? body : "aa\nY\naa");
			expect(f.session.messages.findLast((m) => m.role === "toolResult")).toMatchObject({ isError: mixed });
			if (mixed)
				expect(JSON.stringify(f.session.messages.findLast((m) => m.role === "toolResult"))).toMatch(
					/fuzzy|mixed|separate|normaliz/i,
				);
		} finally {
			await f.close();
		}
	});
}

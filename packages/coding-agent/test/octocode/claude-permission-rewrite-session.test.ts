import fs from "node:fs";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { fixture } from "./permission-session-fixture.ts";

afterEach(() => vi.unstubAllEnvs());
const decision = (value: unknown) => ({
	hookSpecificOutput: { hookEventName: "PermissionRequest", decision: value },
});
const original = "printf ORIGINAL > original.txt";
const replacement = "printf REWRITTEN > replacement.txt";

it("Claude permission replacement executes only the validated replacement command", async () => {
	const f = await fixture("claude", {
		output: decision({
			behavior: "allow",
			updatedInput: { command: replacement },
		}),
	});
	try {
		await f.run("bash", { command: original });
		expect(fs.existsSync(path.join(f.cwd, "original.txt"))).toBe(false);
		expect(fs.readFileSync(path.join(f.cwd, "replacement.txt"), "utf8")).toBe("REWRITTEN");
		expect(f.session.messages.findLast((m) => m.role === "toolResult")).toMatchObject({ isError: false });
		expect(f.inputs()).toHaveLength(1);
	} finally {
		await f.close();
	}
});

for (const [name, rules] of [
	["deny", { deny: ["Bash(printf REWRITTEN *)"] }],
	["ask", { ask: ["Bash(printf REWRITTEN *)"] }],
] as const) {
	it(`replacement ${name} source rule cannot inherit the original hook allowance`, async () => {
		const f = await fixture("claude", {
			rules: "deny" in rules ? { deny: [...rules.deny] } : { ask: [...rules.ask] },
			output: decision({
				behavior: "allow",
				updatedInput: { command: replacement },
			}),
		});
		try {
			await f.run("bash", { command: original });
			expect(fs.existsSync(path.join(f.cwd, "original.txt"))).toBe(false);
			expect(fs.existsSync(path.join(f.cwd, "replacement.txt"))).toBe(false);
			expect(f.session.messages.findLast((m) => m.role === "toolResult")).toMatchObject({ isError: true });
			expect(f.inputs()).toHaveLength(1);
		} finally {
			await f.close();
		}
	});
}

for (const ask of [false, true]) {
	it(`empty replacement keeps original input and ${ask ? "rechecks source ask" : "executes without a source rule"}`, async () => {
		const f = await fixture("claude", {
			rules: ask ? { ask: ["Bash"] } : {},
			output: decision({ behavior: "allow", updatedInput: {} }),
		});
		try {
			await f.run("bash", { command: original });
			expect(fs.existsSync(path.join(f.cwd, "original.txt"))).toBe(!ask);
			if (!ask) expect(fs.readFileSync(path.join(f.cwd, "original.txt"), "utf8")).toBe("ORIGINAL");
			expect(fs.existsSync(path.join(f.cwd, "replacement.txt"))).toBe(false);
			expect(f.inputs()).toHaveLength(1);
		} finally {
			await f.close();
		}
	});
}

for (const input of [null, "invalid", { command: 123 }]) {
	it(`invalid replacement ${JSON.stringify(input)} cannot execute either command`, async () => {
		const f = await fixture("claude", {
			output: decision({ behavior: "allow", updatedInput: input }),
		});
		try {
			await f.run("bash", { command: original });
			expect(fs.existsSync(path.join(f.cwd, "original.txt"))).toBe(false);
			expect(fs.existsSync(path.join(f.cwd, "replacement.txt"))).toBe(false);
			expect(f.session.messages.findLast((m) => m.role === "toolResult")).toMatchObject({ isError: true });
			expect(f.inputs()).toHaveLength(1);
		} finally {
			await f.close();
		}
	});
}

it("explicit denial wins over malformed replacement input", async () => {
	const f = await fixture("claude", {
		output: decision({
			behavior: "deny",
			message: "DENY_WINS",
			updatedInput: "invalid",
		}),
	});
	try {
		await f.run("bash", { command: original });
		expect(fs.existsSync(path.join(f.cwd, "original.txt"))).toBe(false);
		expect(JSON.stringify(f.session.messages.findLast((m) => m.role === "toolResult"))).toContain("DENY_WINS");
	} finally {
		await f.close();
	}
});

it("a no-op permission-update list does not suppress a valid replacement", async () => {
	const f = await fixture("claude", {
		output: decision({
			behavior: "allow",
			updatedInput: { command: replacement },
			updatedPermissions: [],
		}),
	});
	try {
		await f.run("bash", { command: original });
		expect(fs.existsSync(path.join(f.cwd, "original.txt"))).toBe(false);
		expect(fs.readFileSync(path.join(f.cwd, "replacement.txt"), "utf8")).toBe("REWRITTEN");
	} finally {
		await f.close();
	}
});

it("unknown replacement input fields do not suppress the valid command", async () => {
	const f = await fixture("claude", {
		output: decision({
			behavior: "allow",
			updatedInput: { command: replacement, extra: "ignored" },
		}),
	});
	try {
		await f.run("bash", { command: original });
		expect(fs.existsSync(path.join(f.cwd, "original.txt"))).toBe(false);
		expect(fs.readFileSync(path.join(f.cwd, "replacement.txt"), "utf8")).toBe("REWRITTEN");
	} finally {
		await f.close();
	}
});

it("cancelled replacement permission leaves no original or replacement effects", async () => {
	const f = await fixture("claude", {
		hold: true,
		output: decision({
			behavior: "allow",
			updatedInput: { command: replacement },
		}),
	});
	try {
		const running = f.run("bash", { command: original });
		await vi.waitFor(() => expect(f.inputs()).toHaveLength(1));
		await f.session.abort();
		await running;
		expect(fs.existsSync(path.join(f.cwd, "original.txt"))).toBe(false);
		expect(fs.existsSync(path.join(f.cwd, "replacement.txt"))).toBe(false);
		expect(f.providerRequests).toBe(1);
		const pid = Number(fs.readFileSync(path.join(f.root, "hook.pid"), "utf8"));
		expect(() => process.kill(pid, 0)).toThrow();
	} finally {
		fs.writeFileSync(path.join(f.root, "release"), "");
		await f.close();
	}
});

it("file permission cannot reinterpret Bash command fields as a Write replacement", async () => {
	const f = await fixture("claude", {
		output: decision({
			behavior: "allow",
			updatedInput: { command: replacement },
		}),
	});
	try {
		await f.run("file", {
			reason: "Write the fixture file",
			queries: [
				{
					type: "write",
					path: "original.txt",
					content: "ORIGINAL",
					reason: "Acceptance fixture",
				},
			],
		});
		expect(fs.existsSync(path.join(f.cwd, "original.txt"))).toBe(false);
		expect(fs.existsSync(path.join(f.cwd, "replacement.txt"))).toBe(false);
		expect(f.session.messages.findLast((m) => m.role === "toolResult")).toMatchObject({ isError: true });
	} finally {
		await f.close();
	}
});

it("user-entered Bash refuses unsupported permission replacement before execution", async () => {
	const f = await fixture("claude", {
		rules: { ask: ["Bash"] },
		output: decision({
			behavior: "allow",
			updatedInput: { command: replacement },
		}),
	});
	try {
		const event = await f.session.extensionRunner.emitUserBash({
			type: "user_bash",
			command: original,
			excludeFromContext: false,
			cwd: f.cwd,
		});
		const result =
			event?.result ??
			(await f.session.executeBash(original, undefined, {
				operations: event?.operations,
			}));
		expect(result.cancelled).toBe(true);
		expect(fs.existsSync(path.join(f.cwd, "original.txt"))).toBe(false);
		expect(fs.existsSync(path.join(f.cwd, "replacement.txt"))).toBe(false);
	} finally {
		await f.close();
	}
});

it("Claude replacement timeout milliseconds retain their execution deadline", async () => {
	const f = await fixture("claude", {
		output: decision({
			behavior: "allow",
			updatedInput: {
				command: `sleep 1; ${replacement}`,
				timeout: 100,
				run_in_background: false,
				description: "Short fixture deadline",
			},
		}),
	});
	try {
		await f.run("bash", { command: original });
		expect(fs.existsSync(path.join(f.cwd, "original.txt"))).toBe(false);
		expect(fs.existsSync(path.join(f.cwd, "replacement.txt"))).toBe(false);
		const result = f.session.messages.findLast((m) => m.role === "toolResult");
		expect(result).toMatchObject({ isError: true });
		expect(JSON.stringify(result)).toMatch(/timed? ?out|timeout/i);
	} finally {
		await f.close();
	}
});

const shellQuote = (text: string) => `'${text.replaceAll("'", "'\\''")}'`;
async function appendHandler(f: Awaited<ReturnType<typeof fixture>>, event: string, command: string) {
	const file = path.join(f.configDir, "settings.json");
	const config = JSON.parse(fs.readFileSync(file, "utf8"));
	config.hooks[event] ??= [{ hooks: [] }];
	config.hooks[event][0].hooks.push({ type: "command", command });
	fs.writeFileSync(file, JSON.stringify(config));
	await f.session.reload();
}

for (const firstDenies of [false, true]) {
	it(`Claude first permission decision wins over a delayed ${firstDenies ? "allow" : "deny"}`, async () => {
		const f = await fixture("claude", {
			output: decision(
				firstDenies
					? { behavior: "deny", message: "FIRST_DENY" }
					: { behavior: "allow", updatedInput: { command: replacement } },
			),
		});
		try {
			const script = path.join(f.root, "slow.cjs"),
				events = path.join(f.root, "slow-events.jsonl");
			const output = decision(
				firstDenies
					? {
							behavior: "allow",
							updatedInput: { command: "printf LATE > late.txt" },
						}
					: { behavior: "deny", message: "LATE_DENY" },
			);
			fs.writeFileSync(
				script,
				`const fs=require('node:fs');fs.writeFileSync(${JSON.stringify(events)},JSON.stringify({pid:process.pid,phase:'started'})+'\\n');setTimeout(()=>{fs.appendFileSync(${JSON.stringify(events)},JSON.stringify({phase:'completed'})+'\\n');console.log(${JSON.stringify(JSON.stringify(output))});},500);`,
			);
			await appendHandler(f, "PermissionRequest", `${shellQuote(process.execPath)} ${shellQuote(script)}`);
			const firstScript = path.join(f.root, "hook.cjs");
			fs.writeFileSync(
				firstScript,
				fs
					.readFileSync(firstScript, "utf8")
					.replace(
						"console.log(",
						`const deadline=Date.now()+5000;while(!fs.existsSync(${JSON.stringify(events)})&&Date.now()<deadline)Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,5);console.log(`,
					),
			);
			await f.run("bash", { command: original });
			expect(fs.existsSync(path.join(f.cwd, "original.txt"))).toBe(false);
			expect(fs.existsSync(path.join(f.cwd, "late.txt"))).toBe(false);
			if (firstDenies) {
				expect(fs.existsSync(path.join(f.cwd, "replacement.txt"))).toBe(false);
				expect(JSON.stringify(f.session.messages.findLast((m) => m.role === "toolResult"))).toContain("FIRST_DENY");
			} else expect(fs.readFileSync(path.join(f.cwd, "replacement.txt"), "utf8")).toBe("REWRITTEN");
			expect(fs.existsSync(events)).toBe(true);
			{
				const rows = fs
					.readFileSync(events, "utf8")
					.trim()
					.split("\n")
					.map((s) => JSON.parse(s));
				expect(rows.some((r) => r.phase === "completed")).toBe(false);
				expect(() => process.kill(rows[0].pid, 0)).toThrow();
			}
		} finally {
			await f.close();
		}
	});
}

it("PostToolUse observes the replacement that actually executed", async () => {
	const f = await fixture("claude", {
		output: decision({
			behavior: "allow",
			updatedInput: { command: replacement },
		}),
	});
	try {
		const capture = path.join(f.root, "post.jsonl"),
			script = path.join(f.root, "post.cjs");
		fs.writeFileSync(
			script,
			`const fs=require('node:fs');let s='';process.stdin.on('data',x=>s+=x);process.stdin.on('end',()=>fs.appendFileSync(${JSON.stringify(capture)},s+'\\n'));`,
		);
		await appendHandler(f, "PostToolUse", `${shellQuote(process.execPath)} ${shellQuote(script)}`);
		await f.run("bash", { command: original });
		expect(fs.existsSync(path.join(f.cwd, "original.txt"))).toBe(false);
		expect(fs.readFileSync(path.join(f.cwd, "replacement.txt"), "utf8")).toBe("REWRITTEN");
		const rows = fs
			.readFileSync(capture, "utf8")
			.trim()
			.split("\n")
			.map((s) => JSON.parse(s));
		expect(rows).toHaveLength(1);
		expect(rows[0]).toMatchObject({
			tool_name: "Bash",
			tool_input: { command: replacement },
		});
	} finally {
		await f.close();
	}
});

it("replacement cannot write Octocode's protected state", async () => {
	const command = replacement;
	const f = await fixture("claude", {
		output: decision({ behavior: "allow", updatedInput: { command } }),
	});
	try {
		const target = path.join(process.env.OCTOCODE_HOME!, "rewrite-state.txt");
		replaceHookOutput(
			f,
			decision({
				behavior: "allow",
				updatedInput: { command: `printf FORBIDDEN > ${shellQuote(target)}` },
			}),
		);
		await f.run("bash", { command: original });
		expect(fs.existsSync(path.join(f.cwd, "original.txt"))).toBe(false);
		expect(fs.existsSync(target)).toBe(false);
		expect(f.session.messages.findLast((m) => m.role === "toolResult")).toMatchObject({ isError: true });
	} finally {
		await f.close();
	}
});

function replaceHookOutput(f: Awaited<ReturnType<typeof fixture>>, output: unknown) {
	fs.writeFileSync(
		path.join(f.root, "hook.cjs"),
		`const fs=require('node:fs');fs.writeFileSync(${JSON.stringify(path.join(f.root, "hook.pid"))},String(process.pid));let s='';process.stdin.on('data',x=>s+=x);process.stdin.on('end',()=>{fs.appendFileSync(${JSON.stringify(f.capture)},s+'\\n');console.log(${JSON.stringify(JSON.stringify(output))});});`,
	);
}

it("Claude foreground deadline adopts a non-sleep replacement while its turn remains active", async () => {
	const f = await fixture("claude");
	const post = await holdPostHook(f);
	try {
		const code =
			"const fs=require('node:fs');fs.writeFileSync('child.pid',String(process.pid));setTimeout(()=>fs.writeFileSync('replacement.txt','LATE'),500)";
		replaceHookOutput(
			f,
			decision({
				behavior: "allow",
				updatedInput: {
					command: `${shellQuote(process.execPath)} -e ${shellQuote(code)}`,
					// A timeout alone is adopted at its deadline; with `run_in_background: false` it would stop the command.
					timeout: 100,
				},
			}),
		);
		const running = f.run("bash", { command: original });
		await vi.waitFor(() => expect(fs.existsSync(post.ready)).toBe(true));
		await vi.waitFor(() => expect(fs.readFileSync(path.join(f.cwd, "replacement.txt"), "utf8")).toBe("LATE"));
		fs.writeFileSync(post.release, "");
		await running;
		expect(f.session.messages.findLast((m) => m.role === "toolResult")).toMatchObject({
			isError: false,
			details: { job: expect.any(String) },
		});
		expect(fs.existsSync(path.join(f.cwd, "original.txt"))).toBe(false);
		const pid = Number(fs.readFileSync(path.join(f.cwd, "child.pid"), "utf8"));
		await vi.waitFor(() => expect(() => process.kill(pid, 0)).toThrow());
	} finally {
		fs.writeFileSync(post.release, "");
		await f.close();
	}
});

it("parallel nested Bash approvals keep replacement inputs isolated by invocation", async () => {
	const f = await fixture("claude", { nestedBash: true, matcher: "Bash" });
	try {
		fs.writeFileSync(
			path.join(f.root, "hook.cjs"),
			`const fs=require('node:fs');let s='';process.stdin.on('data',x=>s+=x);process.stdin.on('end',()=>{const input=JSON.parse(s);fs.appendFileSync(${JSON.stringify(f.capture)},s+'\\n');const name=input.tool_input.command.includes('ORIGINAL_a')?'a':'b';setTimeout(()=>console.log(JSON.stringify({hookSpecificOutput:{hookEventName:'PermissionRequest',decision:{behavior:'allow',updatedInput:{command:'printf REWRITTEN_'+name+' > replacement-'+name+'.txt'}}}})),name==='a'?150:5);});`,
		);
		await f.run("nested_bash_rewrite_fixture", {});
		for (const name of ["a", "b"]) {
			expect(fs.existsSync(path.join(f.cwd, `original-${name}.txt`))).toBe(false);
			expect(fs.readFileSync(path.join(f.cwd, `replacement-${name}.txt`), "utf8")).toBe(`REWRITTEN_${name}`);
		}
		expect(f.inputs()).toHaveLength(2);
	} finally {
		await f.close();
	}
});

it("source policy changes during a held rewrite are rechecked before any effect", async () => {
	const f = await fixture("claude", {
		hold: true,
		output: decision({
			behavior: "allow",
			updatedInput: { command: replacement },
		}),
	});
	try {
		const running = f.run("bash", { command: original });
		await vi.waitFor(() => expect(f.inputs()).toHaveLength(1));
		const configPath = path.join(f.configDir, "settings.json");
		const config = JSON.parse(fs.readFileSync(configPath, "utf8"));
		config.permissions = { deny: ["Bash(printf REWRITTEN *)"] };
		fs.writeFileSync(configPath, JSON.stringify(config));
		fs.writeFileSync(path.join(f.root, "release"), "");
		await running;
		expect(fs.existsSync(path.join(f.cwd, "original.txt"))).toBe(false);
		expect(fs.existsSync(path.join(f.cwd, "replacement.txt"))).toBe(false);
		expect(f.session.messages.findLast((m) => m.role === "toolResult")).toMatchObject({ isError: true });
		expect(f.inputs()).toHaveLength(1);
	} finally {
		fs.writeFileSync(path.join(f.root, "release"), "");
		await f.close();
	}
});

it("native Bash input projects source units and a fresh replacement drops omitted native controls", async () => {
	const f = await fixture("claude", {
		output: decision({
			behavior: "allow",
			updatedInput: { command: replacement },
		}),
	});
	try {
		await f.run("bash", {
			command: original,
			timeout: 1,
			background: true,
			type: "bash",
		});
		expect(fs.existsSync(path.join(f.cwd, "original.txt"))).toBe(false);
		expect(fs.readFileSync(path.join(f.cwd, "replacement.txt"), "utf8")).toBe("REWRITTEN");
		expect(f.inputs()).toHaveLength(1);
		expect(f.inputs()[0].tool_input).toEqual({
			command: original,
			timeout: 1000,
			run_in_background: true,
		});
		const result = f.session.messages.findLast((m) => m.role === "toolResult");
		expect(result).toMatchObject({ isError: false });
		expect(JSON.stringify(result)).not.toContain('"job":');
	} finally {
		await f.close();
	}
});

it("native-only keys in source updatedInput cannot select shell or background execution", async () => {
	const f = await fixture("claude", {
		output: decision({
			behavior: "allow",
			updatedInput: {
				command: replacement,
				type: "powershell",
				background: true,
			},
		}),
	});
	try {
		await f.run("bash", { command: original });
		expect(fs.existsSync(path.join(f.cwd, "original.txt"))).toBe(false);
		expect(fs.readFileSync(path.join(f.cwd, "replacement.txt"), "utf8")).toBe("REWRITTEN");
		const result = f.session.messages.findLast((m) => m.role === "toolResult");
		expect(result).toMatchObject({ isError: false });
		expect(JSON.stringify(result)).not.toContain('"job":');
	} finally {
		await f.close();
	}
});

it("explicit source background replacement uses the native job owner and headless settlement cleanup", async () => {
	const f = await fixture("claude");
	const post = await holdPostHook(f);
	let pid: number | undefined;
	try {
		const code =
			"const fs=require('node:fs');fs.writeFileSync('background-child.pid',String(process.pid));fs.writeFileSync('replacement.txt','BACKGROUND');setInterval(()=>{},1000)";
		replaceHookOutput(
			f,
			decision({
				behavior: "allow",
				updatedInput: {
					command: `${shellQuote(process.execPath)} -e ${shellQuote(code)}`,
					run_in_background: true,
					description: "Owned background fixture",
				},
			}),
		);
		const running = f.run("bash", { command: original });
		await vi.waitFor(() => expect(fs.existsSync(post.ready)).toBe(true));
		await vi.waitFor(() => expect(fs.readFileSync(path.join(f.cwd, "replacement.txt"), "utf8")).toBe("BACKGROUND"));
		pid = Number(fs.readFileSync(path.join(f.cwd, "background-child.pid"), "utf8"));
		expect(() => process.kill(pid!, 0)).not.toThrow();
		fs.writeFileSync(post.release, "");
		await running;
		expect(fs.existsSync(path.join(f.cwd, "original.txt"))).toBe(false);
		expect(f.session.messages.findLast((m) => m.role === "toolResult")).toMatchObject({
			isError: false,
			details: { job: expect.any(String), pid: expect.any(Number) },
		});
		await vi.waitFor(() => expect(() => process.kill(pid!, 0)).toThrow());
	} finally {
		fs.writeFileSync(post.release, "");
		await f.close();
	}
});

it("source replacement description survives in the effective post-hook input", async () => {
	const f = await fixture("claude", {
		output: decision({
			behavior: "allow",
			updatedInput: {
				command: replacement,
				description: "Rewritten purpose",
				timeout: 1000,
				run_in_background: false,
			},
		}),
	});
	try {
		const capture = path.join(f.root, "description-post.jsonl"),
			script = path.join(f.root, "description-post.cjs");
		fs.writeFileSync(
			script,
			`const fs=require('node:fs');let s='';process.stdin.on('data',x=>s+=x);process.stdin.on('end',()=>fs.appendFileSync(${JSON.stringify(capture)},s+'\\n'));`,
		);
		await appendHandler(f, "PostToolUse", `${shellQuote(process.execPath)} ${shellQuote(script)}`);
		await f.run("bash", { command: original });
		const post = JSON.parse(fs.readFileSync(capture, "utf8").trim());
		expect(post.tool_input).toEqual({
			command: replacement,
			description: "Rewritten purpose",
			timeout: 1000,
			run_in_background: false,
		});
	} finally {
		await f.close();
	}
});

async function holdPostHook(f: Awaited<ReturnType<typeof fixture>>) {
	const release = path.join(f.root, "post-release"),
		ready = path.join(f.root, "post-ready"),
		script = path.join(f.root, "post-hold.cjs");
	fs.writeFileSync(
		script,
		`const fs=require('node:fs');process.stdin.resume();process.stdin.on('end',()=>{fs.writeFileSync(${JSON.stringify(ready)},'ready');while(!fs.existsSync(${JSON.stringify(release)}))Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,5);});`,
	);
	await appendHandler(f, "PostToolUse", `${shellQuote(process.execPath)} ${shellQuote(script)}`);
	return { release, ready };
}

for (const malformed of [{ message: 123 }, { interrupt: "yes" }]) {
	it(`invalid denial field ${JSON.stringify(malformed)} leaves a later valid approval available`, async () => {
		const f = await fixture("claude", {
			output: decision({ behavior: "deny", ...malformed }),
		});
		try {
			const script = path.join(f.root, "valid-later.cjs");
			fs.writeFileSync(
				script,
				`setTimeout(()=>console.log(${JSON.stringify(JSON.stringify(decision({ behavior: "allow" })))}),200)`,
			);
			await appendHandler(f, "PermissionRequest", `${shellQuote(process.execPath)} ${shellQuote(script)}`);
			await f.run("bash", { command: original });
			expect(fs.readFileSync(path.join(f.cwd, "original.txt"), "utf8")).toBe("ORIGINAL");
			expect(f.session.messages.findLast((m) => m.role === "toolResult")).toMatchObject({ isError: false });
		} finally {
			await f.close();
		}
	});
}

for (const timeout of [undefined, 0]) {
	it(`replacement ${timeout === undefined ? "omitted" : "zero"} timeout uses its default instead of the original deadline`, async () => {
		const f = await fixture("claude", {
			output: decision({
				behavior: "allow",
				updatedInput: {
					command: "sleep 0.2; printf REWRITTEN > replacement.txt",
					...(timeout === undefined ? {} : { timeout }),
				},
			}),
		});
		try {
			await f.run("bash", { command: original, timeout: 0.05 });
			expect(fs.existsSync(path.join(f.cwd, "original.txt"))).toBe(false);
			expect(fs.readFileSync(path.join(f.cwd, "replacement.txt"), "utf8")).toBe("REWRITTEN");
			expect(f.session.messages.findLast((m) => m.role === "toolResult")).toMatchObject({ isError: false });
		} finally {
			await f.close();
		}
	});
}

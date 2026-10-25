import fs from "node:fs";
import path from "node:path";
import lockfile from "proper-lockfile";
import { withFileWriteLock } from "../../src/utils/file-write-lock.ts";
import { afterEach, expect, it, vi } from "vitest";
import { fixture } from "./permission-session-fixture.ts";

afterEach(() => vi.unstubAllEnvs());
const decision = (value: unknown) => ({
	hookSpecificOutput: { hookEventName: "PermissionRequest", decision: value },
});

it("Claude session allow update approves only the next matching invocation", async () => {
	const f = await fixture("claude", {
		output: decision({
			behavior: "allow",
			updatedPermissions: [
				{
					type: "addRules",
					rules: [{ toolName: "Bash", ruleContent: "node -p 42" }],
					behavior: "allow",
					destination: "session",
				},
			],
		}),
	});
	try {
		await f.run("bash", { command: "node -p 41" });
		expect(f.session.messages.findLast((m) => m.role === "toolResult")).toMatchObject({ isError: false });
		expect(f.inputs()).toHaveLength(1);
		fs.writeFileSync(
			path.join(f.root, "hook.cjs"),
			`const fs=require('node:fs');let s='';process.stdin.on('data',x=>s+=x);process.stdin.on('end',()=>{fs.appendFileSync(${JSON.stringify(f.capture)},s+'\\n');console.log('{}');});`,
		);
		await f.run("bash", { command: "node -p 42" });
		expect(f.session.messages.findLast((m) => m.role === "toolResult")).toMatchObject({ isError: false });
		expect(f.inputs()).toHaveLength(1);
		await f.run("bash", { command: "node -p 43" });
		expect(f.session.messages.findLast((m) => m.role === "toolResult")).toMatchObject({ isError: true });
		expect(f.inputs()).toHaveLength(2);
	} finally {
		await f.close();
	}
});

const update = (type: string, ruleContent: string, behavior = "allow", destination = "session") => ({
	type,
	rules: [{ toolName: "Bash", ruleContent }],
	behavior,
	destination,
});
async function sequenceCase(outputs: unknown[], commands: string[], expected: boolean[], hooks: number) {
	const f = await fixture("claude");
	try {
		fs.writeFileSync(
			path.join(f.root, "hook.cjs"),
			`const fs=require('node:fs');let s='';process.stdin.on('data',x=>s+=x);process.stdin.on('end',()=>{const p=${JSON.stringify(f.capture)};const n=fs.existsSync(p)?fs.readFileSync(p,'utf8').trim().split('\\n').filter(Boolean).length:0;fs.appendFileSync(p,s+'\\n');const outputs=${JSON.stringify(outputs)};console.log(JSON.stringify(outputs[n]??{}));});`,
		);
		for (let i = 0; i < commands.length; i++) {
			await f.run("bash", { command: commands[i] });
			expect(
				f.session.messages.findLast((m) => m.role === "toolResult"),
				`invocation ${i + 1}: ${JSON.stringify(f.session.messages.findLast((m) => m.role === "toolResult"))}`,
			).toMatchObject({ isError: !expected[i] });
		}
		expect(f.inputs()).toHaveLength(hooks);
	} finally {
		await f.close();
	}
}

it("a newly added deny affects the next call rather than the call approving it", async () => {
	await sequenceCase(
		[
			decision({
				behavior: "allow",
				updatedPermissions: [update("addRules", "node -p 41", "deny")],
			}),
		],
		["node -p 41", "node -p 41"],
		[true, false],
		1,
	);
});
it("session add and remove updates apply in call order", async () => {
	await sequenceCase(
		[
			decision({
				behavior: "allow",
				updatedPermissions: [update("addRules", "node -p 42")],
			}),
			decision({
				behavior: "allow",
				updatedPermissions: [update("removeRules", "node -p 42")],
			}),
		],
		["node -p 41", "node -p 43", "node -p 42"],
		[true, true, false],
		3,
	);
});
it("session replace rules removes the old grant while retaining the replacement grant", async () => {
	await sequenceCase(
		[
			decision({
				behavior: "allow",
				updatedPermissions: [update("addRules", "node -p 42")],
			}),
			decision({
				behavior: "allow",
				updatedPermissions: [update("replaceRules", "node -p 44")],
			}),
		],
		["node -p 41", "node -p 43", "node -p 42", "node -p 44"],
		[true, true, false, true],
		3,
	);
});
for (const reversed of [false, true])
	it(`same-list rule order is preserved: remove first ${reversed}`, async () => {
		const updates = [update("addRules", "node -p 42"), update("removeRules", "node -p 42")];
		if (reversed) updates.reverse();
		await sequenceCase(
			[decision({ behavior: "allow", updatedPermissions: updates })],
			["node -p 41", "node -p 42"],
			[true, reversed],
			reversed ? 1 : 2,
		);
	});
it("invalid replacement input cannot publish a session allowance", async () => {
	await sequenceCase(
		[
			decision({
				behavior: "allow",
				updatedInput: { command: 123 },
				updatedPermissions: [update("addRules", "node -p 42")],
			}),
		],
		["node -p 41", "node -p 42"],
		[false, false],
		2,
	);
});
it("a malformed later update invalidates the whole approval without partial publication", async () => {
	await sequenceCase(
		[
			decision({
				behavior: "allow",
				updatedPermissions: [update("addRules", "node -p 42"), { type: "unknown", destination: "session" }],
			}),
		],
		["node -p 41", "node -p 42"],
		[false, false],
		2,
	);
});

for (const destination of ["session", "userSettings", "localSettings"]) {
	it(`${destination} grant ${destination === "session" ? "expires" : "survives"} when a new actual session loads the same configuration`, async () => {
		const f = await fixture("claude", {
			output: decision({
				behavior: "allow",
				updatedPermissions: [update("addRules", "node -p 42", "allow", destination)],
			}),
		});
		try {
			await f.run("bash", { command: "node -p 41" });
			expect(f.session.messages.findLast((m) => m.role === "toolResult")).toMatchObject({ isError: false });
			fs.writeFileSync(
				path.join(f.root, "hook.cjs"),
				`const fs=require('node:fs');let s='';process.stdin.on('data',x=>s+=x);process.stdin.on('end',()=>{fs.appendFileSync(${JSON.stringify(f.capture)},s+'\\n');console.log('{}');});`,
			);
			await f.run("bash", { command: "node -p 42" });
			expect(f.session.messages.findLast((m) => m.role === "toolResult")).toMatchObject({ isError: false });
			await f.restart();
			await f.run("bash", { command: "node -p 42" });
			expect(f.session.messages.findLast((m) => m.role === "toolResult")).toMatchObject({
				isError: destination === "session",
			});
			expect(f.inputs()).toHaveLength(destination === "session" ? 2 : 1);
			if (destination !== "session") {
				const settings =
					destination === "userSettings"
						? path.join(f.configDir, "settings.json")
						: path.join(f.cwd, ".claude/settings.local.json");
				expect(JSON.parse(fs.readFileSync(settings, "utf8")).permissions.allow).toContain("Bash(node -p 42)");
			}
		} finally {
			await f.close();
		}
	});
}

it("source-denied replacement cannot retain its otherwise valid update", async () => {
	const f = await fixture("claude", {
		rules: { deny: ["Bash(node -p 99)"] },
		output: decision({
			behavior: "allow",
			updatedInput: { command: "node -p 99" },
			updatedPermissions: [update("addRules", "node -p 42")],
		}),
	});
	try {
		await f.run("bash", { command: "node -p 41" });
		expect(f.session.messages.findLast((m) => m.role === "toolResult")).toMatchObject({ isError: true });
		fs.writeFileSync(
			path.join(f.root, "hook.cjs"),
			`const fs=require('node:fs');let s='';process.stdin.on('data',x=>s+=x);process.stdin.on('end',()=>{fs.appendFileSync(${JSON.stringify(f.capture)},s+'\\n');console.log('{}');});`,
		);
		await f.run("bash", { command: "node -p 42" });
		expect(f.session.messages.findLast((m) => m.role === "toolResult")).toMatchObject({ isError: true });
		expect(f.inputs()).toHaveLength(2);
	} finally {
		await f.close();
	}
});

it("writing project permissions cannot trust unrelated project hooks", async () => {
	const f = await fixture("claude", {
		projectRules: {},
		projectTrusted: false,
		output: decision({
			behavior: "allow",
			updatedPermissions: [update("addRules", "node -p 42", "allow", "projectSettings")],
		}),
	});
	try {
		const config = path.join(f.cwd, ".claude/settings.json");
		const marker = path.join(f.cwd, "untrusted-hook.txt");
		fs.writeFileSync(
			config,
			JSON.stringify({
				permissions: {},
				hooks: {
					UserPromptSubmit: [
						{
							hooks: [
								{
									type: "command",
									command: `printf UNTRUSTED > '${marker.replaceAll("'", "'\\''")}'`,
								},
							],
						},
					],
				},
			}),
		);
		await f.session.reload();
		await f.run("bash", { command: "node -p 41" });
		expect(f.session.messages.findLast((m) => m.role === "toolResult")).toMatchObject({ isError: false });
		expect(JSON.parse(fs.readFileSync(config, "utf8")).permissions.allow).toContain("Bash(node -p 42)");
		fs.writeFileSync(
			path.join(f.root, "hook.cjs"),
			`const fs=require('node:fs');let s='';process.stdin.on('data',x=>s+=x);process.stdin.on('end',()=>{fs.appendFileSync(${JSON.stringify(f.capture)},s+'\\n');console.log('{}');});`,
		);
		await f.session.reload();
		await f.run("bash", { command: "node -p 42" });
		expect(f.session.messages.findLast((m) => m.role === "toolResult")).toMatchObject({ isError: true });
		expect(f.inputs()).toHaveLength(2);
		expect(fs.existsSync(marker)).toBe(false);
	} finally {
		await f.close();
	}
});

it("cancellation before a held update reply publishes no session grant", async () => {
	const f = await fixture("claude", {
		hold: true,
		output: decision({
			behavior: "allow",
			updatedPermissions: [update("addRules", "node -p 42")],
		}),
	});
	try {
		const running = f.run("bash", { command: "node -p 41" });
		await vi.waitFor(() => expect(f.inputs()).toHaveLength(1));
		await f.session.abort();
		await running;
		fs.writeFileSync(
			path.join(f.root, "hook.cjs"),
			`const fs=require('node:fs');let s='';process.stdin.on('data',x=>s+=x);process.stdin.on('end',()=>{fs.appendFileSync(${JSON.stringify(f.capture)},s+'\\n');console.log('{}');});`,
		);
		await f.run("bash", { command: "node -p 42" });
		expect(f.session.messages.findLast((m) => m.role === "toolResult")).toMatchObject({ isError: true });
		expect(f.inputs()).toHaveLength(2);
	} finally {
		await f.close();
	}
});

it("session acceptEdits update allows a later workspace Write without another hook", async () => {
	const f = await fixture("claude", {
		output: decision({
			behavior: "allow",
			updatedPermissions: [{ type: "setMode", mode: "acceptEdits", destination: "session" }],
		}),
	});
	try {
		await f.run("bash", { command: "node -p 41" });
		expect(f.session.messages.findLast((m) => m.role === "toolResult")).toMatchObject({ isError: false });
		await f.run("file", {
			queries: [
				{
					type: "write",
					path: "mode.txt",
					content: "MODE_WRITE",
					reason: "Mode acceptance",
				},
			],
		});
		expect(fs.readFileSync(path.join(f.cwd, "mode.txt"), "utf8")).toBe("MODE_WRITE");
		expect(f.inputs()).toHaveLength(1);
	} finally {
		await f.close();
	}
});

for (const [name, types, allowed] of [
	["control", [], false],
	["add", ["addDirectories"], true],
	["add-remove", ["addDirectories", "removeDirectories"], false],
	["remove-add", ["removeDirectories", "addDirectories"], true],
] as const) {
	it(`directory update ${name} controls the next outside Write`, async () => {
		const f = await fixture("claude");
		try {
			const outside = path.join(f.root, "outside.txt");
			const output = decision({
				behavior: "allow",
				updatedPermissions: [
					{ type: "setMode", mode: "acceptEdits", destination: "session" },
					...types.map((type) => ({
						type,
						directories: [f.root],
						destination: "session",
					})),
				],
			});
			fs.writeFileSync(
				path.join(f.root, "hook.cjs"),
				`const fs=require('node:fs');let s='';process.stdin.on('data',x=>s+=x);process.stdin.on('end',()=>{const p=${JSON.stringify(f.capture)};const first=!fs.existsSync(p);fs.appendFileSync(p,s+'\\n');console.log(JSON.stringify(first?${JSON.stringify(output)}:{}));});`,
			);
			await f.run("bash", { command: "node -p 41" });
			expect(f.session.messages.findLast((m) => m.role === "toolResult")).toMatchObject({ isError: false });
			await f.run("file", {
				queries: [
					{
						type: "write",
						path: outside,
						content: "OUTSIDE",
						reason: "Directory acceptance",
					},
				],
			});
			expect(fs.existsSync(outside)).toBe(allowed);
			if (allowed) expect(fs.readFileSync(outside, "utf8")).toBe("OUTSIDE");
			expect(f.inputs()).toHaveLength(allowed ? 1 : 2);
		} finally {
			await f.close();
		}
	});
}

it("a canceled losing handler cannot publish its permission updates", async () => {
	const f = await fixture("claude", { secondOutput: {} });
	try {
		const loser = path.join(f.root, "loser.cjs"),
			started = path.join(f.root, "loser-started");
		fs.writeFileSync(
			loser,
			`const fs=require('node:fs');fs.writeFileSync(${JSON.stringify(started)},String(process.pid));setTimeout(()=>console.log(${JSON.stringify(JSON.stringify(decision({ behavior: "allow", updatedPermissions: [update("addRules", "node -p 42")] })))}),10000);`,
		);
		const configPath = path.join(f.configDir, "settings.json"),
			config = JSON.parse(fs.readFileSync(configPath, "utf8"));
		const quote = (s: string) => `'${s.replaceAll("'", "'\\''")}'`;
		config.hooks.PermissionRequest[0].hooks[1].command = `${quote(process.execPath)} ${quote(loser)}`;
		fs.writeFileSync(configPath, JSON.stringify(config));
		fs.writeFileSync(
			path.join(f.root, "hook.cjs"),
			`const fs=require('node:fs');let s='';process.stdin.on('data',x=>s+=x);process.stdin.on('end',()=>{fs.appendFileSync(${JSON.stringify(f.capture)},s+'\\n');while(!fs.existsSync(${JSON.stringify(started)}))Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,10);console.log(${JSON.stringify(JSON.stringify(decision({ behavior: "allow" })))});});`,
		);
		await f.session.reload();
		await f.run("bash", { command: "node -p 41" });
		expect(f.session.messages.findLast((m) => m.role === "toolResult")).toMatchObject({ isError: false });
		const pid = Number(fs.readFileSync(started, "utf8"));
		expect(() => process.kill(pid, 0)).toThrow();
		fs.writeFileSync(loser, "console.log('{}');");
		fs.writeFileSync(
			path.join(f.root, "hook.cjs"),
			`const fs=require('node:fs');let s='';process.stdin.on('data',x=>s+=x);process.stdin.on('end',()=>{fs.appendFileSync(${JSON.stringify(f.capture)},s+'\\n');console.log('{}');});`,
		);
		await f.run("bash", { command: "node -p 42" });
		expect(f.session.messages.findLast((m) => m.role === "toolResult")).toMatchObject({ isError: true });
		expect(f.inputs()).toHaveLength(2);
	} finally {
		await f.close();
	}
});

it("an approved command's execution failure does not roll back its session update", async () => {
	await sequenceCase(
		[
			decision({
				behavior: "allow",
				updatedPermissions: [update("addRules", "node -p 42")],
			}),
		],
		["node -e 'process.exit(7)'", "node -p 42"],
		[false, true],
		1,
	);
});

it("a trusted project permission update authorizes its next matching command", async () => {
	const f = await fixture("claude", {
		projectRules: {},
		projectTrusted: true,
		output: decision({
			behavior: "allow",
			updatedPermissions: [update("addRules", "node -p 42", "allow", "projectSettings")],
		}),
	});
	try {
		await f.run("bash", { command: "node -p 41" });
		expect(f.session.messages.findLast((m) => m.role === "toolResult")).toMatchObject({ isError: false });
		fs.writeFileSync(
			path.join(f.root, "hook.cjs"),
			`const fs=require('node:fs');let s='';process.stdin.on('data',x=>s+=x);process.stdin.on('end',()=>{fs.appendFileSync(${JSON.stringify(f.capture)},s+'\\n');console.log('{}');});`,
		);
		await f.run("bash", { command: "node -p 42" });
		expect(f.session.messages.findLast((m) => m.role === "toolResult")).toMatchObject({ isError: false });
		expect(f.inputs()).toHaveLength(1);
	} finally {
		await f.close();
	}
});

it.skipIf(process.getuid?.() === 0)(
	"failed atomic permission persistence keeps valid settings intact and applies the transient approval",
	async () => {
		const f = await fixture("claude", {
			projectRules: {},
			projectTrusted: true,
			hold: true,
			output: decision({
				behavior: "allow",
				updatedPermissions: [update("addRules", "node -p 42", "allow", "projectSettings")],
			}),
		});
		const directory = path.join(f.cwd, ".claude"),
			config = path.join(directory, "settings.json"),
			mode = fs.statSync(directory).mode & 0o777;
		try {
			expect(process.getuid?.()).not.toBe(0);
			const original = fs.readFileSync(config, "utf8");
			const pending = f.run("bash", { command: "node -p 41" });
			await vi.waitFor(() => expect(f.inputs()).toHaveLength(1));
			fs.chmodSync(directory, 0o555);
			expect(() => fs.writeFileSync(path.join(directory, "permission-write-probe"), "must not write")).toThrow();
			fs.writeFileSync(path.join(f.root, "release"), "release");
			await pending;
			expect(f.session.messages.findLast((m) => m.role === "toolResult")).toMatchObject({ isError: false });
			expect(fs.readFileSync(config, "utf8")).toBe(original);
			fs.chmodSync(directory, mode);
			fs.writeFileSync(
				path.join(f.root, "hook.cjs"),
				`const fs=require('node:fs');let s='';process.stdin.on('data',x=>s+=x);process.stdin.on('end',()=>{fs.appendFileSync(${JSON.stringify(f.capture)},s+'\\n');console.log('{}');});`,
			);
			await f.run("bash", { command: "node -p 42" });
			expect(f.session.messages.findLast((m) => m.role === "toolResult")).toMatchObject({ isError: false });
			expect(f.inputs()).toHaveLength(1);
		} finally {
			fs.chmodSync(directory, mode);
			await f.close();
		}
	},
);

for (const standalone of [false, true]) {
	it(`external source denial during settings write blocks ${standalone ? "SDK Write" : "native Bash"}`, async () => {
		const f = await fixture("claude", {
			projectRules: {},
			fileWriteTool: standalone,
			output: decision({
				behavior: "allow",
				updatedPermissions: [update("addRules", "node -p 42", "allow", "userSettings")],
			}),
		});
		let release!: () => void;
		let held: Promise<void> | undefined;
		let pending: Promise<void> | undefined;
		let restoreObserver: (() => void) | undefined;
		try {
			const settings = path.join(f.configDir, "settings.json"),
				target = fs.realpathSync(settings);
			let acquired!: () => void;
			const acquiredPromise = new Promise<void>((r) => (acquired = r));
			held = withFileWriteLock(settings, async () => {
				acquired();
				await new Promise<void>((r) => (release = r));
			});
			await acquiredPromise;
			const originalLock = lockfile.lock.bind(lockfile);
			let contended = false;
			const observer = vi
				.spyOn(lockfile, "lock")
				.mockImplementation(async (...args: Parameters<typeof lockfile.lock>) => {
					try {
						return await originalLock(...args);
					} catch (error) {
						if (args[0] === target && (error as NodeJS.ErrnoException).code === "ELOCKED") contended = true;
						throw error;
					}
				});
			restoreObserver = () => observer.mockRestore();
			const command = "printf MUST_NOT_RUN > raced-effect.txt";
			pending = standalone
				? f.run("write", { path: "raced-effect.txt", content: "MUST_NOT_RUN" })
				: f.run("bash", { command });
			await vi.waitFor(() => expect(contended).toBe(true), { timeout: 5000 });
			fs.writeFileSync(
				path.join(f.cwd, ".claude/settings.json"),
				JSON.stringify({
					permissions: {
						deny: [standalone ? "Write(./raced-effect.txt)" : "Bash(printf MUST_NOT_RUN*)"],
					},
				}),
			);
			release();
			await held;
			await pending;
			expect(fs.existsSync(path.join(f.cwd, "raced-effect.txt"))).toBe(false);
			expect(f.session.messages.findLast((m) => m.role === "toolResult")).toMatchObject({ isError: true });
		} finally {
			release?.();
			await held;
			await pending;
			restoreObserver?.();
			await f.close();
		}
	});
}

it("cancellation while a real settings write waits prevents publication and command execution", async () => {
	const f = await fixture("claude", {
		output: decision({
			behavior: "allow",
			updatedPermissions: [update("addRules", "node -p 42", "allow", "userSettings")],
		}),
	});
	let release!: () => void;
	let held: Promise<void> | undefined;
	let pending: Promise<void> | undefined;
	let restoreObserver: (() => void) | undefined;
	try {
		const settings = path.join(f.configDir, "settings.json"),
			target = fs.realpathSync(settings),
			before = fs.readFileSync(settings, "utf8");
		let acquired!: () => void;
		const acquiredPromise = new Promise<void>((r) => (acquired = r));
		held = withFileWriteLock(settings, async () => {
			acquired();
			await new Promise<void>((r) => (release = r));
		});
		await acquiredPromise;
		const originalLock = lockfile.lock.bind(lockfile);
		let contended = false;
		const observer = vi
			.spyOn(lockfile, "lock")
			.mockImplementation(async (...args: Parameters<typeof lockfile.lock>) => {
				try {
					return await originalLock(...args);
				} catch (error) {
					if (args[0] === target && (error as NodeJS.ErrnoException).code === "ELOCKED") contended = true;
					throw error;
				}
			});
		restoreObserver = () => observer.mockRestore();
		pending = f.run("bash", {
			command: "printf MUST_NOT_RUN > canceled-effect.txt",
		});
		await vi.waitFor(() => expect(contended).toBe(true), { timeout: 5000 });
		const aborted = f.session.abort();
		release();
		await held;
		await pending;
		await aborted;
		expect(fs.existsSync(path.join(f.cwd, "canceled-effect.txt"))).toBe(false);
		expect(fs.readFileSync(settings, "utf8")).toBe(before);
	} finally {
		release?.();
		await held;
		await pending;
		restoreObserver?.();
		await f.close();
	}
});

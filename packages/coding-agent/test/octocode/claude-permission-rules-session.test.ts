import fs from "node:fs";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { fixture } from "./permission-session-fixture.ts";
afterEach(() => vi.unstubAllEnvs());
it("Claude source deny blocks native full before permission approval", async () => {
	const f = await fixture("claude", {
		mode: "full",
		rules: { deny: ["Bash"] },
	});
	try {
		await f.run();
		expect(fs.existsSync(f.marker)).toBe(false);
		expect(f.inputs()).toEqual([]);
		expect(f.session.messages.findLast((m) => m.role === "toolResult")).toMatchObject({ isError: true });
	} finally {
		await f.close();
	}
});
it("Claude source ask reaches PermissionRequest before native full and accepts its original-input allowance", async () => {
	const f = await fixture("claude", { mode: "full", rules: { ask: ["Bash"] } });
	try {
		await f.run();
		expect(f.inputs()).toHaveLength(1);
		expect(fs.readFileSync(f.marker, "utf8")).toBe("PERMISSION_EFFECT");
	} finally {
		await f.close();
	}
});
it("Claude source ask stays unresolved when full mode has no enabled hook resolver", async () => {
	const f = await fixture("claude", {
		mode: "full",
		rules: { ask: ["Bash"] },
		hooksEnabled: false,
	});
	try {
		await f.run();
		expect(fs.existsSync(f.marker)).toBe(false);
		expect(f.inputs()).toEqual([]);
	} finally {
		await f.close();
	}
});
it("source rules remain inactive without compatibility opt-in", async () => {
	const f = await fixture("claude", {
		mode: "full",
		rules: { deny: ["Bash"] },
		compatibility: false,
	});
	try {
		await f.run();
		expect(fs.readFileSync(f.marker, "utf8")).toBe("PERMISSION_EFFECT");
	} finally {
		await f.close();
	}
});
it("source policy honors custom CLAUDE_CONFIG_DIR", async () => {
	const f = await fixture("claude", {
		mode: "full",
		rules: { deny: ["Bash"] },
		customClaudeHome: true,
	});
	try {
		await f.run();
		expect(fs.existsSync(f.marker)).toBe(false);
	} finally {
		await f.close();
	}
});
it.each([false, true])("restrictive project permission rules apply with project trust=%s", async (projectTrusted) => {
	const f = await fixture("claude", {
		mode: "full",
		projectRules: { deny: ["Bash"] },
		projectTrusted,
	});
	try {
		await f.run();
		expect(fs.existsSync(f.marker)).toBe(false);
	} finally {
		await f.close();
	}
});
it("user deny cannot be replaced by trusted project allow", async () => {
	const f = await fixture("claude", {
		mode: "full",
		rules: { deny: ["Bash"] },
		projectRules: { allow: ["Bash"] },
		projectTrusted: true,
	});
	try {
		await f.run();
		expect(fs.existsSync(f.marker)).toBe(false);
	} finally {
		await f.close();
	}
});
it("tool-name glob denies an otherwise unclassified custom invocation", async () => {
	const f = await fixture("claude", {
		mode: "full",
		rules: { deny: ["nested_permission_*"] },
	});
	try {
		await f.run("nested_permission_fixture", {});
		expect(fs.existsSync(path.join(f.cwd, "nested-a.txt"))).toBe(false);
		expect(fs.existsSync(path.join(f.cwd, "nested-b.txt"))).toBe(false);
		expect(f.session.messages.findLast((m) => m.role === "toolResult")).toMatchObject({ isError: true });
	} finally {
		await f.close();
	}
});
it.each([false, true])("source Read rule reaches a real read-only tool, deny=%s", async (denied) => {
	const f = await fixture("claude", {
		mode: "full",
		rules: denied ? { deny: ["Read"] } : {},
		readTool: true,
	});
	try {
		const secret = path.join(f.cwd, "secret.txt");
		fs.writeFileSync(secret, "READ_POLICY_EVIDENCE");
		await f.run("read", { path: secret });
		const result = f.session.messages.findLast((m) => m.role === "toolResult");
		expect(result, JSON.stringify(result)).toMatchObject({ isError: denied });
		expect(JSON.stringify(result).includes("READ_POLICY_EVIDENCE")).toBe(!denied);
	} finally {
		await f.close();
	}
});
it("a later denied native file batch member prevents all batch effects", async () => {
	const f = await fixture("claude", {
		mode: "full",
		rules: { deny: ["Edit(./forbidden.txt)"] },
	});
	try {
		const first = path.join(f.cwd, "permitted.txt"),
			second = path.join(f.cwd, "forbidden.txt");
		await f.run("file", {
			queries: [
				{
					type: "write",
					path: first,
					content: "FIRST\n",
					reason: "Fixture",
				},
				{
					type: "write",
					path: second,
					content: "SECOND\n",
					reason: "Denied fixture",
				},
			],
		});
		expect(fs.existsSync(first)).toBe(false);
		expect(fs.existsSync(second)).toBe(false);
	} finally {
		await f.close();
	}
});

it("removing a reloaded source deny restores originally active tools without reviving user-disabled tools", async () => {
	const f = await fixture("claude", { mode: "full" });
	try {
		const original = f.session.getActiveToolNames();
		expect(original).toContain("bash");
		expect(original).toContain("web");
		f.session.setActiveToolsByName(original.filter((name) => name !== "web"));
		const settingsFile = path.join(f.configDir, "settings.json");
		const config = JSON.parse(fs.readFileSync(settingsFile, "utf8"));
		fs.writeFileSync(settingsFile, JSON.stringify({ ...config, permissions: { deny: ["Bash"] } }));
		await f.session.reload();
		expect(f.session.getActiveToolNames()).not.toContain("bash");
		expect(f.session.getActiveToolNames()).not.toContain("web");
		await f.run();
		expect(fs.existsSync(f.marker)).toBe(false);
		expect(f.session.messages.findLast((m) => m.role === "toolResult")).toMatchObject({ isError: true });
		expect(f.session.getActiveToolNames()).not.toContain("web");
		fs.writeFileSync(settingsFile, JSON.stringify(config));
		await f.session.reload();
		expect(f.session.getActiveToolNames().sort()).toEqual(original.filter((name) => name !== "web").sort());
		await f.run();
		expect(fs.readFileSync(f.marker, "utf8")).toBe("PERMISSION_EFFECT");
	} finally {
		await f.close();
	}
});
it("source ask on one native file invocation resolves once across outer and internal permission owners", async () => {
	const f = await fixture("claude", { mode: "full", rules: { ask: ["Edit"] } });
	try {
		await f.run("file", {
			queries: [
				{
					type: "write",
					path: f.marker,
					content: "ASK_FILE_ONCE\n",
					reason: "Ask rule fixture",
				},
			],
		});
		expect(fs.readFileSync(f.marker, "utf8")).toBe("ASK_FILE_ONCE\n");
		expect(f.inputs()).toHaveLength(1);
	} finally {
		await f.close();
	}
});

it.each([false, true])("deferred read-only MCP invoked by another tool obeys source deny=%s", async (denied) => {
	const f = await fixture("claude", {
		mode: "full",
		deferredMcp: true,
		rules: denied ? { deny: ["mcp__policy__*"] } : {},
	});
	let pid: number | undefined;
	try {
		await f.session.prompt("/mcp tools policy");
		// The listed tool must be registered in the session, not only listed by the server, before the nested call.
		await vi.waitFor(
			() => expect(f.session.getAllTools().some((tool) => tool.name === "mcp__policy__observe")).toBe(true),
			{ timeout: 5000 },
		);
		await f.run("nested_mcp_policy_fixture", {});
		const records = f.mcpRecords();
		expect(records.some((record) => record.message.method === "initialize")).toBe(true);
		pid = records[0].pid;
		expect(records.filter((record) => record.message.method === "tools/call")).toHaveLength(denied ? 0 : 1);
		const result = f.session.messages.findLast((m) => m.role === "toolResult");
		expect(JSON.stringify(result).includes("DEFERRED_MCP_READ_EVIDENCE")).toBe(!denied);
	} finally {
		await f.close();
		if (pid) expect(() => process.kill(pid!, 0)).toThrow();
	}
});

it("untrusted project allow cannot authorize a native manual request", async () => {
	const f = await fixture("claude", {
		mode: "manual",
		projectRules: { allow: ["Bash"] },
		projectTrusted: false,
		hooksEnabled: false,
	});
	try {
		await f.run();
		expect(fs.existsSync(f.marker)).toBe(false);
		expect(f.session.messages.findLast((m) => m.role === "toolResult")).toMatchObject({ isError: true });
	} finally {
		await f.close();
	}
});

it("trusted project allow resolves an ordinary native manual request without hooks", async () => {
	const f = await fixture("claude", {
		mode: "manual",
		projectRules: { allow: ["Bash"] },
		projectTrusted: true,
		hooksEnabled: false,
	});
	try {
		await f.run();
		expect(fs.readFileSync(f.marker, "utf8")).toBe("PERMISSION_EFFECT");
		expect(f.inputs()).toEqual([]);
	} finally {
		await f.close();
	}
});
it("source allow cannot bypass the native unread-file mutation guard", async () => {
	const f = await fixture("claude", {
		mode: "manual",
		rules: { allow: ["Edit"] },
		hooksEnabled: false,
	});
	try {
		fs.writeFileSync(f.marker, "ORIGINAL_GUARDED_CONTENT\n");
		await f.run("file", {
			queries: [
				{
					type: "write",
					path: f.marker,
					content: "UNAPPROVED_REPLACEMENT\n",
					reason: "Guard acceptance",
				},
			],
		});
		expect(fs.readFileSync(f.marker, "utf8")).toBe("ORIGINAL_GUARDED_CONTENT\n");
		expect(f.session.messages.findLast((m) => m.role === "toolResult")).toMatchObject({ isError: true });
	} finally {
		await f.close();
	}
});
it("source allow cannot bypass native state-folder protection", async () => {
	const f = await fixture("claude", {
		mode: "full",
		rules: { allow: ["Edit"] },
		hooksEnabled: false,
	});
	try {
		const target = path.join(f.root, "home/.octocode/invariant-target.txt");
		await f.run("file", {
			queries: [
				{
					type: "write",
					path: target,
					content: "UNAPPROVED_STATE\n",
					reason: "Guard acceptance",
				},
			],
		});
		expect(fs.existsSync(target)).toBe(false);
		expect(f.session.messages.findLast((m) => m.role === "toolResult")).toMatchObject({ isError: true });
	} finally {
		await f.close();
	}
});

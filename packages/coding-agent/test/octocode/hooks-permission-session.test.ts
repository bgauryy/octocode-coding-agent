import fs from "node:fs";
import path from "node:path";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, expect, it, vi } from "vitest";
import { fixture } from "./permission-session-fixture.ts";
afterEach(() => vi.unstubAllEnvs());
it.each(["claude", "codex"] as const)(
	"resolves an unresolved headless manual Bash request with a real %s permission hook",
	async (protocol) => {
		const f = await fixture(protocol);
		try {
			await f.run();
			const result = f.session.messages.findLast(
				(m) => m.role === "toolResult",
			);
			expect(result, JSON.stringify(result)).toMatchObject({ isError: false });
			expect(fs.readFileSync(f.marker, "utf8")).toBe("PERMISSION_EFFECT");
			const inputs = fs
				.readFileSync(f.capture, "utf8")
				.trim()
				.split("\n")
				.map((s) => JSON.parse(s));
			expect(inputs).toHaveLength(1);
			expect(inputs[0].session_id).toBe(
				f.session.sessionManager.getSessionId(),
			);
			expect(inputs[0].transcript_path).toBe(
				f.session.sessionManager.getSessionFile(),
			);
			expect(inputs[0].cwd).toBe(f.cwd);
			expect(inputs[0].permission_mode).toBe("default");
			expect(inputs[0]).not.toHaveProperty("tool_use_id");
			if (protocol === "codex") {
				expect(inputs[0].model).toBe("fixture");
				expect(inputs[0].turn_id).toEqual(expect.any(String));
			}
			expect(inputs[0]).toMatchObject({
				hook_event_name: "PermissionRequest",
				tool_name: "Bash",
			});
		} finally {
			await f.close();
		}
	},
);

const decision = (
	behavior: "allow" | "deny",
	extra: Record<string, unknown> = {},
) => ({
	hookSpecificOutput: {
		hookEventName: "PermissionRequest",
		decision: { behavior, ...extra },
	},
});
for (const protocol of ["claude", "codex"] as const) {
	it(`${protocol} does not request permission for an automatic full-mode allowance`, async () => {
		const f = await fixture(protocol, {
			mode: "full",
			output: decision("deny"),
		});
		try {
			await f.run();
			expect(fs.readFileSync(f.marker, "utf8")).toBe("PERMISSION_EFFECT");
			expect(f.inputs()).toEqual([]);
		} finally {
			await f.close();
		}
	});
	it.each([
		["deny", decision("deny", { message: "EXPLICIT_DENIAL" })],
		["no decision", {}],
		[
			"malformed source output",
			{
				hookSpecificOutput: {
					hookEventName: "PreToolUse",
					permissionDecision: "allow",
				},
			},
		],
		[
			protocol === "claude"
				? "malformed input rewrite"
				: "unsupported input rewrite",
			decision("allow", {
				updatedInput: {
					command: protocol === "claude" ? 123 : "printf CHANGED",
				},
			}),
		],
		[
			"unsupported rules",
			decision("allow", {
				updatedPermissions: protocol === "claude" ? [{ type: "addRules" }] : [],
			}),
		],
	])(`${protocol} cannot silently allow %s`, async (_name, output) => {
		const f = await fixture(protocol, { output });
		try {
			await f.run();
			expect(
				f.session.messages.findLast((m) => m.role === "toolResult"),
			).toMatchObject({ isError: true });
			expect(fs.existsSync(f.marker)).toBe(false);
			expect(f.inputs()).toHaveLength(1);
		} finally {
			await f.close();
		}
	});
	if (protocol === "codex") {
		it(`${protocol} honors deny precedence across permission handlers`, async () => {
			const f = await fixture(protocol, {
				output: decision("allow"),
				secondOutput: decision("deny", { message: "FINAL_DENY" }),
			});
			try {
				await f.run();
				expect(
					f.session.messages.findLast((m) => m.role === "toolResult"),
				).toMatchObject({ isError: true });
				expect(fs.existsSync(f.marker)).toBe(false);
				expect(f.inputs()).toHaveLength(1);
			} finally {
				await f.close();
			}
		});
	}

	it(`${protocol} keeps an unmatched request unresolved`, async () => {
		const f = await fixture(protocol, { matcher: "NotThisTool" });
		try {
			await f.run();
			expect(
				f.session.messages.findLast((m) => m.role === "toolResult"),
			).toMatchObject({ isError: true });
			expect(fs.existsSync(f.marker)).toBe(false);
			expect(f.inputs()).toEqual([]);
		} finally {
			await f.close();
		}
	});
	it(`${protocol} cannot reuse a cancelled permission answer`, async () => {
		const f = await fixture(protocol, { hold: true });
		try {
			const running = f.run();
			await vi.waitFor(() => expect(f.inputs()).toHaveLength(1));
			await f.session.abort();
			await running;
			expect(f.providerRequests).toBe(1);
			expect(fs.existsSync(f.marker)).toBe(false);
			const pid = Number(
				fs.readFileSync(path.join(f.root, "hook.pid"), "utf8"),
			);
			expect(() => process.kill(pid, 0)).toThrow();
		} finally {
			fs.writeFileSync(path.join(f.root, "release"), "");
			await f.close();
		}
	});
	it(`${protocol} resolves a native file owner's internal permission request`, async () => {
		const f = await fixture(protocol);
		try {
			await f.run("file", {
				queries: [
					{
						type: "write",
						path: f.marker,
						content: "PERMISSION_EFFECT\n",
						reasoning: "Acceptance fixture",
					},
				],
			});
			expect(
				f.session.messages.findLast((m) => m.role === "toolResult"),
			).toMatchObject({ isError: false });
			expect(fs.readFileSync(f.marker, "utf8")).toBe("PERMISSION_EFFECT\n");
			expect(f.inputs()).toHaveLength(1);
		} finally {
			await f.close();
		}
	});
}

it.each(["claude", "codex"] as const)(
	"%s resolves actual private-network internal asks without bypassing the network owner",
	async (protocol) => {
		const f = await fixture(protocol);
		let requests = 0;
		const server = createServer((_req, res) => {
			requests++;
			res.writeHead(200, { "content-type": "text/plain" });
			res.end("LOCAL_NETWORK_PERMISSION_EVIDENCE");
		});
		await new Promise<void>((resolve) =>
			server.listen(0, "127.0.0.1", resolve),
		);
		try {
			const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/safe`;
			await f.run("web", { url });
			const result = f.session.messages.findLast(
				(m) => m.role === "toolResult",
			);
			expect(result, JSON.stringify(result)).toMatchObject({ isError: false });
			expect(JSON.stringify(result)).toContain(
				"LOCAL_NETWORK_PERMISSION_EVIDENCE",
			);
			expect(requests).toBe(1);
			expect(f.inputs()).toHaveLength(1);
			expect(f.inputs()[0].tool_input).toMatchObject({ url });
		} finally {
			await f.close();
			server.closeAllConnections();
			await new Promise<void>((resolve) => server.close(() => resolve()));
		}
	},
);

it.each(["claude", "codex"] as const)(
	"%s handles exit 2 with stderr according to its source contract",
	async (protocol) => {
		const f = await fixture(protocol, {
			output: {},
			exit: 2,
			stderr: "SOURCE_EXIT_TWO",
			secondOutput: decision("allow"),
		});
		try {
			await f.run();
			expect(f.inputs()).toHaveLength(1);
			expect(fs.existsSync(f.marker)).toBe(protocol === "claude");
			expect(
				f.session.messages.findLast((m) => m.role === "toolResult"),
			).toMatchObject({ isError: protocol === "codex" });
		} finally {
			await f.close();
		}
	},
);
it.each(["claude", "codex"] as const)(
	"%s carries distinct real nested parallel invocations into internal file permission requests",
	async (protocol) => {
		const f = await fixture(protocol);
		try {
			await f.run("nested_permission_fixture", {});
			expect(fs.readFileSync(path.join(f.cwd, "nested-a.txt"), "utf8")).toBe(
				"nested-a.txt\n",
			);
			expect(fs.readFileSync(path.join(f.cwd, "nested-b.txt"), "utf8")).toBe(
				"nested-b.txt\n",
			);
			const inputs = f.inputs();
			expect(inputs).toHaveLength(2);
			expect(JSON.stringify(inputs)).toContain("nested-a.txt");
			expect(JSON.stringify(inputs)).toContain("nested-b.txt");
			for (const input of inputs) {
				expect(input.tool_name).not.toBe("nested_permission_fixture");
				expect(input.session_id).toBe(f.session.sessionManager.getSessionId());
			}
		} finally {
			await f.close();
		}
	},
);

it.each(["claude", "codex"] as const)(
	"%s cannot override an earlier tool gate denial with permission allow",
	async (protocol) => {
		const f = await fixture(protocol, { preDeny: true });
		try {
			await f.run();
			expect(fs.existsSync(f.marker)).toBe(false);
			expect(f.inputs()).toEqual([]);
			expect(
				JSON.stringify(
					f.session.messages.findLast((m) => m.role === "toolResult"),
				),
			).toContain("PRE_GATE_DENIAL");
		} finally {
			await f.close();
		}
	},
);

it("Claude cannot use one file approval to authorize another effect in a native batch", async () => {
	const f = await fixture("claude", { conditionalPath: true });
	const permitted = path.join(f.cwd, "permitted.txt"),
		unapproved = path.join(f.root, "unapproved.txt");
	try {
		await f.run("file", {
			queries: [
				{
					type: "write",
					path: permitted,
					content: "PERMITTED\n",
					reasoning: "Allowed fixture",
				},
				{
					type: "write",
					path: unapproved,
					content: "UNAPPROVED\n",
					reasoning: "Must still ask",
				},
			],
		});
		expect(fs.existsSync(unapproved)).toBe(false);
		expect(
			f.inputs().some((input) => input.tool_input.file_path === unapproved),
		).toBe(true);
	} finally {
		await f.close();
	}
});

it.each([false, true])(
	"Claude deny interrupt=%s controls continuation after auditing the refusal",
	async (interrupt) => {
		const f = await fixture("claude", {
			output: decision("deny", {
				message: "DENY_INTERRUPT_FIXTURE",
				interrupt,
			}),
		});
		try {
			await f.run();
			expect(fs.existsSync(f.marker)).toBe(false);
			expect(f.inputs()).toHaveLength(1);
			expect(f.providerRequests).toBe(interrupt ? 1 : 2);
			expect(JSON.stringify(f.session.sessionManager.getEntries())).toContain(
				"DENY_INTERRUPT_FIXTURE",
			);
		} finally {
			await f.close();
		}
	},
);

it("Claude universal stop takes precedence over a nested permission allowance", async () => {
	const f = await fixture("claude", {
		output: {
			continue: false,
			stopReason: "UNIVERSAL_PERMISSION_STOP",
			...decision("allow"),
		},
	});
	try {
		await f.run();
		expect(fs.existsSync(f.marker)).toBe(false);
		expect(f.providerRequests).toBe(1);
		expect(f.inputs()).toHaveLength(1);
		expect(JSON.stringify(f.session.sessionManager.getEntries())).toContain(
			"UNIVERSAL_PERMISSION_STOP",
		);
	} finally {
		await f.close();
	}
});

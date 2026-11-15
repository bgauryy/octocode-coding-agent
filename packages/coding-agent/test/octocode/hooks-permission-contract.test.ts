import { expect, it } from "vitest";
import { interpret } from "../../src/octocode/hooks/runner.ts";
import { parseHooks } from "../../src/octocode/hooks/config/parse.ts";
import { commandsFor } from "../../src/octocode/hooks/config/calls.ts";
import { HOOK_SETTINGS } from "./helpers.ts";
import { approveFixtureHooks } from "./guard-helpers.ts";
const run = (stdout: string, code = 0, stderr = "") => ({
	stdout,
	code,
	stderr,
	timedOut: false,
});
const output = (decision: unknown) =>
	JSON.stringify({
		hookSpecificOutput: { hookEventName: "PermissionRequest", decision },
	});
it.each(["claude", "codex"] as const)("parses %s permission decisions without generic gate semantics", (protocol) => {
	expect(interpret("PermissionRequest" as any, run(output({ behavior: "allow" })), protocol)).toHaveProperty(
		"permissionDecision",
		"allow",
	);
	expect(
		interpret("PermissionRequest" as any, run(output({ behavior: "deny", message: "no" })), protocol),
	).toHaveProperty("permissionDecision", "deny");
	for (const field of [
		...(protocol === "codex"
			? [{ updatedInput: {} }, { updatedPermissions: [] }]
			: [{ updatedPermissions: [{ type: "addRules" }] }]),
		...(protocol === "codex" ? [{ interrupt: true }] : []),
	])
		expect(
			interpret("PermissionRequest" as any, run(output({ behavior: "allow", ...field })), protocol).error,
		).toBeDefined();
});
it("keeps source exit-two behavior distinct", () => {
	expect(interpret("PermissionRequest" as any, run("", 2, "refused"), "codex")).toHaveProperty(
		"permissionDecision",
		"deny",
	);
	expect(interpret("PermissionRequest" as any, run("", 2, "refused"), "claude")).not.toHaveProperty(
		"permissionDecision",
	);
});
it("loads source PermissionRequest with tool matching but excludes native dialect", () => {
	for (const protocol of ["claude", "codex"] as const) {
		const errors: string[] = [];
		const config = parseHooks(
			{
				hooks: {
					PermissionRequest: [{ matcher: "Bash", hooks: [{ type: "command", command: "true" }] }],
				},
			},
			"fixture",
			undefined,
			errors,
			undefined,
			protocol,
		);
		expect(errors).toEqual([]);
		expect(commandsFor(config, "PermissionRequest" as any, ["Bash"])).toHaveLength(1);
		expect(commandsFor(config, "PermissionRequest" as any, ["Write"])).toHaveLength(0);
	}
});

it("Claude deny interrupt is explicit and Codex rejects it", () => {
	expect(interpret("PermissionRequest", run(output({ behavior: "deny", interrupt: true })), "claude")).toHaveProperty(
		"permissionInterrupt",
		true,
	);
});

it("cannot bypass an unrepresentable required Codex file policy with a Claude allow", async () => {
	const fs = await import("node:fs");
	const path = await import("node:path");
	const { tmp } = await import("./helpers.ts");
	const { fakeHost, fakeCtx } = await import("./fake-host.ts");
	const { registerHooks } = await import("../../src/octocode/hooks/register.ts");
	const { captureToolInvocation } = await import("../../src/core/tools/tool-invocation.ts");
	const home = tmp();
	for (const dir of [".claude", ".codex"]) fs.mkdirSync(path.join(home, dir));
	const allow = "printf '%s' '" + output({ behavior: "allow" }) + "'";
	fs.writeFileSync(
		path.join(home, ".claude/settings.json"),
		JSON.stringify({
			hooks: {
				PermissionRequest: [{ matcher: "Edit", hooks: [{ type: "command", command: allow }] }],
			},
		}),
	);
	fs.writeFileSync(
		path.join(home, ".codex/hooks.json"),
		JSON.stringify({
			hooks: {
				PermissionRequest: [
					{
						matcher: "apply_patch",
						hooks: [{ type: "command", command: allow, failClosed: true }],
					},
				],
			},
		}),
	);
	const fake = fakeHost(HOOK_SETTINGS),
		ctx = fakeCtx({ cwd: tmp(), hasUI: false });
	const hooks = registerHooks(fake.api, { env: {}, home });
	approveFixtureHooks(ctx.cwd, home);
	await fake.fire("session_start", { reason: "startup" }, ctx);
	const invocation = captureToolInvocation("file", "file", {
		queries: [
			{
				type: "edit",
				path: "target",
				reason: "edit",
				edits: [{ oldText: "a", newText: "b" }],
			},
		],
	})!;
	expect(await hooks.permissionRequest(invocation, ctx, new AbortController().signal)).toMatchObject({
		decision: "deny",
	});
});

it("retains required invalid permission handlers without executing unsupported transports", () => {
	const errors: string[] = [];
	const config = parseHooks(
		{
			hooks: {
				PermissionRequest: [
					{
						matcher: "Bash",
						hooks: [{ type: "agent", prompt: "deny", failClosed: true }],
					},
				],
			},
		},
		"fixture",
		undefined,
		errors,
		undefined,
		"claude",
	);
	expect(errors.join(" ")).toMatch(/failClosed denies/);
	expect(commandsFor(config, "PermissionRequest", ["Bash"])[0]).toMatchObject({
		failClosed: true,
		configurationError: expect.any(String),
	});
});

it.each([false, true])("keeps invalid Codex effects neutral unless failClosed=%s", async (required) => {
	const fs = await import("node:fs");
	const path = await import("node:path");
	const { tmp } = await import("./helpers.ts");
	const { fakeHost, fakeCtx } = await import("./fake-host.ts");
	const { registerHooks } = await import("../../src/octocode/hooks/register.ts");
	const { captureToolInvocation } = await import("../../src/core/tools/tool-invocation.ts");
	const home = tmp();
	fs.mkdirSync(path.join(home, ".codex"));
	const marker = path.join(home, "must-not-run");
	const command = (value: unknown) => "printf '%s' '" + output(value) + "'";
	const invalid = required
		? {
				type: "command",
				command: `touch '${marker}'`,
				unsupported: true,
				failClosed: true,
			}
		: {
				type: "command",
				command: command({
					behavior: "allow",
					updatedInput: { command: "false" },
				}),
			};
	fs.writeFileSync(
		path.join(home, ".codex/hooks.json"),
		JSON.stringify({
			hooks: {
				PermissionRequest: [
					{
						matcher: "Bash",
						hooks: [invalid, { type: "command", command: command({ behavior: "allow" }) }],
					},
				],
			},
		}),
	);
	const fake = fakeHost(HOOK_SETTINGS),
		ctx = fakeCtx({ cwd: tmp(), hasUI: false });
	const hooks = registerHooks(fake.api, { env: {}, home });
	approveFixtureHooks(ctx.cwd, home);
	await fake.fire("session_start", { reason: "startup" }, ctx);
	expect(
		await hooks.permissionRequest(
			captureToolInvocation("one", "bash", { command: "true" })!,
			ctx,
			new AbortController().signal,
		),
	).toMatchObject({ decision: required ? "deny" : "allow" });
	expect(fs.existsSync(marker)).toBe(false);
});

it("Claude universal stop overrides a nested permission allow", () => {
	expect(
		interpret(
			"PermissionRequest",
			run(
				JSON.stringify({
					continue: false,
					stopReason: "stop now",
					hookSpecificOutput: {
						hookEventName: "PermissionRequest",
						decision: { behavior: "allow" },
					},
				}),
			),
			"claude",
		),
	).toMatchObject({
		permissionDecision: "deny",
		permissionInterrupt: true,
		block: "stop now",
	});
});

it("retains interruption from a later denied file constituent", async () => {
	const fs = await import("node:fs");
	const path = await import("node:path");
	const { tmp } = await import("./helpers.ts");
	const { fakeHost, fakeCtx } = await import("./fake-host.ts");
	const { registerHooks } = await import("../../src/octocode/hooks/register.ts");
	const { captureToolInvocation } = await import("../../src/core/tools/tool-invocation.ts");
	const home = tmp();
	fs.mkdirSync(path.join(home, ".claude"));
	const script = path.join(home, "hook.cjs");
	fs.writeFileSync(
		script,
		`let text='';process.stdin.on('data',part=>text+=part);process.stdin.on('end',()=>{const input=JSON.parse(text);console.log(JSON.stringify({hookSpecificOutput:{hookEventName:'PermissionRequest',decision:{behavior:'deny',message:'no',interrupt:input.tool_input.file_path.endsWith('/second')}}}));});`,
	);
	fs.writeFileSync(
		path.join(home, ".claude/settings.json"),
		JSON.stringify({
			hooks: {
				PermissionRequest: [
					{
						matcher: "Write",
						hooks: [{ type: "command", command: `'${process.execPath}' '${script}'` }],
					},
				],
			},
		}),
	);
	const fake = fakeHost(HOOK_SETTINGS),
		ctx = fakeCtx({ cwd: tmp(), hasUI: false });
	const hooks = registerHooks(fake.api, { env: {}, home });
	approveFixtureHooks(ctx.cwd, home);
	await fake.fire("session_start", { reason: "startup" }, ctx);
	const invocation = captureToolInvocation("one", "file", {
		queries: [
			{ type: "write", path: "first", content: "one\n" },
			{ type: "write", path: "second", content: "two\n" },
		],
	})!;
	expect(await hooks.permissionRequest(invocation, ctx, new AbortController().signal)).toMatchObject({
		decision: "deny",
		interrupt: true,
	});
});

it("retains Claude replacement presence including empty input and ignores empty permission updates", () => {
	for (const updatedInput of [{ command: "printf replacement" }, {}]) {
		expect(
			interpret(
				"PermissionRequest",
				run(output({ behavior: "allow", updatedInput, updatedPermissions: [] })),
				"claude",
			),
		).toMatchObject({
			permissionDecision: "allow",
			updatedInput,
			updatedInputProtocol: "claude",
		});
	}
});
it("Claude denial precedes malformed replacement fields", () => {
	expect(
		interpret("PermissionRequest", run(output({ behavior: "deny", message: "deny wins", updatedInput: 7 })), "claude"),
	).toMatchObject({ permissionDecision: "deny", block: "deny wins" });
});
it.each([null, "command", 7])("rejects present invalid Claude replacement %s", (updatedInput) => {
	expect(
		interpret("PermissionRequest", run(output({ behavior: "allow", updatedInput })), "claude").error,
	).toBeDefined();
});

it("keeps Codex nullable reserved fields neutral", () => {
	expect(
		interpret(
			"PermissionRequest",
			run(
				output({
					behavior: "allow",
					updatedInput: null,
					updatedPermissions: null,
				}),
			),
			"codex",
		),
	).toMatchObject({ permissionDecision: "allow" });
});
it.each([{ message: 123 }, { interrupt: "yes" }])(
	"validates Claude denial wire fields before accepting denial %j",
	(field) => {
		expect(interpret("PermissionRequest", run(output({ behavior: "deny", ...field })), "claude").error).toBeDefined();
	},
);

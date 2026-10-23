import { interpret } from "../../src/octocode/hooks/runner.ts";
import { expect, it } from "vitest";
import { permissionOutput } from "../../src/octocode/hooks/permission-output.ts";

const decode = (decision: unknown, protocol: "claude" | "codex" = "claude") =>
	permissionOutput(
		{
			code: 0,
			stderr: "",
			timedOut: false,
			stdout: JSON.stringify({
				hookSpecificOutput: { hookEventName: "PermissionRequest", decision },
			}),
		},
		protocol,
	);

const entries = [
	{
		type: "addRules",
		rules: [{ toolName: "Bash", ruleContent: "printf SAFE" }],
		behavior: "allow",
		destination: "session",
	},
	{
		type: "replaceRules",
		rules: [{ toolName: "Read" }],
		behavior: "deny",
		destination: "localSettings",
	},
	{
		type: "removeRules",
		rules: [{ toolName: "Edit", ruleContent: "./safe.txt" }],
		behavior: "ask",
		destination: "projectSettings",
	},
	{ type: "setMode", mode: "acceptEdits", destination: "session" },
	{
		type: "addDirectories",
		directories: ["/tmp/approved"],
		destination: "userSettings",
	},
	{
		type: "removeDirectories",
		directories: ["/tmp/approved"],
		destination: "session",
	},
];

it.each(entries)(
	"retains validated $type permission updates without applying them",
	(entry) => {
		const result = decode({ behavior: "allow", updatedPermissions: [entry] });
		expect(result).toMatchObject({
			permissionDecision: "allow",
			updatedPermissions: [entry],
		});
		expect(result.error).toBeUndefined();
	},
);

it("retains ordered updates with replacement input", () => {
	expect(
		decode({
			behavior: "allow",
			updatedInput: {},
			updatedPermissions: entries,
		}),
	).toMatchObject({
		permissionDecision: "allow",
		updatedInput: {},
		updatedPermissions: entries,
	});
});

it.each([
	{ ...entries[0], destination: "managedSettings" },
	{ ...entries[0], behavior: "unknown" },
	{ ...entries[0], rules: [{ toolName: 42 }] },
	{ ...entries[0], rules: [{ toolName: "Bash", ruleContent: 42 }] },
	{ ...entries[3], mode: "full" },
	{ ...entries[4], directories: [42] },
	{ type: "unknown", destination: "session" },
])("rejects malformed update %# without granting permission", (entry) => {
	const result = decode({
		behavior: "allow",
		updatedPermissions: [entries[0], entry],
	});
	expect(result.error).toBeDefined();
	expect(result.permissionDecision).toBeUndefined();
});

it("keeps a valid denial authoritative over irrelevant malformed effects", () => {
	expect(
		decode({
			behavior: "deny",
			message: "denied",
			updatedPermissions: "invalid",
		}),
	).toMatchObject({ permissionDecision: "deny", block: "denied" });
});

it("keeps Codex reserved permission updates unsupported", () => {
	const result = decode(
		{ behavior: "allow", updatedPermissions: [entries[0]] },
		"codex",
	);
	expect(result.error).toBeDefined();
	expect(result.permissionDecision).toBeUndefined();
});

it("retains updates through the actual hook interpreter", () => {
	const result = interpret(
		"PermissionRequest",
		{
			code: 0,
			stderr: "",
			timedOut: false,
			stdout: JSON.stringify({
				hookSpecificOutput: {
					hookEventName: "PermissionRequest",
					decision: { behavior: "allow", updatedPermissions: [entries[0]] },
				},
			}),
		},
		"claude",
	);
	expect(result).toMatchObject({
		permissionDecision: "allow",
		updatedPermissions: [entries[0]],
	});
});

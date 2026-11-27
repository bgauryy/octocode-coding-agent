/** The action classes the permission modes decide, and each class's rules and wording (`mode.ts` reads them). */

export const ACTION_CLASSES = [
	"read.outside",
	"file.workspace",
	"file.outside",
	"shell",
	"shell.destructive",
	"shell.unsandboxed",
	"web",
	"browser",
	"browser.control",
	"browser.cookies",
	"desktop.control",
	"desktop.sensitive",
	"net.private",
	"net.shell",
	"upload.outside",
	"mcp.read",
	"mcp.write",
	"mcp.destructive",
	"agent.spawn",
	"message.external",
	"worktree.merge",
] as const;
export type ActionClass = (typeof ACTION_CLASSES)[number];

export type Rule = "allow" | "ask";

/**
 * Per class: what manual, workspace and full do, how it reads in a message, `why` it asks (every prompt's reason line),
 * and `all`, the kind a session grant can cover ("Allow all shell commands for this session"). A class without a kind
 * asks on every call, unless it is `keyed`: then only its own target (one host, one exact command) can be allowed for
 * the session.
 */
export const MATRIX: Record<
	ActionClass,
	{ rules: [Rule, Rule, Rule]; noun: string; why: string; all?: string; keyed?: true }
> = {
	"read.outside": {
		rules: ["ask", "allow", "allow"],
		noun: "reading outside the workspace",
		why: "it reads files outside the repository",
		all: "reads outside the workspace",
	},
	"file.workspace": {
		rules: ["ask", "allow", "allow"],
		noun: "the file change",
		why: "it changes files in the repository",
		all: "file changes in the repository",
	},
	"file.outside": {
		rules: ["ask", "ask", "allow"],
		noun: "changing a file outside the workspace",
		why: "it changes a file outside the repository, or one that runs in later sessions",
		all: "file changes outside the workspace",
	},
	shell: {
		rules: ["ask", "allow", "allow"],
		noun: "the shell command",
		why: "a shell command can do anything you can",
		all: "shell commands",
	},
	"shell.destructive": {
		rules: ["ask", "ask", "allow"],
		noun: "the destructive shell command",
		why: "the command matches a common destructive pattern (wipes data, formats a disk, powers off); the check flags common cases and is not a security boundary",
	},
	"shell.unsandboxed": {
		rules: ["ask", "ask", "ask"],
		noun: "running a command outside the sandbox",
		why: "the command runs outside the operating-system sandbox, with all your rights; allowing shell commands never covers it",
		keyed: true,
	},
	web: {
		rules: ["ask", "allow", "allow"],
		noun: "the web request",
		why: "it sends a request to a website",
		all: "web requests",
	},
	browser: {
		rules: ["ask", "allow", "allow"],
		noun: "the browser action",
		why: "it acts in a real browser",
		all: "browser actions",
	},
	"browser.control": {
		rules: ["ask", "ask", "allow"],
		noun: "taking control of the browser",
		why: "it takes control of a browser: running custom code against it, moving its cookies or replaying a request",
	},
	"browser.cookies": {
		rules: ["ask", "ask", "ask"],
		noun: "browser cookie access",
		why: "it reads, sets or moves the browser's cookies, which can hold logins",
		all: "browser cookie access",
	},
	"desktop.control": {
		rules: ["ask", "ask", "ask"],
		noun: "taking control of the desktop",
		why: "it clicks, types or reads the screen of your real desktop, where every open app and signed-in session is within reach",
	},
	"desktop.sensitive": {
		rules: ["ask", "ask", "ask"],
		noun: "a sensitive desktop tool",
		why: "it reads or writes the clipboard, quits an app, records the screen, replays a recording, widens a session or moves files through a browser",
	},
	"net.private": {
		rules: ["ask", "ask", "allow"],
		noun: "opening a private or local address",
		why: "the address is private or local, so it can reach internal services",
		all: "private or local addresses",
	},
	"net.shell": {
		rules: ["ask", "ask", "allow"],
		noun: "a shell command's connection",
		why: "a sandboxed shell command connects to a host nothing has allowed yet",
		keyed: true,
	},
	"upload.outside": {
		rules: ["ask", "ask", "allow"],
		noun: "uploading files from outside the workspace",
		why: "it sends files from outside the repository to a page",
		all: "uploads from outside the workspace",
	},
	"mcp.read": {
		rules: ["allow", "allow", "allow"],
		noun: "the MCP read",
		why: "a trusted server entry declares the tool read-only and no argument makes it write; it never asks, and is recorded",
		all: "MCP reads",
	},
	"mcp.write": {
		rules: ["ask", "allow", "allow"],
		noun: "the MCP tool call",
		why: "an MCP tool may change something outside this session",
		all: "MCP tool calls",
	},
	"mcp.destructive": {
		rules: ["ask", "ask", "allow"],
		noun: "the destructive MCP tool call",
		why: "the MCP server marks the tool destructive (`destructiveHint`); the hint can only add this ask, never remove one",
	},
	"agent.spawn": {
		rules: ["ask", "allow", "allow"],
		noun: "starting a subagent",
		why: "a subagent acts on its own with tools of its own",
		all: "subagents",
	},
	"message.external": {
		rules: ["ask", "ask", "allow"],
		noun: "this external message",
		why: "another process on this machine, not you, wants to reach the agent, and nothing verifies who it is",
		all: "external messages",
	},
	"worktree.merge": {
		rules: ["ask", "ask", "ask"],
		noun: "the worktree merge",
		why: "it changes the main checkout's history, and only you may ask for that; a message from another process grants nothing",
		all: "worktree merges",
	},
};

import { describe, expect, test } from "vitest";
import { normalizeSessionName, parseArgs } from "../src/cli/args.ts";

describe("parseArgs", () => {
	describe("--version flag", () => {
		test("parses --version flag", () => {
			const result = parseArgs(["--version"]);
			expect(result.version).toBe(true);
		});

		test("parses -v shorthand", () => {
			const result = parseArgs(["-v"]);
			expect(result.version).toBe(true);
		});

		test("--version takes precedence over other args", () => {
			const result = parseArgs(["--version", "--help", "some message"]);
			expect(result.version).toBe(true);
			expect(result.help).toBe(true);
			expect(result.messages).toContain("some message");
		});
	});

	describe("--help flag", () => {
		test("parses --help flag", () => {
			const result = parseArgs(["--help"]);
			expect(result.help).toBe(true);
		});

		test("parses -h shorthand", () => {
			const result = parseArgs(["-h"]);
			expect(result.help).toBe(true);
		});
	});

	describe("--print flag", () => {
		test("parses --print flag", () => {
			const result = parseArgs(["--print"]);
			expect(result.print).toBe(true);
		});

		test("parses -p shorthand", () => {
			const result = parseArgs(["-p"]);
			expect(result.print).toBe(true);
		});

		test("parses prompt after -p even when it starts with YAML frontmatter", () => {
			const prompt = "---\ntitle: hello\n---\nSay hi.";
			const result = parseArgs(["-p", prompt]);
			expect(result.print).toBe(true);
			expect(result.messages).toEqual([prompt]);
			expect(result.unknownFlags).toEqual([]);
		});

		test("does not consume options after -p as prompts", () => {
			const result = parseArgs(["-p", "--provider", "openai", "Say hi."]);
			expect(result.print).toBe(true);
			expect(result.provider).toBe("openai");
			expect(result.messages).toEqual(["Say hi."]);
		});
	});

	describe("--continue flag", () => {
		test("parses --continue flag", () => {
			const result = parseArgs(["--continue"]);
			expect(result.continue).toBe(true);
		});

		test("parses -c shorthand", () => {
			const result = parseArgs(["-c"]);
			expect(result.continue).toBe(true);
		});
	});

	describe("--resume flag", () => {
		test("parses --resume flag", () => {
			const result = parseArgs(["--resume"]);
			expect(result.resume).toBe(true);
		});

		test("parses -r shorthand", () => {
			const result = parseArgs(["-r"]);
			expect(result.resume).toBe(true);
		});

		test("--resume <id> and -r <id> open that session like --session", () => {
			for (const flag of ["--resume", "-r"]) {
				const result = parseArgs([flag, "0197f6e4-4cf9-7f44-a2d8-f8f7f49ee9d3"]);
				expect(result.session).toBe("0197f6e4-4cf9-7f44-a2d8-f8f7f49ee9d3");
				expect(result.resume).toBeUndefined();
				expect(result.diagnostics).toEqual([]);
			}
			expect(parseArgs(["--resume=0197f6e4"]).session).toBe("0197f6e4");
			expect(parseArgs(["-r", "./saved/session.jsonl"]).session).toBe("./saved/session.jsonl");
		});

		test("--resume <id> then a prompt keeps the prompt", () => {
			const result = parseArgs(["--resume", "0197f6e4", "continue the refactor"]);
			expect(result.session).toBe("0197f6e4");
			expect(result.messages).toEqual(["continue the refactor"]);
		});

		test("--resume does not swallow a prompt or a flag that is not a session id", () => {
			const prompt = parseArgs(["--resume", "fix the build"]);
			expect(prompt.resume).toBe(true);
			expect(prompt.session).toBeUndefined();
			expect(prompt.messages).toEqual(["fix the build"]);
			const flag = parseArgs(["-r", "-p", "hello"]);
			expect(flag.resume).toBe(true);
			expect(flag.print).toBe(true);
			expect(parseArgs(["-r", "@notes.md"]).fileArgs).toEqual(["notes.md"]);
		});

		test("--resume <id> with a different --session is an error", () => {
			const result = parseArgs(["--session", "aaaa1111", "--resume", "bbbb2222"]);
			expect(result.diagnostics).toEqual([
				{ type: "error", message: "--resume: conflicts with --session given earlier" },
			]);
		});
	});

	describe("flags with values", () => {
		test("parses --provider", () => {
			const result = parseArgs(["--provider", "openai"]);
			expect(result.provider).toBe("openai");
		});

		test("parses --model", () => {
			const result = parseArgs(["--model", "gpt-4o"]);
			expect(result.model).toBe("gpt-4o");
		});

		test("parses --api-key", () => {
			const result = parseArgs(["--api-key", "sk-test-key"]);
			expect(result.apiKey).toBe("sk-test-key");
		});

		test("parses --system-prompt", () => {
			const result = parseArgs(["--system-prompt", "You are a helpful assistant"]);
			expect(result.systemPrompt).toBe("You are a helpful assistant");
		});

		test("parses --append-system-prompt", () => {
			const result = parseArgs(["--append-system-prompt", "Additional context"]);
			expect(result.appendSystemPrompt).toEqual(["Additional context"]);
		});

		test("parses multiple --append-system-prompt flags", () => {
			const result = parseArgs(["--append-system-prompt", "Context A", "--append-system-prompt", "Context B"]);
			expect(result.appendSystemPrompt).toEqual(["Context A", "Context B"]);
		});

		test("parses --session", () => {
			const result = parseArgs(["--session", "/path/to/session.jsonl"]);
			expect(result.session).toBe("/path/to/session.jsonl");
		});

		test("parses --session-id", () => {
			const result = parseArgs(["--session-id", "orchestrated-session"]);
			expect(result.sessionId).toBe("orchestrated-session");
		});

		test("parses --fork", () => {
			const result = parseArgs(["--fork", "1234abcd"]);
			expect(result.fork).toBe("1234abcd");
			expect(result.messages).toEqual([]);
		});

		test("parses --export", () => {
			const result = parseArgs(["--export", "session.jsonl"]);
			expect(result.export).toBe("session.jsonl");
		});

		test("parses --thinking", () => {
			const result = parseArgs(["--thinking", "high"]);
			expect(result.thinking).toBe("high");
		});

		test("parses --models as comma-separated list", () => {
			const result = parseArgs(["--models", "gpt-4o,claude-sonnet,gemini-pro"]);
			expect(result.models).toEqual(["gpt-4o", "claude-sonnet", "gemini-pro"]);
		});

		// Issue #10334
		test("ignores empty entries in --models", () => {
			const result = parseArgs(["--models", "gpt-4o, ,claude-sonnet,"]);
			expect(result.models).toEqual(["gpt-4o", "claude-sonnet"]);
		});
	});

	// Issue #9045
	describe("--mode flag", () => {
		test.each(["text", "json", "rpc", "acp"] as const)("parses --mode %s", (mode) => {
			const result = parseArgs(["--mode", mode]);
			expect(result.mode).toBe(mode);
			expect(result.diagnostics).toEqual([]);
		});

		test.each(["yaml", ""])("rejects invalid --mode value %j", (mode) => {
			const result = parseArgs(["--mode", mode, "--version"]);
			expect(result.mode).toBeUndefined();
			expect(result.version).toBe(true);
			expect(result.messages).toEqual([]);
			expect(result.unknownFlags).toEqual([]);
			expect(result.diagnostics).toEqual([
				{ type: "error", message: `Invalid mode "${mode}". Valid values: text, json, rpc, acp` },
			]);
		});

		test("reports a missing --mode value", () => {
			const result = parseArgs(["--mode"]);
			expect(result.mode).toBeUndefined();
			expect(result.unknownFlags).toEqual([]);
			expect(result.diagnostics).toEqual([{ type: "error", message: "--mode requires text, json, rpc, or acp" }]);
		});

		test("does not consume another option as a --mode value", () => {
			const result = parseArgs(["--mode", "--version"]);
			expect(result.mode).toBeUndefined();
			expect(result.version).toBe(true);
			expect(result.unknownFlags).toEqual([]);
			expect(result.diagnostics).toEqual([{ type: "error", message: "--mode requires text, json, rpc, or acp" }]);
		});

		test("reports an invalid --mode value after a valid one", () => {
			const result = parseArgs(["--mode", "json", "--mode", "yaml"]);
			expect(result.diagnostics).toEqual([
				{ type: "error", message: 'Invalid mode "yaml". Valid values: text, json, rpc, acp' },
			]);
		});
	});

	describe("--name flag", () => {
		test("parses --name flag with value", () => {
			const result = parseArgs(["--name", "my-session"]);
			expect(result.name).toBe("my-session");
		});

		test("parses -n shorthand", () => {
			const result = parseArgs(["-n", "quick-session"]);
			expect(result.name).toBe("quick-session");
		});

		test("preserves empty values for main validation", () => {
			const result = parseArgs(["--name", ""]);
			expect(result.name).toBe("");
		});

		test("normalizes display names and rejects whitespace-only values", () => {
			expect(normalizeSessionName("  named session  ")).toBe("named session");
			expect(normalizeSessionName("   ")).toBeUndefined();
		});

		test("reports missing value", () => {
			const result = parseArgs(["--name"]);
			expect(result.diagnostics).toEqual([{ type: "error", message: "--name requires a value" }]);
		});

		test("works alongside other flags", () => {
			const result = parseArgs(["--name", "named-run", "--print", "--model", "gpt-4o", "hello"]);
			expect(result.name).toBe("named-run");
			expect(result.print).toBe(true);
			expect(result.model).toBe("gpt-4o");
			expect(result.messages).toEqual(["hello"]);
		});
	});

	describe("--no-session flag", () => {
		test("parses --no-session flag", () => {
			const result = parseArgs(["--no-session"]);
			expect(result.noSession).toBe(true);
		});

		test("preserves custom session IDs for non-persisting commands", () => {
			expect(parseArgs(["--session-id", "ephemeral-id", "--help"])).toMatchObject({
				sessionId: "ephemeral-id",
				help: true,
			});
			expect(parseArgs(["--session-id", "ephemeral-id", "--list-models"])).toMatchObject({
				sessionId: "ephemeral-id",
				listModels: true,
			});
			expect(parseArgs(["--session-id", "ephemeral-id", "--no-session"])).toMatchObject({
				sessionId: "ephemeral-id",
				noSession: true,
			});
		});
	});

	describe("removed flags", () => {
		test.each([["-e"], ["-ne"], ["-nt"], ["-nbt"], ["-xt"], ["-ns"], ["-np"], ["-nc"]])(
			"refuses %s as an unknown option",
			(flag) => {
				expect(parseArgs([flag]).diagnostics).toEqual([
					{ type: "error", message: `Unknown option: ${flag}. Run "octocode --help" to see the options.` },
				]);
			},
		);

		test("names --extension and --no-extensions as unknown options and keeps x.ts as a message", () => {
			const parsed = parseArgs(["--no-extensions", "--extension", "x.ts"]);
			expect(parsed.unknownFlags).toEqual(["no-extensions", "extension"]);
			expect(parsed.messages).toEqual(["x.ts"]);
		});
	});

	describe("permission start mode", () => {
		test.each(["manual", "workspace", "full"])("--permission-mode %s starts in that mode", (mode) => {
			expect(parseArgs(["--permission-mode", mode])).toMatchObject({ permissionMode: mode, diagnostics: [] });
		});

		test("--dangerously-skip-permissions starts in bypass", () => {
			expect(parseArgs(["--dangerously-skip-permissions", "-p", "hi"])).toMatchObject({
				permissionMode: "bypass",
				print: true,
				messages: ["hi"],
				diagnostics: [],
			});
		});

		test("refuses bypass through --permission-mode and an unknown mode", () => {
			expect(parseArgs(["--permission-mode", "bypass"]).diagnostics).toEqual([
				{
					type: "error",
					message: 'Invalid permission mode "bypass". Valid values: manual, workspace, full',
				},
			]);
		});

		test("refuses two different start modes, accepts the same one twice", () => {
			expect(parseArgs(["--permission-mode", "manual", "--dangerously-skip-permissions"]).diagnostics).toEqual([
				{
					type: "error",
					message: "--dangerously-skip-permissions conflicts with the start mode manual given earlier",
				},
			]);
			expect(parseArgs(["--permission-mode=full", "--permission-mode", "full"]).diagnostics).toEqual([]);
		});
	});

	describe("--no-mcp flag", () => {
		test("parses --no-mcp flag", () => {
			const result = parseArgs(["--no-mcp"]);
			expect(result.noMcp).toBe(true);
			expect(result.unknownFlags).toEqual([]);
		});
	});

	describe("--skill flag", () => {
		test("parses single --skill", () => {
			const result = parseArgs(["--skill", "./skill-dir"]);
			expect(result.skills).toEqual(["./skill-dir"]);
		});

		test("parses multiple --skill flags", () => {
			const result = parseArgs(["--skill", "./skill-a", "--skill", "./skill-b"]);
			expect(result.skills).toEqual(["./skill-a", "./skill-b"]);
		});
	});

	describe("--prompt-template flag", () => {
		test("parses single --prompt-template", () => {
			const result = parseArgs(["--prompt-template", "./prompts"]);
			expect(result.promptTemplates).toEqual(["./prompts"]);
		});

		test("parses multiple --prompt-template flags", () => {
			const result = parseArgs(["--prompt-template", "./one", "--prompt-template", "./two"]);
			expect(result.promptTemplates).toEqual(["./one", "./two"]);
		});
	});

	describe("--theme flag", () => {
		test("parses single --theme", () => {
			const result = parseArgs(["--theme", "./theme.json"]);
			expect(result.themes).toEqual(["./theme.json"]);
		});

		test("parses multiple --theme flags", () => {
			const result = parseArgs(["--theme", "./dark.json", "--theme", "./light.json"]);
			expect(result.themes).toEqual(["./dark.json", "./light.json"]);
		});
	});

	describe("--use-theme flag", () => {
		test("parses --use-theme", () => {
			const result = parseArgs(["--use-theme", "light"]);
			expect(result.useTheme).toBe("light");
		});

		test("reports when the theme name value is missing", () => {
			const result = parseArgs(["--use-theme", "--print"]);
			expect(result.useTheme).toBeUndefined();
			expect(result.print).toBe(true);
			expect(result.diagnostics).toEqual([{ type: "error", message: "--use-theme requires a theme name" }]);
		});
	});

	describe("--no-skills flag", () => {
		test("parses --no-skills flag", () => {
			const result = parseArgs(["--no-skills"]);
			expect(result.noSkills).toBe(true);
		});
	});

	describe("--no-prompt-templates flag", () => {
		test("parses --no-prompt-templates flag", () => {
			const result = parseArgs(["--no-prompt-templates"]);
			expect(result.noPromptTemplates).toBe(true);
		});
	});

	describe("--no-themes flag", () => {
		test("parses --no-themes flag", () => {
			const result = parseArgs(["--no-themes"]);
			expect(result.noThemes).toBe(true);
		});
	});

	describe("--no-context-files flag", () => {
		test("parses --no-context-files flag", () => {
			const result = parseArgs(["--no-context-files"]);
			expect(result.noContextFiles).toBe(true);
		});
	});

	describe("folder trust flags", () => {
		test("parses --trust", () => {
			const result = parseArgs(["--trust"]);
			expect(result.trust).toBe(true);
		});

		test("--approve is an unknown flag, not an alias of --trust", () => {
			const result = parseArgs(["--approve"]);
			expect(result.trust).toBeUndefined();
			expect(result.unknownFlags).toEqual(["approve"]);
		});

		test("-a, -na and --no-approve do not grant or refuse trust", () => {
			for (const flag of ["-a", "-na", "--no-approve"]) expect(parseArgs([flag]).trust).toBeUndefined();
		});
	});

	describe("--verbose flag", () => {
		test("parses --verbose flag", () => {
			const result = parseArgs(["--verbose"]);
			expect(result.verbose).toBe(true);
		});
	});

	describe("--offline flag", () => {
		test("parses --offline flag", () => {
			const result = parseArgs(["--offline"]);
			expect(result.offline).toBe(true);
		});
	});

	describe("--tui-mode flag", () => {
		test.each(["regular", "fullscreen"] as const)("parses %s mode", (mode) => {
			const result = parseArgs(["--tui-mode", mode]);
			expect(result.tuiMode).toBe(mode);
		});

		test("rejects invalid modes", () => {
			const result = parseArgs(["--tui-mode", "other"]);
			expect(result.diagnostics).toEqual([
				{ type: "error", message: 'Invalid TUI mode "other". Valid values: fullscreen, regular' },
			]);
		});

		test("requires a mode", () => {
			const result = parseArgs(["--tui-mode"]);
			expect(result.diagnostics).toEqual([{ type: "error", message: "--tui-mode requires fullscreen or regular" }]);
		});

		test("does not recognize the old --ui-mode flag", () => {
			const result = parseArgs(["--ui-mode", "fullscreen"]);
			expect(result.tuiMode).toBeUndefined();
			expect(result.unknownFlags).toEqual(["ui-mode"]);
		});
	});

	describe("tool flags", () => {
		test("parses --no-tools flag", () => {
			const result = parseArgs(["--no-tools"]);
			expect(result.noTools).toBe(true);
		});

		test("parses --no-builtin-tools flag", () => {
			const result = parseArgs(["--no-builtin-tools"]);
			expect(result.noBuiltinTools).toBe(true);
		});

		test("parses --tools flag", () => {
			const result = parseArgs(["--tools", "read,bash"]);
			expect(result.tools).toEqual(["read", "bash"]);
		});

		test("parses -t shorthand", () => {
			const result = parseArgs(["-t", "read,bash"]);
			expect(result.tools).toEqual(["read", "bash"]);
		});

		test("parses +name and -name tool modifiers", () => {
			const result = parseArgs(["-t", "+codemode,-write"]);
			expect(result.tools).toEqual(["+codemode", "-write"]);
			expect(result.diagnostics).toEqual([]);
		});

		test("rejects tool names mixed with modifiers", () => {
			const result = parseArgs(["--tools", "read,+codemode"]);
			expect(result.tools).toBeUndefined();
			expect(result.diagnostics).toEqual([
				{ type: "error", message: "--tools: tool names cannot be mixed with +name or -name entries" },
			]);
		});

		test("rejects patterns in tool modifiers", () => {
			const result = parseArgs(["-t", "+mcp__github__*"]);
			expect(result.tools).toBeUndefined();
			expect(result.diagnostics).toEqual([
				{
					type: "error",
					message: "-t: +name and -name entries take exact tool names, not patterns: +mcp__github__*",
				},
			]);
		});

		test("parses --exclude-tools flag", () => {
			const result = parseArgs(["--exclude-tools", "read,bash"]);
			expect(result.excludeTools).toEqual(["read", "bash"]);
		});

		test("parses --no-tools with explicit --tools flags", () => {
			const result = parseArgs(["--no-tools", "--tools", "read,bash"]);
			expect(result.noTools).toBe(true);
			expect(result.tools).toEqual(["read", "bash"]);
		});

		test("parses --no-builtin-tools with explicit --tools flags", () => {
			const result = parseArgs(["--no-builtin-tools", "--tools", "read,bash"]);
			expect(result.noBuiltinTools).toBe(true);
			expect(result.tools).toEqual(["read", "bash"]);
		});
	});

	describe("messages and file args", () => {
		test("parses plain text messages", () => {
			const result = parseArgs(["hello", "world"]);
			expect(result.messages).toEqual(["hello", "world"]);
		});

		test("parses @file arguments", () => {
			const result = parseArgs(["@README.md", "@src/main.ts"]);
			expect(result.fileArgs).toEqual(["README.md", "src/main.ts"]);
		});

		test("parses mixed messages and file args", () => {
			const result = parseArgs(["@file.txt", "explain this", "@image.png"]);
			expect(result.fileArgs).toEqual(["file.txt", "image.png"]);
			expect(result.messages).toEqual(["explain this"]);
		});

		test("fails an unknown long flag at parse time, naming it and pointing to --help", () => {
			const result = parseArgs(["--unknown-flag"]);
			expect(result.unknownFlags).toEqual(["unknown-flag"]);
			expect(result.diagnostics).toEqual([
				{ type: "error", message: 'Unknown option: --unknown-flag. Run "octocode --help" to see the options.' },
			]);
		});

		test("does not take the next word as the unknown flag's value", () => {
			const result = parseArgs(["--unknown-flag", "message"]);
			expect(result.messages).toEqual(["message"]);
			expect(result.unknownFlags).toEqual(["unknown-flag"]);
		});

		test("names the flag, not its value, for the equals syntax", () => {
			const result = parseArgs(["--unknown-flag=value"]);
			expect(result.unknownFlags).toEqual(["unknown-flag"]);
			expect(result.diagnostics[0].message).toContain("--unknown-flag.");
		});

		test("--plan is a built-in flag and keeps the next word as a message", () => {
			const result = parseArgs(["--plan", "fix the bug"]);
			expect(result.plan).toBe(true);
			expect(result.unknownFlags).toEqual([]);
			expect(result.diagnostics).toEqual([]);
			expect(result.messages).toEqual(["fix the bug"]);
		});
	});

	describe("complex combinations", () => {
		test("parses multiple flags together", () => {
			const result = parseArgs([
				"--provider",
				"anthropic",
				"--model",
				"claude-sonnet",
				"--print",
				"--thinking",
				"high",
				"@prompt.md",
				"Do the task",
			]);
			expect(result.provider).toBe("anthropic");
			expect(result.model).toBe("claude-sonnet");
			expect(result.print).toBe(true);
			expect(result.thinking).toBe("high");
			expect(result.fileArgs).toEqual(["prompt.md"]);
			expect(result.messages).toEqual(["Do the task"]);
		});
	});

	describe("one flag table", () => {
		test("names the flag whose value is missing instead of calling it unknown", () => {
			expect(parseArgs(["--model"]).diagnostics).toEqual([{ type: "error", message: "--model requires a value" }]);
		});
		test("never takes another flag as a value", () => {
			const result = parseArgs(["--model", "--print", "hi"]);
			expect(result.model).toBeUndefined();
			expect(result.print).toBe(true);
			expect(result.messages).toEqual(["hi"]);
			expect(result.diagnostics).toEqual([{ type: "error", message: "--model requires a value" }]);
			// Text that merely starts with a dash is still a value.
			expect(parseArgs(["--system-prompt", "- be brief"]).systemPrompt).toBe("- be brief");
		});
		test("accepts --flag=value for every flag that takes one and rejects it for switches", () => {
			expect(parseArgs(["--model=sonnet"]).model).toBe("sonnet");
			expect(parseArgs(["--thinking=high"]).thinking).toBe("high");
			expect(parseArgs(["--offline=yes"]).diagnostics).toEqual([
				{ type: "error", message: "--offline does not take a value" },
			]);
		});
		test("treats an invalid thinking level as an error, like other enumerated flags", () => {
			expect(parseArgs(["--thinking", "huge"]).diagnostics[0]).toMatchObject({ type: "error" });
		});
	});
});

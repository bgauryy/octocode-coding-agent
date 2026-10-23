# Plan Mode Extension

This regression fixture demonstrates plan extraction, tool selection and progress widgets through the extension API. It disables the native `file` tool (and custom tools named `edit` or `write`) and filters calls to `bash`. Other tools stay active, including MCP tools, so this fixture does not enforce a session-wide read-only boundary.

## Features

- **File-changing tools disabled**: Disables `file` (and custom `edit`/`write`) while preserving other active tools
- **Bash allowlist**: Filters shell commands using the fixture's command matcher
- **Plan extraction**: Extracts numbered steps from `Plan:` sections
- **Progress tracking**: Widget shows completion status during execution
- **[DONE:n] markers**: Explicit step completion tracking
- **Session persistence**: State survives session resume

## Commands

- `/plan` - Toggle plan mode
- `/todos` - Show current plan progress
- `Ctrl+Alt+P` - Toggle plan mode (shortcut)

## Usage

1. Enable plan mode with `/plan` or `--plan` flag
2. Ask the agent to analyze code and create a plan
3. The agent should output a numbered plan under a `Plan:` header:

```
Plan:
1. First step description
2. Second step description
3. Third step description
```

4. Choose "Execute the plan" when prompted
5. During execution, the agent marks steps complete with `[DONE:n]` tags
6. Progress widget shows completion status

## How It Works

### Plan Mode

- `file` (and custom `edit`/`write`) tools disabled
- Other active tools remain available
- Bash commands filtered through allowlist
- Agent is instructed to produce a plan; the tool filter only covers the tools listed above

### Execution Mode

- Full tool access restored
- Agent executes steps in order
- `[DONE:n]` markers track completion
- Widget shows progress

### Command Allowlist

Commands recognized by the allowlist:

- File inspection: `cat`, `head`, `tail`, `less`, `more`
- Search: `grep`, `find`, `rg`, `fd`
- Directory: `ls`, `pwd`, `tree`
- Git read: `git status`, `git log`, `git diff`, `git branch`
- Package info: `npm list`, `npm outdated`, `yarn info`
- System info: `uname`, `whoami`, `date`, `uptime`

Blocked commands:

- File modification: `rm`, `mv`, `cp`, `mkdir`, `touch`
- Git write: `git add`, `git commit`, `git push`
- Package install: `npm install`, `yarn add`, `pip install`
- System: `sudo`, `kill`, `reboot`
- Editors: `vim`, `nano`, `code`

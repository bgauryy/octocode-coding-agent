# Subagent: lean: tools

## Native tools

### bash

```text
Run a command in the working directory. Foreground calls return combined output. Background calls return a job id, pid and log path; completion arrives as a message. Use background: true for builds, full test suites, servers and anything over a minute; a foreground call moves to the background after 90s or on a user message. Never sleep-poll for jobs or files. A timeout does not undo side effects: inspect the result before rerunning a command.
```

```json
{
  "type": "object",
  "required": [
    "command",
    "reason"
  ],
  "properties": {
    "type": {
      "type": "string",
      "enum": [
        "bash",
        "powershell"
      ],
      "description": "bash (default, configured shell) or powershell (Windows)"
    },
    "command": {
      "type": "string",
      "description": "Command in the selected syntax"
    },
    "timeout": {
      "type": "number",
      "description": "Seconds before the command is stopped: foreground default 900s, at most 3600s. Separately, a foreground call still running after 90s moves to the background unless background is false. A background job has none unless given"
    },
    "maxOutputTokens": {
      "type": "number",
      "description": "Output token budget for this result (about 4 bytes each, at least 100)"
    },
    "background": {
      "type": "boolean",
      "description": "true: return at once with a job id; false with a timeout: wait in the foreground and stop at the timeout"
    },
    "verify": {
      "type": "boolean",
      "description": "Record a verification receipt tied to the current edits; a later edit makes it stale, and a zero exit proves only that the command succeeded."
    },
    "reason": {
      "type": "string",
      "description": "Why this call, one sentence"
    }
  }
}
```

### file

```text
Applies a batch of file changes; it does not read files. Pass queries (one object per change: type, path, edits or content) or a Codex-style patch string, not both; put a file's replacements in one query. Queries continue after a failed item; a patch validates everything first and stops at the first failure; neither rolls back. Read an existing file before changing it (a bash read counts only unpiped and unredirected; a write needs every line read); edits need exact text matching once (or replaceAll), and writes/deletes refuse stale content. Paths outside the workspace need approval.
```

```json
{
  "type": "object",
  "required": [
    "reason"
  ],
  "properties": {
    "queries": {
      "type": "array",
      "items": {
        "type": "object",
        "required": [
          "type",
          "path"
        ],
        "properties": {
          "reason": {
            "type": "string",
            "description": "Only if it differs from the call's reason"
          },
          "type": {
            "type": "string",
            "enum": [
              "edit",
              "write",
              "delete"
            ],
            "description": "edit: exact replacements; write: create/replace; delete: irreversible, only when the task requires it"
          },
          "path": {
            "type": "string",
            "description": "Absolute path or relative to cwd"
          },
          "edits": {
            "type": "array",
            "items": {
              "type": "object",
              "required": [
                "oldText",
                "newText"
              ],
              "properties": {
                "oldText": {
                  "type": "string",
                  "description": "Exact text; with line, the whole original line without its terminator"
                },
                "newText": {
                  "type": "string",
                  "description": "Replacement text"
                },
                "line": {
                  "type": "integer",
                  "description": "1-based line anchor; needs sourceSha256"
                },
                "sourceSha256": {
                  "type": "string",
                  "description": "SHA-256 of the whole file as read; needs line"
                },
                "replaceAll": {
                  "type": "boolean",
                  "description": "All non-overlapping matches; default false."
                }
              }
            },
            "description": "edit: replacements, each matched against the original content; none may overlap"
          },
          "content": {
            "type": "string",
            "description": "write: complete file content"
          }
        }
      }
    },
    "patch": {
      "type": "string",
      "description": "Codex apply_patch text"
    },
    "reason": {
      "type": "string",
      "description": "Why this call, one sentence"
    }
  }
}
```

### steps

```text
Tracked steps of one piece of work, kept under the backlog item you hold (not as separate items) or on this session. add uses the one item this session holds; with several, it needs item.
```

```json
{
  "type": "object",
  "required": [
    "op",
    "reason"
  ],
  "properties": {
    "op": {
      "type": "string",
      "enum": [
        "list",
        "add",
        "update"
      ],
      "description": "list: open steps of item, else of this session and its items"
    },
    "id": {
      "type": "string",
      "description": "update: e.g. T7; list: only this step"
    },
    "goal": {
      "type": "string",
      "description": "add/update: what done means"
    },
    "why": {
      "type": "string",
      "description": "add/update: why"
    },
    "item": {
      "type": "string",
      "description": "list/add: e.g. B12; add: not an epic (epics hold no steps); list: an epic covers its items"
    },
    "state": {
      "type": "string",
      "enum": [
        "todo",
        "ongoing",
        "done",
        "dropped"
      ],
      "description": "list: filter; add: todo/ongoing; update: new"
    },
    "result": {
      "type": "string",
      "description": "update: outcome"
    },
    "limit": {
      "type": "integer",
      "description": "list: page size, capped at 200 (default 20)"
    },
    "offset": {
      "type": "integer",
      "description": "list: skip; copy from Next"
    },
    "reason": {
      "type": "string",
      "description": "Why this call, one sentence"
    }
  },
  "additionalProperties": false
}
```

### agent

```text
Set type and that type's fields; each field's description starts with its type. coordinate: List teammates and reserve files in this worktree: reservations block other agents' edits and bash writes to those paths; scripts and other editors ignore them.
message: Queue questions or evidence to the parent or teammates; replyRequired or wake wakes an idle recipient.
```

```json
{
  "type": "object",
  "required": [
    "type",
    "reason"
  ],
  "properties": {
    "type": {
      "type": "string",
      "enum": [
        "coordinate",
        "message"
      ]
    },
    "action": {
      "type": "string",
      "enum": [
        "list",
        "lock",
        "unlock",
        "changes"
      ],
      "description": "coordinate: list: live agents and held paths; lock: reserve paths, all or none; unlock: release paths, or all without paths; changes: recent file changes by agents, newest first"
    },
    "paths": {
      "type": "array",
      "items": {
        "type": "string"
      },
      "description": "coordinate: lock/unlock: files, or \"dir/\" for a tree. changes: only under these paths"
    },
    "withinMinutes": {
      "type": "integer",
      "description": "coordinate: changes: window in minutes (default 60)"
    },
    "limit": {
      "type": "integer",
      "description": "coordinate: changes: max files (default 20)"
    },
    "to": {
      "type": "string",
      "description": "message: Agent id, role or \"parent\"; use an exact id across parent trees. \"all\" reaches only your tree; omit with replyTo to answer its sender."
    },
    "message": {
      "type": "string",
      "description": "message only"
    },
    "forward": {
      "type": "integer",
      "description": "message: Stored message # to pass on unchanged (msg#N elsewhere); message becomes an optional note; replies go to its sender."
    },
    "replyRequired": {
      "type": "boolean",
      "description": "message: true: a request you need answered; wakes an idle recipient. Default false: an FYI"
    },
    "wake": {
      "type": "boolean",
      "description": "message: true: an idle recipient acts now, no answer expected (an FYI waits). Not with to: all"
    },
    "replyTo": {
      "type": "integer",
      "description": "message: Message number to answer; wakes the asker."
    },
    "reason": {
      "type": "string",
      "description": "Why this call, one sentence"
    }
  },
  "additionalProperties": false
}
```

## MCP tools

None.

# Delegating the checks

For a large board, have read-only researcher children check batches in parallel while you keep the writes.

1. Group items by area (tests, team, MCP, research and RFC), about 30 per batch, so one child reads related code.
2. Any child reads this repository's board from bash with `octocode backlog get <id>` and `octocode backlog list [--query <text>] [--states <state,...>]`; they change nothing, and `octocode backlog export <file>` writes the whole board as Markdown (a read-only role runs `get` and `list`, not `export`). Name the ids of its batch, and tell it to skip items outside it and not to read the agent database: item numbers repeat across repositories there. A child has no `backlog` tool unless its task names an item.
3. Brief each child: read-only, no backlog writes, focused tests only. Give the checks from [grooming](grooming.md) step 2, the evidence rules from [verdicts](verdicts.md), and the ids that live sessions hold, so it skips them.
4. Ask for a structured result, so verdicts merge without rereading prose:

```json
{
	"type": "object",
	"required": ["items", "gaps"],
	"properties": {
		"items": {
			"type": "array",
			"items": {
				"type": "object",
				"required": ["id", "verdict", "evidence"],
				"properties": {
					"id": { "type": "string" },
					"verdict": {
						"type": "string",
						"enum": [
							"keep",
							"done",
							"obsolete",
							"duplicate",
							"merge",
							"promote",
							"reprioritize",
							"split",
							"release",
							"reopen",
							"ask-user"
						]
					},
					"of": { "type": "string" },
					"evidence": { "type": "string" }
				}
			}
		},
		"gaps": { "type": "string" }
	}
}
```

5. Start all batches together in the background and wait for their reports. Then spot-check every non-keep verdict before you write it (grooming step 3). When a child kept an item without a deep check, report that item as unchecked; do not count it as verified.

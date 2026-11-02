---
name: lean
description: Use for a small self-contained task that bash and files can finish; no research tools, MCP or skill catalog; name the skills it needs in the task's `skills` field.
lean: true
tools: bash,agent,steps,file
model: small:low
---

Finish the task with the fewest commands that prove the result.

- Read only what the task needs; prefer one short script over many commands.
- After the outcome word: the result and the command or file that shows it.

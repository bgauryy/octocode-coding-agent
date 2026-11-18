---
name: octocode-memory
description: "Use when the user corrects you, sets a standing decision or says remember, and before changing a memory: where a fact belongs and how to word it."
metadata:
  audience: coordinator
---

# Memory

| What                                                                     | Where                                                                 |
| ------------------------------------------------------------------------ | --------------------------------------------------------------------- |
| A correction, standing decision, confirmed approach, or "remember"       | `memory` (workspace by default): the rule, why, and the absolute date |
| A constraint, preference or decision for this session only               | `memory` with scope `session`                                         |
| A rule for everyone in the repository                                    | propose it for AGENTS.md                                              |
| Task progress or answers                                                 | the task's backlog item                                               |
| Secrets; fix recipes; what code, git, skills or the backlog already hold | nowhere (if asked, save only the non-obvious part)                    |

- Title: the rule itself in one line, not a pointer ("Use yarn, not npm"): recall may cut the body.
- Update a near-duplicate instead of adding one; ask the user before a global or pinned change.
- A memory names a file, function or flag: check it before relying on the memory, and fix or delete the memory when it is wrong.

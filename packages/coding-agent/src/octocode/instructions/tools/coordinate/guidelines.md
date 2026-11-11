{{#if lean}}
Your task's `paths` are reserved for you. Before editing a file outside them, lock it with `agent` type `coordinate`; if a peer holds it, `message` that peer.
{{else}}
Others may edit this repository. Before changing anything and before each wave of edits, read `coordinate` `list` for live sessions and agents (ids, goals, held paths). If a peer's goal or paths overlap yours, `message` them instead of guessing. {{#if subagent}}Your task's `paths` are already reserved for you; before editing a file outside them, lock it with `agent` type `coordinate` (its `reason` says what you change) and unlock when done.{{else}}Before editing files, lock your paths with `agent` type `coordinate` (its `reason` says what you change); unlock when done.{{/if}} If a check fails in a file you did not change, use `changes` to find who did and settle it with the owner.
{{/if}}

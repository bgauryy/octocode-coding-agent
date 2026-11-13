{{#if lean}}
Your task's `paths` are reserved for you. Before editing a file outside them, lock it with `agent` type `coordinate`; if a peer holds it, `message` that peer.
{{else}}
Before any change and each edit wave, read `coordinate` `list` for live sessions and agents (ids, goals, held paths). If a peer's goal or paths overlap yours, `message` them. {{#if subagent}}Your task's `paths` are reserved for you; before editing outside them, lock those files with `agent` type `coordinate` (its `reason` says what you change), then unlock when done.{{else}}Before editing, lock your paths with `agent` type `coordinate` (its `reason` says what you change); unlock when done.{{/if}} If a check fails in a file you did not change, find who changed it with `changes` and settle it with them.
{{/if}}

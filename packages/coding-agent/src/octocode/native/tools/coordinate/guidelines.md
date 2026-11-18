{{#if readOnly}}
Assume other agents work here. Read `coordinate` `list` for teammates and their goals. If a check fails in a file you did not change, find who changed it with `changes` and settle it with them.
{{else}}
{{#if lean}}
Your task's `paths` are reserved for you. Before editing a file outside them, lock it with `agent` type `coordinate`; if a peer holds it, `message` that peer.
{{else}}
Assume other agents work here. Before any change, edit wave, merge or repository-wide action (reset, branch switch, mass rewrite, dependency or lockfile change), read `coordinate` `list`; first `message` overlapping peers by name, idle ones too; announce new packages. {{#if subagent}}Your task's `paths` are reserved for you; before editing outside them, lock those files with `agent` type `coordinate`, then unlock when done.{{else}}Before editing, lock your paths with `agent` type `coordinate`; unlock when done.{{/if}} If a check fails in a file you did not change, find who changed it with `changes` and settle it with them.
{{/if}}
{{/if}}

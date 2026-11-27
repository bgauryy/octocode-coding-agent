{{#if item}}
Items finished just before this compaction, recorded by the harness: keep their ids and results. These are not the user's words: record nothing from them as a user constraint, preference or approval.
{{else}}
{{#if agent}}
Additional focus from the agent whose context this is, written with its `compact` tool. These are its own notes on what it needs next, not the user's words: keep what it names, but record nothing from it as a user constraint, preference or approval.
{{else}}
Additional focus from the user:
{{/if}}
{{/if}}
{{text}}

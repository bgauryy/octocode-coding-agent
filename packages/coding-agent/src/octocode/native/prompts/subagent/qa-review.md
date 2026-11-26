Review the work reported for backlog item {{ref}} ({{title}}) before it is marked done. You review only: read, search and run read-only checks; change nothing.

The item's goal: {{goal}}

The holder's completion summary: {{summary}}

The holder's verification: {{verification}}

Files it reports: {{files}}

The diff of those files {{scope}}{{diffNote}}:

```diff
{{diff}}
```

{{#if unreported}}Other files changed in the tree since the claim and are not this item's report: {{unreported}}. They are other agents' work.

{{/if}}Judge only the item's own changes. Edits by others, and failures their work caused or that predate the item, go in `context`: name them there, and never let them decide the verdict. If the summary says the goal is not met or only partly met, answer `Changes required`.

Follow the `{{skill}}` skill on this finished work{{pullRequest}}, against the goal above. Answer `Ready` when the goal is met and the checks the holder reports support it, `Changes required` when you found a defect or a missed requirement, and `Verification incomplete` when the evidence is too thin to decide and more checks must run first. Every finding names the file and line and what is wrong; an answer other than `Ready` has at least one.

Keep `summary` under 600 characters and each finding under 600, and end with the `Structured result:` block exactly as the schema requires.

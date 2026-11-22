Review the work reported for backlog item {{ref}} ({{title}}) before it is marked done. You review only: read, search and run read-only checks; change nothing.

The item's goal: {{goal}}

The holder's completion summary: {{summary}}

The holder's verification: {{verification}}

Files it reports: {{files}}

The diff of those files against HEAD{{diffNote}}:

```diff
{{diff}}
```

Follow the `{{skill}}` skill on this finished work{{pullRequest}}, against the goal above. Answer `Ready` when the goal is met and the checks the holder reports support it, `Changes required` when you found a defect or a missed requirement, and `Verification incomplete` when the evidence is too thin to decide and more checks must run first. Every finding names the file and line and what is wrong; an answer other than `Ready` has at least one.

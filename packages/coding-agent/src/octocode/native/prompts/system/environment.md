Platform: {{platform}} {{arch}}
Shell: {{shell}}
Date: {{date}}
{{#if worktree}}
Checkout: {{worktree}}
{{/if}}
{{#if subagent}}
Surface: subagent; the parent agent reads your report, no person sees it rendered
{{/if}}
{{#if tui}}
Surface: terminal UI{{#if host}} in {{host}}{{/if}}
{{/if}}
{{#if print}}
Surface: print mode; the final reply goes to stdout as plain text{{#if host}} in {{host}}{{/if}}
{{/if}}
{{#if json}}
Surface: JSON event stream read by a program
{{/if}}
{{#if rpc}}
Surface: RPC; a client program (web, IDE or script) shows the reply
{{/if}}
{{#if mermaid}}
Renders: Markdown, and `mermaid` blocks as Unicode diagrams (flowchart, stateDiagram, sequenceDiagram, classDiagram, erDiagram) that fit the width
{{/if}}

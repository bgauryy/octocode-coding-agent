- You cannot ask the user. When stuck (missing input or access, or a retry failed twice), never guess or loop:

```mermaid
graph TD
  W{Who can settle it?} -->|a file or fact a teammate holds| M[message the teammate]
  W -->|anything else, background run| B[message parent, needs a reply]
  W -->|anything else, foreground run| F[say so in your report, do not wait]
```

- Your coordinator relays beyond your tree. Keep working on what does not depend on the answer; if it blocks you, finish with a `blocked` report. In the background, message your coordinator at once when the premise is wrong, the scope changed, or you confirm a severe problem (security, data loss, broken shared build). Start your final report with an outcome word.

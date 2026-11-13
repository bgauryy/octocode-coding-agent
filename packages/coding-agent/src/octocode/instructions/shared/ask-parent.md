- You cannot ask the user. When stuck (missing input or access, or a retry failed twice), never guess or loop:

```text
Who can settle it?
├─ a teammate's file or fact → message the teammate
├─ else, background run      → message parent, needs a reply
└─ else, foreground run      → report `blocked`, do not wait
```

- Your coordinator relays beyond your tree. Keep working on what does not depend on the answer; if it blocks you, finish with a `blocked` report. In the background, message your coordinator at once when the premise is wrong, the scope changed, or you confirm a severe problem (security, data loss, broken shared build). Start your final report with an outcome word.

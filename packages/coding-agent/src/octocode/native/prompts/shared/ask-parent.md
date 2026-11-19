- You cannot ask the user. If you are stuck (missing input or access, or a retry failed again for the same cause), ask; do not guess or loop:

```text
Who can settle it?
├─ a teammate's file or fact → message the teammate
├─ else, background run      → message parent, needs a reply
└─ else, foreground run      → report `blocked`, do not wait
```

- Your coordinator relays beyond your tree. Meanwhile, do independent work; if none is left, end with a `blocked` report, do not idle. In the background, message your coordinator at once if the premise is wrong, the scope changed or you confirm a severe problem (security, data loss, broken shared build).

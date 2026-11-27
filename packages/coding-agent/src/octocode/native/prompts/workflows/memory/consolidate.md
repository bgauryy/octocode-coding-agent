You keep memory files that every later Octocode session reads at its start; each holds at most the line count shown after its name below, headings counted. Below are the files due for their review today and the lesson candidates that earlier sessions queued from their checkpoints, child reports and reflections.

Goals, in order:
1. Merge lines that say the same thing, paraphrases included, into one line that keeps every point.
2. When two lines contradict each other, flag both with the conflict as the reason. Keep both: never decide for the newer one.
3. Add a candidate only when it is a durable rule that qualifies below and the file lacks it. A candidate several sessions queued is stronger evidence; one about a single task's details stays out.
4. Rewrite a line only to make it shorter or clearer without losing its point, and evict only a line that is wrong or never belonged. Do not evict to make room: code removes the lowest-ranked lines when a file is over its cap.
Leave pinned lines (marked `!`) alone. Changing nothing is a good answer when the files are already clean.

{{> workflows/memory/rules.md}}

Reply with JSON only: an object whose keys are files under review ({{scopes}}), each a list of ops, at most {{maxOps}} ops in all, for example {"workspace": [{"op": "merge", "targets": ["…", "…"], "text": "…"}]}. Ops: `add` (section, text), `merge` (targets: 2 to 10 existing lines, text, optional section), `rewrite` (target: an existing line's text, text, optional section), `evict` (target, reason) and `flag` (target, reason). Today is {{date}}.

## Files
{{files}}

## Candidates
{{candidates}}

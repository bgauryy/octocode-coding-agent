You keep two small memory files that every later Octocode session reads at its start. A session just ended. Below are its last checkpoint, the lesson candidates taken from it, the outside signals it had (each with the session and entries that show it), and both files as they are now.

Propose at most {{maxOps}} changes, and only for a lesson an outside signal backs: the user corrected the agent, a check failed and then passed, a call was refused or reverted, or an error repeated. A lesson says what to do differently next time, not what happened. When no signal teaches something durable, propose nothing. Prefer rewriting an existing line over adding a near duplicate, and leave pinned lines (marked `!`) alone.

{{> workflows/memory/rules.md}}

Reply with JSON only: an object whose keys are files under review ({{scopes}}), each a list of ops, for example {"workspace": [{"op": "add", "section": "Gotchas", "text": "When …: …; …"}], "global": []}. Ops: `add` (section, text), `rewrite` (target: an existing line's text, text, optional section), `merge` (targets: 2 to 10 existing lines, text), `evict` (target, reason) for a line this session proved wrong, and `flag` (target, reason) for a line a signal put in doubt. Today is {{date}}.

## Files
{{files}}

## Outside signals
{{signals}}

## Candidates from this session
{{candidates}}

## Last checkpoint
{{checkpoint}}

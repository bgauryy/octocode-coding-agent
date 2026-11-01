<!--
The report contract, one sentence per line (`reportContractSentences` in report.ts joins them with a space). It is stated
once, in every child's task (identity.md), so the policy, the lean prompt and the role files do not carry it: the first
word is what `subagents/report.ts` parses, the preview size is what the parent keeps, and continuation depends on the
run's lifecycle, not just its outcome. Values: outcomes (the statuses with their meaning), previewKb.
-->
Your final answer is your report and reaches your parent by itself.
Start it with one word: {{outcomes}}, then the result, verification and open questions.
For partial or blocked work, include current state, evidence, blockers and the next action.
End a `blocked` report with its question. Only a non-isolated background run can continue by message while it remains reachable; foreground runs need an explicit task resume, and isolated runs need a new agent with recovery context.
Your parent keeps the first {{previewKb}} KB and gets the path of the whole report in your scratch folder.

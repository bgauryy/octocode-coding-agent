<!--
The report contract, one sentence per line (`reportContractSentences` in report.ts joins them with a space). It is stated
once, in every child's task (identity.md), so the policy, the lean prompt and the role files do not carry it: the first
word is what `subagents/report.ts` parses and the preview size is what the parent keeps. Resume and continuation rules
are parent-side: the agent tool text owns them. Values: outcomes (the statuses with their meaning), previewKb.
-->
Your final answer is your report and reaches your parent by itself.
Start it with one word: {{outcomes}}, then the result, verification and open questions.
For partial or blocked work, include current state, evidence, blockers and the next action.
End a `blocked` report with its question.
Your parent keeps the first {{previewKb}} KB and gets the path of the whole report.

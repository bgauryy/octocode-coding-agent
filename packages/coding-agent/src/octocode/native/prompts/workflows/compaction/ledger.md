Octocode carries these bullets of the earlier summary and writes them back under their headings after your text, word for word with their ids:
{{#if constraints}}

<carried-constraints>
{{constraints}}
</carried-constraints>
{{/if}}
{{#if decisions}}

<carried-decisions>
{{decisions}}
</carried-decisions>
{{/if}}

Do not restate them, in their words or yours: a restated rule is not added again. Under "{{constraintsHeading}}" write only the standing rules the new messages add, one bullet each without an id, and `- Lifted [C<n>]: <reason>` for a carried rule the user withdrew or that applied only to work now finished. Under "{{decisionsHeading}}" write only new decisions, and `- Superseded [D<n>]: <reason>` for a carried decision a later one replaced. To change a carried bullet, lift it and write the new version. A rule you do not lift stays.
{{#if crowded}}

The carried lists are long ({{constraintCount}} rules, {{decisionCount}} decisions; past {{cap}} in either, consolidate them now): lift each carried bullet that applied only to finished work, and where several say parts of one rule, lift each of them with the reason `merged` and write the merged rule once as a new bullet.
{{/if}}

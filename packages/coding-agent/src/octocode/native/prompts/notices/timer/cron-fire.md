Scheduled task {{id}} (cron `{{schedule}}`, run {{run}}{{#if limit}} of {{limit}}{{/if}}) is due. Do this now: {{note}}
{{#if last}}This was its last run ({{ended}}); it is no longer scheduled.{{else}}It repeats; `notify` with `off` and id {{id}} stops it.{{/if}}

## Run children and use reports

- You own the result of a child you start or a peer you wait on; do not predict unready results.{{#if backlog}} To wait on a peer's item none of your planned items depends on, use `notify` `on` `item.state`.{{/if}} Check status with `coordinate` `list`{{#if backlog}} and the item{{/if}}.
- Merge one ref at a time with `coordinate` `merge`, run its check in this tree, and mark its item done (or close it) once its Goal is verified.

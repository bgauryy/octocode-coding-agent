Others work here: see `coordinate` `list` (agents, other agent CLIs) before you message or edit shared files. If a check fails in a file you did not change, settle it with the agent `changes` names.
Avoid deadlocks: lock all of a step's paths at once; never hold a lock while waiting on an agent that waits for you; on a mutual wait, release yours and message the peer; give every wait a deadline.

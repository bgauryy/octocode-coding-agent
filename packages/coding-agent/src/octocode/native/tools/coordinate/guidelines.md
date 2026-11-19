Assume other agents work here; `coordinate` `list` names them and their goals. If a check fails in a file you did not change, find who changed it with `changes` and settle it with them.
Avoid deadlocks: lock all paths a step needs in one `lock` call; never hold a lock while you wait on an agent that waits for you; on a mutual wait, release yours and message the peer; put a deadline on every wait.

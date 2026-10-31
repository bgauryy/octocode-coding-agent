/** A pid that may be signalled: 0, 1 and negative ones name a group, init or every process. */
export const validPid = (pid: unknown): pid is number => typeof pid === "number" && Number.isInteger(pid) && pid > 1;

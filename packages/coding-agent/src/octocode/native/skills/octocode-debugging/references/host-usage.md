Load when the host is slow, swapping or short of disk and cost must be attributed to process trees and owners before anyone acts.

# Who is using the machine

Every command here only reads. Stop only processes you started, by PID; report the rest with evidence.

| Question        | macOS                                                                   | Linux                                          | Reading                                                                                                |
| --------------- | ----------------------------------------------------------------------- | ---------------------------------------------- | ------------------------------------------------------------------------------------------------------ |
| CPU queue       | `sysctl -n hw.ncpu; uptime`                                             | `nproc; uptime`                                | Load above core count means queuing; Linux load includes uninterruptible I/O                           |
| Memory pressure | `sysctl -n kern.memorystatus_vm_pressure_level kern.memorystatus_level` | `cat /proc/pressure/memory /proc/pressure/cpu` | macOS 1/2/4 = normal/warn/critical, level is percent available; PSI `some`/`full` over 10/60/300 s     |
| Paging          | `sysctl -n vm.swapusage`; `vm_stat` twice                               | `free -m; vmstat 1 5` (`si`,`so`)              | Swapouts rising between reads is active paging; a static swap total is history; `vm_stat` counts pages |
| Disk            | `df -h <path>`; `du -sh <dir>/*/`                                       | same                                           | `du` over millions of files loads the disk: once, in the background                                    |

Never pass `memory_pressure -l/-p/-S`: they change host pressure.

## Attribute to process trees

```bash
# macOS
top -l 2 -o mem -n 30 -stats pid,ppid,pgrp,command,mem,cmprs,cpu,time   # read the second sample
ps -axo pid,ppid,pgid,etime,rss,%cpu,command
lsof -a -d cwd -p "$pid" -Fn
# Linux
top -b -n 2 -d 1 -o %MEM | awk '/^top -/{n++} n==2' | head -40
ps -eo pid,ppid,pgid,sid,etimes,rss,pcpu,args --sort=-rss
pstree -aps "$pid"; grep -E '^(Rss|Pss)' "/proc/$pid/smaps_rollup"
```

- macOS RSS omits compressed and swapped pages: rank by `top` `MEM` and `CMPRS`.
- The first `top` sample has no CPU delta; `ps %cpu` is a decayed (macOS) or lifetime (Linux) average.
- Summed RSS double-counts shared pages: sum `Pss` on Linux.
- `ps e` shows environments only for your own user. Fall back to ancestry and working directory.
- Find running jobs by executable (`ps -axo pid=,ppid=,etime=,%cpu=,comm=`), not `pgrep -f`, which matches shells that merely name the tool; a wait written as `pgrep -f "<cmd>"` matches itself and never ends: wait on a PID.
- In zsh an unquoted `$args` is not split: use arrays.

## Group, then judge leaks

1. Find session roots (agent CLIs, editors, terminals, services) and assign each process to the nearest. An owner marker in the environment (session ID, lane name) outranks ancestry: children keep it after reparenting to PID 1. Inspect it only when ancestry is insufficient; never dump the environment.
2. A **leak candidate** is reparented to PID 1 and not a known service, carries a marker naming an exited session (`ps -p "$owner_pid"` prints nothing), is a wait loop or shell whose job ended, or is an hours-old child of an idle session.
3. Report candidates by PID and verified owner with the evidence it outlived its task; the owner decides.

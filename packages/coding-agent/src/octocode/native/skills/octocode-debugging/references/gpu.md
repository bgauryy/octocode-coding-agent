Load when frames are missed, a browser page janks, or GPU/accelerator work may be the cost.

# Frame and GPU timelines

Start from an observable unit (a missed frame, a slow batch) and keep the environment needed to reproduce it: device, viewport, throttling, warmup, build. Rendering can belong to the browser GPU process, compositor or terminal emulator while the application PID is quiet. Missing tools or tracks mean **GPU not measured**, not zero.

| Workload    | Capture                                                                                              | Follow                                                                                                                                                   |
| ----------- | ---------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Browser     | Performance trace of the interaction via `octocode-chrome-devtools`; Network panel for the waterfall | The long or dropped frame: input and JS through layout, paint, raster, compositor, GPU track. A renderer task alone does not quantify hardware use       |
| NVIDIA CUDA | `nsys profile -t cuda,nvtx -o <out>/run ./app`                                                       | Match host CUDA calls to device work by correlation ID and stream; kernel intervals, copies, gaps; `ncu` on an implicated kernel (replay changes timing) |
| AMD ROCm    | `rocprofv3 --sys-trace -- ./app`                                                                     | HIP calls to dispatches, copies, queue and correlation IDs                                                                                               |
| Apple Metal | Instruments **Metal System Trace**; `xcrun xctrace list templates` shows installed ones              | CPU encoding and submission against command buffers on GPU tracks and presentation                                                                       |

A host API returns once work is enqueued: follow it to the device queue, transfers, execution and the completion the frame waits for. Synchronizing every launch changes overlap; device-wide utilization includes other processes; overlapping kernels or copies can sum above the frame time, so find which completion gates the frame. If device lanes are absent, report host measurements and name the missing capture.

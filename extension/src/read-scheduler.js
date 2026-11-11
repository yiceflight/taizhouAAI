// Keep this allowlist aligned with bridge.rs::read_job. UI-driving reads (for
// example plan-table pagination) deliberately remain in the serial lane.
export function readOnlyJob(job) {
  return ['site-health', 'jiangsu-health', 'airins-health-open', 'dji-health-open', 'jiangsu-hourly', 'dji-routes', 'capture'].includes(job?.type);
}
// A low-spec Windows machine can run out of renderer/GPU memory when several
// CDP evaluations start at once. Keep this small even if an older native
// client sends a larger batch; the native bridge applies the same limit.
export const MAX_PARALLEL_READS = 3;
export function createReadScheduler(execute, wake) {
  const running = new Map();
  return {
    busy: () => [...running.values()].some(job => !readOnlyJob(job)),
    active: () => running.size > 0,
    dispatch(jobs) {
      let reads = [...running.values()].filter(readOnlyJob).length;
      let serial = [...running.values()].some(job => !readOnlyJob(job));
      for (const job of jobs) {
        if (running.has(job.id)) continue;
        if (readOnlyJob(job)) {
          if (reads >= MAX_PARALLEL_READS) continue;
          reads += 1;
        } else {
          // The bridge only dispatches one side-effectful job at a time. Keep
          // this invariant in the worker as a defence against old/malformed
          // responses too.
          if (serial) continue;
          serial = true;
        }
        running.set(job.id, job);
        void Promise.resolve().then(() => execute(job)).catch(() => {}).finally(() => {
          running.delete(job.id);
          wake();
        });
      }
    },
  };
}

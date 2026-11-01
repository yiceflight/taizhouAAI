// Keep this allowlist aligned with bridge.rs::read_job. UI-driving reads (for
// example plan-table pagination) deliberately remain in the serial lane.
export function readOnlyJob(job) {
  return ['site-health', 'jiangsu-health', 'airins-health-open', 'dji-health-open', 'jiangsu-hourly', 'dji-routes', 'capture'].includes(job?.type);
}
export function createReadScheduler(execute, wake) {
  const running = new Map();
  return {
    busy: () => [...running.values()].some(job => !readOnlyJob(job)),
    active: () => running.size > 0,
    dispatch(jobs) {
      for (const job of jobs) {
        if (running.has(job.id)) continue;
        running.set(job.id, job);
        // No concurrency semaphore: each read starts independently, including
        // reads arriving on later heartbeats while other work is still running.
        void Promise.resolve().then(() => execute(job)).catch(() => {}).finally(() => {
          running.delete(job.id);
          wake();
        });
      }
    },
  };
}

// Jittered run loop, used twice: once for the speedtest, once for geocheck.
//
//   - setTimeout, not setInterval: the follow-up is scheduled only after the
//     current run resolves, so a slow run never overlaps the next tick.
//   - interval ± jitterPct so a fleet booted by the same compose-up does not
//     hit the upstream in lock-step.
//   - runOnce() shares the in-flight promise: a tick, an on-demand HTTP call
//     and a panel command that coincide all get the same run.
//   - onDone / onError are the caller's hooks (store, log, heartbeat); their
//     own failures are logged here and never break the loop.
//   - intervalMs === 0 disables the loop; runOnce() still works.
//   - timeoutMs > 0 is a watchdog: a run that has not settled by then is
//     reported as failed and the loop moves on. Without it one hung run is
//     the end of the loop — tick() awaits it before scheduling the next, and
//     runOnce() hands every later caller (the panel's "Run now" included) the
//     same never-settling promise. That is exactly what happened in prod: two
//     nodes sat on `running: true` for six days while their heartbeats looked
//     healthy.
//     ponytail: the abandoned run is not cancelled, only forgotten — whatever
//     it holds (a socket) stays until it settles; threading an AbortSignal
//     through every phase is the upgrade if that ever shows up as a leak.

import { logger } from './log.js';

export class Scheduler {
  constructor({
    name,
    intervalMs,
    minIntervalMs = 60_000,
    jitterPct = 0.15,
    firstDelayMs = 5_000,
    timeoutMs = 0,
    run,
    onDone = () => {},
    onError = () => {},
  }) {
    this.name = name;
    this.log = logger(name);
    this.intervalMs = intervalMs === 0 ? 0 : Math.max(minIntervalMs, intervalMs);
    this.jitterPct = Math.max(0, Math.min(1, jitterPct));
    this.firstDelayMs = firstDelayMs;
    this.timeoutMs = timeoutMs;
    this.run = run;
    this.onDone = onDone;
    this.onError = onError;
    this.timer = null;
    this.running = false;
    this.stopped = false;
    this.runCount = 0;
    this.inflight = null;
    this.nextRunAt = null;
    this.lastRunAt = null;
  }

  get enabled() {
    return this.intervalMs > 0;
  }

  start() {
    if (!this.enabled || this.timer) return;
    this.scheduleNext(this.firstDelayMs);
  }

  stop() {
    this.stopped = true;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    this.nextRunAt = null;
  }

  /** Run now; rejects only when `run` itself throws. */
  runOnce() {
    if (this.inflight) return this.inflight;
    this.inflight = (async () => {
      this.running = true;
      const n = ++this.runCount;
      const t0 = Date.now();
      try {
        const result = await this.guard(this.run({ n }));
        this.lastRunAt = new Date().toISOString();
        await this.hook(this.onDone, result, { n, elapsedMs: Date.now() - t0 });
        return result;
      } catch (e) {
        await this.hook(this.onError, e, { n, elapsedMs: Date.now() - t0 });
        throw e;
      } finally {
        this.running = false;
        this.inflight = null;
      }
    })();
    return this.inflight;
  }

  guard(promise) {
    if (!(this.timeoutMs > 0)) return promise;
    let timer;
    const watchdog = new Promise((_, reject) => {
      timer = setTimeout(
        () => reject(new Error(`run timed out after ${Math.round(this.timeoutMs / 1000)}s`)),
        this.timeoutMs,
      );
    });
    return Promise.race([promise, watchdog]).finally(() => clearTimeout(timer));
  }

  async hook(fn, ...args) {
    try {
      await fn(...args);
    } catch (e) {
      this.log.error('hook failed', { err: e });
    }
  }

  scheduleNext(delayOverride) {
    if (this.stopped || !this.enabled) return;
    const delay = typeof delayOverride === 'number'
      ? delayOverride
      : this.intervalMs + Math.round((Math.random() * 2 - 1) * this.intervalMs * this.jitterPct);
    this.nextRunAt = new Date(Date.now() + delay).toISOString();
    this.timer = setTimeout(() => { void this.tick(); }, delay);
    if (typeof this.timer.unref === 'function') this.timer.unref();
  }

  async tick() {
    this.timer = null;
    try {
      await this.runOnce();
    } catch {
      // already reported through onError
    } finally {
      this.scheduleNext();
    }
  }
}

import type { DecisionEngine } from "./agents.ts";

export class InferenceBudgetError extends Error {}

/** One shared FIFO admission limit across all model runs in this service. */
export class DecisionPool {
  active = 0;
  peak = 0;
  private queue: { start: () => void; cancel: () => void }[] = [];
  readonly concurrency: number;
  readonly maxQueue: number;
  constructor(concurrency = 4, maxQueue = 256) {
    this.concurrency = concurrency;
    this.maxQueue = maxQueue;
    if (!Number.isInteger(concurrency) || concurrency < 1 || concurrency > 32)
      throw Error("Inference concurrency must be 1..32");
  }
  async acquire(signal: AbortSignal): Promise<() => void> {
    signal.throwIfAborted();
    if (this.active < this.concurrency) return this.take();
    if (this.queue.length >= this.maxQueue) throw Error("Inference queue full");
    return new Promise((resolve, reject) => {
      const entry = {
        start: () => {
          signal.removeEventListener("abort", entry.cancel);
          resolve(this.take());
        },
        cancel: () => {
          this.queue = this.queue.filter((e) => e !== entry);
          reject(Error("Inference cancelled"));
        },
      };
      this.queue.push(entry);
      signal.addEventListener("abort", entry.cancel, { once: true });
    });
  }
  private take() {
    this.active++;
    this.peak = Math.max(this.peak, this.active);
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.active--;
      this.queue.shift()?.start();
    };
  }
  status() {
    return {
      active: this.active,
      queued: this.queue.length,
      peak: this.peak,
      concurrency: this.concurrency,
    };
  }
  wrap(engine: DecisionEngine, signal: AbortSignal, maxCalls: number) {
    const metrics = {
      attempted: 0,
      completed: 0,
      failed: 0,
      budgetRejected: 0,
      maxCalls,
    };
    const decide: DecisionEngine = async (...args) => {
      // Reserve before awaiting admission: simultaneous agents cannot overspend.
      if (metrics.attempted >= maxCalls) {
        metrics.budgetRejected++;
        throw new InferenceBudgetError("Run inference budget exhausted");
      }
      metrics.attempted++;
      let release: (() => void) | undefined;
      try {
        release = await this.acquire(signal);
        signal.throwIfAborted();
        const result = await engine(...args);
        metrics.completed++;
        return result;
      } catch (e) {
        metrics.failed++;
        throw e;
      } finally {
        release?.();
      }
    };
    return { decide, metrics };
  }
}

import { describe, expect, it } from "vitest";
import { KeyedDebouncer, SerialQueue, waitUntil } from "../src/core/scheduling";

describe("SerialQueue", () => {
  it("runs tasks one at a time in order and survives failures", async () => {
    const errors: unknown[] = [];
    const queue = new SerialQueue((error) => errors.push(error));
    const order: number[] = [];
    void queue.enqueue(async () => {
      await new Promise((resolve) => setTimeout(resolve, 10));
      order.push(1);
    });
    void queue.enqueue(async () => {
      throw new Error("boom");
    });
    await queue.enqueue(async () => {
      order.push(3);
    });
    expect(order).toEqual([1, 3]);
    expect(errors).toHaveLength(1);
    expect(queue.isIdle).toBe(true);
  });
});

describe("KeyedDebouncer", () => {
  it("coalesces repeated schedules per key", async () => {
    const debouncer = new KeyedDebouncer();
    let runs = 0;
    debouncer.schedule("a", 5, () => runs++);
    debouncer.schedule("a", 5, () => runs++);
    expect(debouncer.size).toBe(1);
    await waitUntil(() => debouncer.size === 0);
    expect(runs).toBe(1);
  });

  it("cancels everything", async () => {
    const debouncer = new KeyedDebouncer();
    let runs = 0;
    debouncer.schedule("a", 5, () => runs++);
    debouncer.cancelAll();
    await new Promise((resolve) => setTimeout(resolve, 15));
    expect(runs).toBe(0);
  });
});

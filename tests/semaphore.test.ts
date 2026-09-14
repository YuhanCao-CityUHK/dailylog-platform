import assert from "node:assert/strict";
import test from "node:test";
import { Semaphore } from "../src/infra/semaphore";

test("有界并发不超过上限，排队任务可取消", async () => {
  const gate = new Semaphore(2);
  let active = 0;
  let maxActive = 0;
  const tasks = Array.from({ length: 8 }, (_, index) =>
    gate.run(async () => {
      active += 1;
      maxActive = Math.max(maxActive, active);
      await new Promise((resolve) => setTimeout(resolve, 2));
      active -= 1;
      return index;
    }),
  );
  assert.deepEqual(await Promise.all(tasks), [0, 1, 2, 3, 4, 5, 6, 7]);
  assert.equal(maxActive, 2);

  const single = new Semaphore(1);
  const release = await single.acquire();
  const controller = new AbortController();
  const waiting = single.acquire(controller.signal);
  controller.abort();
  await assert.rejects(waiting, /取消/);
  release();
});

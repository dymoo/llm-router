import assert from "node:assert/strict";
import test from "node:test";
import { createHealthMonitor } from "../src/health.ts";

test("health probes coalesce, cache, degrade and recover without paid inference", async () => {
  let now = 0;
  let calls = 0;
  let ready = true;
  const monitor = createHealthMonitor({
    now: () => now,
    ttlMs: 10,
    deployments: async () => {
      calls++;
      return [{ id: "local", location: "local", ready }];
    },
    persistence: async () => true,
  });
  assert.equal(
    (await Promise.all([monitor.snapshot(), monitor.snapshot()])).every((item) => item.ready),
    true,
  );
  assert.equal(calls, 1);
  ready = false;
  assert.equal((await monitor.snapshot()).ready, true);
  now = 11;
  assert.equal((await monitor.snapshot()).ready, false);
  ready = true;
  now = 22;
  assert.equal((await monitor.snapshot()).ready, true);
  monitor.stop();
  assert.equal((await monitor.snapshot()).ready, false);
  assert.equal(calls, 3);
});

test("an unavailable optional NPU does not block healthy chat, but persistence does", async () => {
  let persistence = true;
  let now = 0;
  const monitor = createHealthMonitor({
    now: () => now,
    ttlMs: 1,
    deployments: async () => [
      { id: "chat", ready: true, location: "local" },
      { id: "npu", ready: false, location: "local", optional: true },
    ],
    persistence: async () => persistence,
  });
  assert.equal((await monitor.snapshot()).ready, true);
  persistence = false;
  now++;
  assert.equal((await monitor.snapshot()).ready, false);
});

test("shutdown during a probe cannot publish a stale healthy result", async () => {
  let release!: () => void;
  const barrier = new Promise<void>((resolve) => {
    release = resolve;
  });
  const monitor = createHealthMonitor({
    deployments: async () => {
      await barrier;
      return [{ id: "chat", ready: true, location: "local" }];
    },
    persistence: async () => true,
  });
  const pending = monitor.snapshot();
  monitor.stop();
  release();
  assert.equal((await pending).ready, false);
  assert.equal((await monitor.snapshot()).stopping, true);
});

test("readiness depends on persistence and deployments; the classifier section is fixed", async () => {
  const monitor = createHealthMonitor({
    deployments: async () => [{ id: "chat", ready: true, location: "local" }],
    persistence: async () => true,
  });
  const snapshot = await monitor.snapshot();
  assert.equal(snapshot.ready, true);
  assert.deepEqual(snapshot.classifier, {
    backend: "rules",
    ready: true,
    local: true,
    evidence: "configuration-only",
  });
});

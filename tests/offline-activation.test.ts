import assert from "node:assert/strict";
import test from "node:test";
import { activateOfflineWorker } from "../src/web/offline-worker-activation.js";

class Worker extends EventTarget {
  constructor(public state: ServiceWorkerState, public scriptURL = "https://study.example/offline-worker.js") { super(); }
  change(state: ServiceWorkerState) { this.state = state; this.dispatchEvent(new Event("statechange")); }
}
interface Registration {
  active: Worker | null;
  installing: Worker | null;
  waiting: Worker | null;
  update: () => Promise<void>;
}

test("offline upgrade explicitly finishes the update check before choosing the active worker", async () => {
  const old = new Worker("activated");
  const replacement = new Worker("installing");
  let finishUpdate: (() => void) | undefined;
  const registration: Registration = {
    active: old, installing: null, waiting: null,
    async update() {
      await new Promise<void>((resolve) => { finishUpdate = resolve; });
      registration.installing = replacement;
      setImmediate(() => {
        registration.active = replacement;
        registration.installing = null;
        replacement.change("activated");
      });
    },
  };
  let finished = false;
  const result = activateOfflineWorker({
    async getRegistration() { return registration; },
    async register(url, options) {
      assert.equal(url, "/offline-worker.js");
      assert.deepEqual(options, { scope: "/", updateViaCache: "none" });
      return registration;
    },
  }).then((value) => { finished = true; return value; });
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(finished, false, "The previous worker cannot receive the new-format download.");
  assert.ok(finishUpdate);
  finishUpdate();
  assert.equal((await result).active, replacement);
});

test("an unchanged worker can still download after a successful explicit update check", async () => {
  let updates = 0;
  const registration: Registration = {
    active: new Worker("activated"), installing: null, waiting: null,
    async update() { updates++; },
  };
  const value = await activateOfflineWorker({
    async getRegistration() { return registration; }, async register() { return registration; },
  });
  assert.equal(value, registration);
  assert.equal(updates, 1);
});

test("an update failure is explicit and leaves the previous registration usable", async () => {
  const old = new Worker("activated");
  const error = new Error("Update network failure");
  const registration: Registration = {
    active: old, installing: null, waiting: null, async update() { throw error; },
  };
  await assert.rejects(activateOfflineWorker({
    async getRegistration() { return registration; }, async register() { return registration; },
  }), error);
  assert.equal(registration.active, old);
});

test("an unrelated worker is neither registered over nor updated", async () => {
  let called = false;
  const registration: Registration = {
    active: new Worker("activated", "https://study.example/another-worker.js"),
    installing: null, waiting: null, async update() { called = true; },
  };
  await assert.rejects(activateOfflineWorker({
    async getRegistration() { return registration; }, async register() { called = true; return registration; },
  }), /different service worker/);
  assert.equal(called, false);
});

test("a redundant replacement cannot be reported as an activated update", async () => {
  const replacement = new Worker("installing");
  const registration: Registration = {
    active: new Worker("activated"), installing: null, waiting: null,
    async update() {
      registration.installing = replacement;
      setImmediate(() => replacement.change("redundant"));
    },
  };
  await assert.rejects(activateOfflineWorker({
    async getRegistration() { return registration; }, async register() { return registration; },
  }), /could not be installed/);
});

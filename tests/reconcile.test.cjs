"use strict";

const assert = require("node:assert/strict");
const { webcrypto } = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");

const root = path.join(__dirname, "..");
const channel = "weiyun-batch-share/v1";
const clone = (value) => structuredClone(value);
const noopEvent = { addListener() {} };

async function harness({ count = 1, resetsPassword = true } = {}) {
  const values = {};
  const downloads = [];
  const calls = [];
  const saved = new Map();
  let backgroundListener;
  let contentListener;
  let dialog = null;
  let readHook = null;
  let failWrite = false;
  let failClose = false;
  let writeHook = null;
  const shared = { URL, structuredClone, crypto: webcrypto, console, setTimeout, clearTimeout };
  const id = "test-extension";
  const tabId = 1;
  const tabUrl = "https://www.weiyun.com/disk/folder/test-folder";
  const dispatch = (listener, raw, sender) => new Promise((resolve, reject) => {
    try {
      const asynchronous = listener({ channel, ...raw }, sender, resolve);
      if (!asynchronous) reject(new Error(`No response for ${raw.action}`));
    } catch (error) {
      reject(error);
    }
  });
  const background = vm.createContext({
    ...shared,
    chrome: {
      runtime: {
        id,
        getURL: (file) => `chrome-extension://${id}/${file}`,
        onMessage: { addListener(listener) { backgroundListener = listener; } }
      },
      storage: {
        local: {
          async setAccessLevel() {},
          async get(key) { return clone(key === null ? values : { [key]: values[key] }); },
          async set(entries) {
            if (writeHook) {
              const hook = writeHook;
              writeHook = null;
              await hook(clone(entries));
            }
            if (failWrite) {
              failWrite = false;
              throw new Error("Simulated storage failure");
            }
            Object.assign(values, clone(entries));
          },
          async remove(key) { delete values[key]; }
        },
        session: {
          async get() { return { targetTabId: tabId }; },
          async set() {}
        }
      },
      tabs: {
        async get() { return { id: tabId, url: tabUrl }; },
        async query() { return [{ id: tabId, url: tabUrl }]; },
        sendMessage: (_, raw) => dispatch(contentListener, raw, { id }),
        onUpdated: noopEvent,
        onRemoved: noopEvent
      },
      action: { onClicked: noopEvent },
      downloads: {
        async download(options) { downloads.push(options); return downloads.length; },
        async search() { return [{ state: "complete" }]; },
        onChanged: noopEvent
      }
    }
  });
  const content = vm.createContext({
    ...shared,
    window: {},
    chrome: {
      runtime: {
        id,
        sendMessage: (raw) => dispatch(backgroundListener, raw, { id, tab: { id: tabId } }),
        onMessage: { addListener(listener) { contentListener = listener; } }
      }
    }
  });
  vm.runInContext(fs.readFileSync(path.join(root, "background.js"), "utf8"), background);
  vm.runInContext(fs.readFileSync(path.join(root, "content.js"), "utf8"), content);
  const state = content.window.__weiyunBatchShareV1;
  const context = {
    origin: "https://www.weiyun.com",
    folderId: "test-folder",
    folderUrl: tabUrl,
    folderName: "test-folder",
    account: "uin:12345678",
    documentNonce: state.adapter.documentNonce,
    expectedCount: count
  };
  const observation = (item, protectedShare = false) => ({
    name: item.name,
    url: `https://share.weiyun.com/test${item.name}`,
    password: protectedShare ? "abcd" : null,
    passwordEnabled: protectedShare,
    expiry: null
  });
  Object.assign(state.adapter, {
    context: () => clone(context),
    checkPage() {},
    readShare() {
      if (!dialog) throw new Error("No share dialog");
      calls.push(["read", dialog.name]);
      const observed = clone(dialog);
      if (readHook) {
        const hook = readHook;
        readHook = null;
        hook();
      }
      return observed;
    },
    async openShare(item) {
      calls.push(["open", item.name]);
      if (!dialog) dialog = observation(item, saved.has(item.name));
      return clone(dialog);
    },
    async addPassword(item) {
      calls.push(["protect", item.name]);
      dialog = observation(item, true);
      if (!resetsPassword || item.name !== "1") saved.set(item.name, clone(dialog));
      return clone(dialog);
    },
    async closeShare() {
      calls.push(["close", dialog?.name]);
      if (failClose) {
        failClose = false;
        throw new Error("Simulated close failure");
      }
      dialog = null;
    }
  });
  const model = vm.runInContext("({ createTask, applyEvent, store, exportTxt, parseImport })", background);
  let task = model.createTask(context, tabId, "test-task", "initial-run");
  task = model.applyEvent(task, task.runId, {
    type: "scan_done",
    expected: count,
    items: Array.from({ length: count }, (_, index) => ({
      key: `item-${index + 1}`,
      name: String(index + 1),
      fingerprint: `fingerprint-${index + 1}`,
      pageHint: 1,
      scrollHint: 0
    }))
  });
  await model.store.saveNew(task);
  const getTask = () => clone(values["task:test-task"]);
  const idle = async () => {
    for (let attempt = 0; attempt < 100; attempt++) {
      await new Promise((resolve) => setImmediate(resolve));
      if (!state.runner?.isBusy) return getTask();
    }
    throw new Error("Runner did not become idle");
  };
  return {
    calls, downloads, context, model, getTask, idle,
    onNextRead(hook) { readHook = hook; },
    onNextWrite(hook) { writeHook = hook; },
    failNextWrite() { failWrite = true; },
    failNextClose() { failClose = true; },
    bumpRevision() { values["task:test-task"].revision += 1; },
    setDialog(value) { dialog = clone(value); },
    getDialog: () => clone(dialog),
    runnerCommit(event) {
      const current = getTask();
      return dispatch(backgroundListener, {
        action: "COMMIT", taskId: current.id, runId: current.runId,
        documentNonce: current.context.documentNonce, event
      }, { id, tab: { id: tabId } });
    },
    async run() {
      const response = await dispatch(contentListener, { action: "RUN", task: getTask() }, { id });
      assert.equal(response.ok, true);
      return idle();
    },
    async command(action, fields = {}) {
      const response = await dispatch(backgroundListener, {
        action, taskId: task.id, ...fields
      }, { id, url: `chrome-extension://${id}/panel.html` });
      await idle();
      return clone(response);
    },
    reconcile(fields = {}) {
      return this.command("RECONCILE", { acknowledged: true, ...fields });
    }
  };
}

test("adopting a manually checked protected dialog does not repeat review of item 1", async () => {
  const app = await harness();
  const stopped = await app.run();
  assert.equal(stopped.items[0].error.code, "PASSWORD_NOT_PERSISTED");
  assert.equal(stopped.items[0].status, "needs_review");
  assert.equal(app.getDialog().passwordEnabled, true);
  const opens = app.calls.filter(([action]) => action === "open").length;

  assert.equal((await app.reconcile()).ok, true);
  const adopted = app.getTask();
  assert.equal(adopted.items[0].status, "done", adopted.items[0].error?.message);
  assert.equal(adopted.status, "completed");
  assert.equal(adopted.items[0].result.verification, "manual_review");
  assert.equal(adopted.items[0].manualReview, undefined);
  assert.equal(app.calls.filter(([action]) => action === "open").length, opens);
  assert.equal(app.downloads.length, 1);
});

test("manual adoption saves and closes item 1 before continuing with item 2", async () => {
  const app = await harness({ count: 2 });
  await app.run();
  const before = app.calls.length;
  assert.equal((await app.reconcile()).ok, true);
  const task = app.getTask();
  assert.equal(task.status, "completed");
  assert.deepEqual(task.items.map((item) => item.result.verification), ["manual_review", "reopened_dialog"]);
  assert.deepEqual(app.calls.slice(before, before + 4), [
    ["read", "1"], ["read", "1"], ["close", "1"], ["open", "2"]
  ]);
  assert.equal(task.items[0].attempts, 1);
  assert.equal(task.items[1].attempts, 1);
});

test("automatic verification still requires the password to persist", async () => {
  const app = await harness({ count: 2 });
  const task = await app.run();
  assert.equal(task.status, "needs_review");
  assert.equal(task.items[0].error.code, "PASSWORD_NOT_PERSISTED");
  assert.equal(task.items[0].result, null);
  assert.equal(task.items[1].status, "pending");
  assert.equal(app.calls.some(([, name]) => name === "2"), false);
  assert.equal(app.downloads.length, 0);
});

test("normal automatic verification and export remain unchanged", async () => {
  const app = await harness({ count: 3, resetsPassword: false });
  const task = await app.run();
  assert.equal(task.status, "completed");
  assert.equal(task.items.every((item) => item.result.verification === "reopened_dialog"), true);
  assert.equal(app.downloads.length, 1);
});

for (const [label, patch] of [
  ["no password", { passwordEnabled: false, password: null }],
  ["disabled password", { passwordEnabled: false, password: "abcd" }],
  ["invalid password", { passwordEnabled: true, password: "!" }],
  ["non-boolean protection flag", { passwordEnabled: "true", password: "abcd" }]
]) {
  test(`manual adoption rejects ${label} without changing progress`, async () => {
    const app = await harness();
    const stopped = await app.run();
    app.setDialog({ ...app.getDialog(), ...patch });
    const before = app.calls.length;
    const response = await app.reconcile();
    assert.equal(response.ok, false);
    assert.equal(response.error.code, "PASSWORD_UNCONFIRMED");
    assert.deepEqual(app.getTask(), stopped);
    assert.deepEqual(app.calls.slice(before), [["read", "1"]]);
  });
}

test("manual adoption requires explicit acknowledgement", async () => {
  const app = await harness();
  const stopped = await app.run();
  const before = app.calls.length;
  const response = await app.reconcile({ acknowledged: false });
  assert.equal(response.error.code, "REVIEW_REQUIRED");
  assert.deepEqual(app.getTask(), stopped);
  assert.equal(app.calls.length, before);
});

for (const [label, patch] of [
  ["wrong item", { name: "another-item" }],
  ["invalid URL", { url: "https://example.com/not-a-share" }]
]) {
  test(`manual adoption rejects ${label}`, async () => {
    const app = await harness();
    const stopped = await app.run();
    app.setDialog({ ...app.getDialog(), ...patch });
    const response = await app.reconcile();
    assert.equal(response.error.code, "WRONG_SHARE");
    assert.deepEqual(app.getTask(), stopped);
  });
}

for (const [label, patch, code] of [
  ["URL", { url: "https://share.weiyun.com/changed" }, "URL_CHANGED"],
  ["password", { password: "efgh" }, "PASSWORD_CHANGED"],
  ["protection", { passwordEnabled: false, password: null }, "PASSWORD_UNCONFIRMED"]
]) {
  test(`changing the ${label} after acknowledgement invalidates manual approval`, async () => {
    const app = await harness({ count: 2 });
    await app.run();
    const before = app.calls.length;
    app.onNextRead(() => app.setDialog({ ...app.getDialog(), ...patch }));
    assert.equal((await app.reconcile()).ok, true);
    const task = app.getTask();
    assert.equal(task.status, "needs_review");
    assert.equal(task.items[0].error.code, code);
    assert.equal(task.items[0].result, null);
    assert.equal(task.items[1].status, "pending");
    assert.equal(app.calls.slice(before).some(([action]) => action === "open"), false);
  });
}

test("manual adoption cannot reuse another completed item's URL", async () => {
  const app = await harness({ count: 2 });
  await app.run();
  await app.model.store.modify("test-task", (task) => {
    task.items[1].status = "done";
    task.items[1].result = {
      ...app.getDialog(), verification: "reopened_dialog", verifiedAt: new Date().toISOString()
    };
    return task;
  });
  const previousResult = app.getTask().items[1].result;
  const stopped = app.getTask();
  const response = await app.reconcile();
  assert.equal(response.ok, false);
  assert.equal(response.error.code, "DUPLICATE_URL");
  const task = app.getTask();
  assert.equal(task.items[0].result, null);
  assert.deepEqual(task.items[1].result, previousResult);
  assert.deepEqual(task, stopped);
});

test("adopting a changed share preserves earlier URLs and identifies manual verification in exports", async () => {
  const app = await harness();
  await app.run();
  const previousUrl = app.getDialog().url;
  const candidateUrl = "https://share.weiyun.com/candidate";
  const errorUrl = "https://share.weiyun.com/error";
  const relatedUrl = "https://share.weiyun.com/related";
  await app.model.store.modify("test-task", (task) => {
    task.items[0].candidate = { url: candidateUrl, password: "old1" };
    task.items[0].relatedShares.push(relatedUrl);
    task.items[0].error.relatedUrls.push(errorUrl);
    return task;
  });
  app.setDialog({ ...app.getDialog(), url: "https://share.weiyun.com/adopted", password: "new1" });
  assert.equal((await app.reconcile()).ok, true);
  const task = app.getTask();
  const item = task.items[0];
  assert.equal(item.status, "done");
  assert.equal(item.result.url, "https://share.weiyun.com/adopted");
  assert.equal(item.result.password, "new1");
  assert.deepEqual([...item.relatedShares].sort(), [previousUrl, candidateUrl, errorUrl, relatedUrl].sort());
  assert.equal(item.error, null);
  const txt = app.model.exportTxt(task);
  assert.match(txt, /\u786e\u8ba4\u65b9\u5f0f\uff1a\u4eba\u5de5\u6838\u5bf9\u5f53\u524d\u5f39\u7a97/);
  const imported = app.model.parseImport(JSON.stringify(task), app.context);
  assert.equal(imported[0].needsReview, true);
  assert.deepEqual([...imported[0].relatedShares].sort(), [...item.relatedShares].sort());
});

test("a runner cannot self-authorize manual verification", async () => {
  const app = await harness();
  await app.run();
  let task = app.getTask();
  const observed = app.getDialog();
  task.status = "running";
  Object.assign(task.items[0], {
    status: "verifying", observedUrl: observed.url, observedPassword: observed.password
  });
  const event = {
    type: "item_done", key: task.items[0].key,
    result: { ...observed, verification: "manual_review", verifiedAt: new Date().toISOString() }
  };
  assert.throws(() => app.model.applyEvent(task, task.runId, event), { code: "UNVERIFIED_RESULT" });
  task.items[0].manualReview = { url: observed.url, password: observed.password, acknowledgedAt: "invalid" };
  assert.throws(() => app.model.applyEvent(task, task.runId, event), { code: "UNVERIFIED_RESULT" });
});

test("scan messages cannot inject manual approval into a new snapshot", async () => {
  const app = await harness();
  await app.model.store.modify("test-task", () => app.model.createTask(app.context, 1, "test-task", "scan-run"));
  const url = "https://share.weiyun.com/test1";
  const password = "abcd";
  const response = await app.runnerCommit({
    type: "scan_done", expected: 1,
    items: [{
      key: "item-1", name: "1", kind: "folder", siteId: "folder:1",
      fingerprint: "fingerprint-1", pageHint: 1, scrollHint: 0,
      manualReview: { url, password, acknowledgedAt: new Date().toISOString() }
    }]
  });
  assert.equal(response.ok, true);
  for (const status of ["opening_share", "link_observed", "securing", "verifying"]) {
    const phase = await app.runnerCommit({ type: "phase", key: "item-1", status, url, password });
    assert.equal(phase.ok, true);
  }
  const completed = await app.runnerCommit({
    type: "item_done", key: "item-1",
    result: { url, password, passwordEnabled: true, verifiedAt: new Date().toISOString(), verification: "manual_review" }
  });
  assert.equal(completed.ok, false);
  assert.equal(completed.error.code, "UNVERIFIED_RESULT");
  assert.equal(app.getTask().items[0].manualReview, undefined);
  assert.equal(app.getTask().items[0].result, null);
});

test("failed persistence leaves the reviewed item unresolved and the dialog untouched", async () => {
  const app = await harness();
  const stopped = await app.run();
  const dialog = app.getDialog();
  const before = app.calls.length;
  app.failNextWrite();
  const response = await app.reconcile();
  assert.equal(response.error.code, "PERSISTENCE_FAILED");
  assert.deepEqual(app.getTask(), stopped);
  assert.deepEqual(app.getDialog(), dialog);
  assert.deepEqual(app.calls.slice(before), [["read", "1"]]);
});

test("failure to persist the adopted result never closes the dialog or starts another item", async () => {
  const app = await harness({ count: 2 });
  await app.run();
  const before = app.calls.length;
  app.onNextRead(() => app.onNextRead(() => app.failNextWrite()));
  assert.equal((await app.reconcile()).ok, true);
  const task = app.getTask();
  assert.equal(task.error.code, "PERSISTENCE_FAILED");
  assert.equal(task.items[0].result, null);
  assert.equal(task.items[1].status, "pending");
  assert.equal(app.calls.slice(before).some(([action]) => ["open", "close"].includes(action)), false);

  assert.equal((await app.command("RESUME")).ok, true);
  assert.equal(app.getTask().status, "completed");
});

test("closing and subsequent items wait for the adopted result's storage acknowledgement", async () => {
  const app = await harness({ count: 2 });
  await app.run();
  const before = app.calls.length;
  let releaseWrite;
  let markStarted;
  const started = new Promise((resolve) => { markStarted = resolve; });
  const pendingWrite = new Promise((resolve) => { releaseWrite = resolve; });
  app.onNextRead(() => app.onNextRead(() => app.onNextWrite((entries) => {
    assert.equal(entries["task:test-task"].items[0].status, "done");
    markStarted();
    return pendingWrite;
  })));
  const adopting = app.reconcile();
  try {
    await started;
    assert.equal(app.getTask().items[0].status, "verifying");
    assert.equal(app.calls.slice(before).some(([action]) => ["open", "close"].includes(action)), false);
  } finally {
    releaseWrite();
  }
  assert.equal((await adopting).ok, true);
  assert.equal(app.getTask().status, "completed");
});

test("failure to close an adopted dialog preserves its result and stops before the next item", async () => {
  const app = await harness({ count: 2 });
  await app.run();
  const before = app.calls.length;
  app.failNextClose();
  assert.equal((await app.reconcile()).ok, true);
  const task = app.getTask();
  assert.equal(task.items[0].status, "done");
  assert.equal(task.items[0].result.verification, "manual_review");
  assert.equal(task.items[1].status, "pending");
  assert.equal(task.status, "paused");
  assert.equal(app.calls.slice(before).some(([action]) => action === "open"), false);

  app.setDialog(null);
  const resumeAt = app.calls.length;
  assert.equal((await app.command("RESUME")).ok, true);
  assert.equal(app.getTask().status, "completed");
  assert.equal(app.calls.slice(resumeAt).some(([, name]) => name === "1"), false);
});

test("other in-flight shares retain priority over pending items after manual adoption", async () => {
  const app = await harness({ count: 3 });
  await app.run();
  await app.model.store.modify("test-task", (task) => {
    task.items[2].status = "link_observed";
    task.items[2].observedUrl = "https://share.weiyun.com/test3";
    return task;
  });
  const before = app.calls.length;
  assert.equal((await app.reconcile()).ok, true);
  assert.equal(app.getTask().status, "completed");
  const opened = app.calls.slice(before).filter(([action]) => action === "open").map(([, name]) => name);
  assert.deepEqual(opened, ["3", "3", "2", "2"]);
});

test("the acknowledged dialog is consumed before an earlier in-flight item", async () => {
  const app = await harness({ count: 2 });
  await app.run();
  await app.model.store.modify("test-task", (task) => {
    Object.assign(task.items[1], {
      status: "needs_review", observedUrl: "https://share.weiyun.com/test2", error: task.items[0].error
    });
    Object.assign(task.items[0], { status: "link_observed", error: null });
    return task;
  });
  app.setDialog({ ...app.getDialog(), name: "2", url: "https://share.weiyun.com/test2" });
  const before = app.calls.length;
  assert.equal((await app.reconcile()).ok, true);
  const task = app.getTask();
  assert.equal(task.items[1].status, "done");
  assert.equal(task.items[1].result.verification, "manual_review");
  assert.deepEqual(app.calls.slice(before, before + 4), [
    ["read", "2"], ["read", "2"], ["close", "2"], ["open", "1"]
  ]);
});

test("concurrent progress changes cannot be overwritten by manual adoption", async () => {
  const app = await harness();
  const stopped = await app.run();
  app.onNextRead(() => app.bumpRevision());
  const response = await app.reconcile();
  assert.equal(response.error.code, "REVISION_CONFLICT");
  assert.equal(app.getTask().revision, stopped.revision + 1);
  assert.equal(app.getTask().items[0].status, "needs_review");
  assert.equal(app.getTask().items[0].manualReview, undefined);
});

test("acknowledgement cannot override a known account mismatch", async () => {
  const app = await harness();
  const stopped = await app.run();
  app.context.account = "uin:87654321";
  const response = await app.reconcile();
  assert.equal(response.error.code, "ACCOUNT_CHANGED");
  assert.deepEqual(app.getTask(), stopped);
});

test("an unknown account can be explicitly reconfirmed after a page reload", async () => {
  const app = await harness();
  await app.run();
  await app.model.store.modify("test-task", (task) => {
    task.context.account = null;
    task.context.documentNonce = "previous-document";
    return task;
  });
  app.context.account = null;
  assert.equal((await app.reconcile()).ok, true);
  const task = app.getTask();
  assert.equal(task.status, "completed");
  assert.equal(task.context.documentNonce, app.context.documentNonce);
});

test("the panel does not reuse acknowledgement for another task or review item", async () => {
  const app = await harness({ count: 2 });
  await app.run();
  const nodes = new Map();
  const node = () => ({
    checked: false,
    scrollTop: 0,
    classList: { toggle() {} },
    append() {},
    replaceChildren() {},
    addEventListener() {}
  });
  for (const [, id] of fs.readFileSync(path.join(root, "panel.html"), "utf8").matchAll(/id="([^"]+)"/g)) {
    nodes.set(id, node());
  }
  const panel = vm.createContext({
    document: { getElementById: (id) => nodes.get(id), createElement: node },
    chrome: {
      runtime: { async sendMessage() { return { ok: true, data: { context: app.context, tasks: [] } }; } },
      storage: { onChanged: noopEvent }
    },
    task: app.getTask()
  });
  vm.runInContext(fs.readFileSync(path.join(root, "panel.js"), "utf8"), panel);
  await new Promise((resolve) => setImmediate(resolve));
  vm.runInContext("setCurrent(task)", panel);
  const ack = nodes.get("review-ack");
  ack.checked = true;
  vm.runInContext("render()", panel);
  assert.equal(ack.checked, true);
  assert.equal(nodes.get("reconcile").disabled, false);

  vm.runInContext("setCurrent({ ...task, id: 'another-task' })", panel);
  assert.equal(ack.checked, false);
  assert.equal(nodes.get("reconcile").disabled, true);

  ack.checked = true;
  vm.runInContext("current.items[0].status = 'done'; current.items[1].status = 'needs_review'; render()", panel);
  assert.equal(ack.checked, false);
  assert.equal(nodes.get("reconcile").disabled, true);
});

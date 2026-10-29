"use strict";

const assert = require("node:assert/strict");
const { webcrypto } = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");

const project = path.resolve(__dirname, "..");
const root = path.resolve(process.env.WEIYUN_EXTENSION_OUTDIR || path.join(project, fs.existsSync(path.join(project, "manifest.json")) ? "." : "dist"));
const channel = "weiyun-batch-share/v1";
const clone = (value) => structuredClone(value);
const noopEvent = { addListener() {} };
const bundles = new Map();

// Compile in memory when requested; do not overwrite another agent's release build.
function artifact(name) {
  if (process.env.WEIYUN_TEST_SOURCE !== "1") return fs.readFileSync(path.join(root, name), "utf8");
  if (name.endsWith(".html")) return fs.readFileSync(path.join(project, "public", name), "utf8");
  if (!bundles.has(name)) {
    const built = require("esbuild").buildSync({
      entryPoints: [path.join(project, "src", name.replace(/\.js$/, ".ts"))],
      bundle: true, write: false, format: name === "content.js" ? "iife" : "esm", target: "chrome120", legalComments: "none",
    });
    bundles.set(name, built.outputFiles[0].text);
  }
  return bundles.get(name);
}
const tick = () => new Promise((resolve) => setImmediate(resolve));
async function eventually(predicate, message = "Condition was not reached") {
  const deadline = Date.now() + 4000;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await tick();
  }
  assert.fail(message);
}
function deferred() {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
}
const decodeDownload = (download) => decodeURIComponent(download.url.slice(download.url.indexOf(",") + 1));
function result(url, password = "abcd", verification = "same_dialog") {
  return { url, password, passwordEnabled: true, expiry: null, verification, verifiedAt: "2026-10-21T00:00:00.000Z" };
}

async function harness({ count = 1, protectFailures = {}, confirmFaults = {}, openFault = null, disconnectAutoExport = false, unactivatedTab = false, origin = "https://www.weiyun.com", folderId = "test-folder" } = {}) {
  const values = {};
  const downloads = [], calls = [], messages = [], injections = [];
  const opens = new Map();
  let backgroundListener, contentListener;
  let dialog = null, writeHook = null, commitHook = null, ackHook = null, contextHook = null;
  let failWrite = false, failClose = false;
  const shared = { URL, structuredClone, crypto: webcrypto, console, setTimeout, clearTimeout };
  const id = "test-extension", tabId = 1;
  const tabUrl = `${origin}/disk${folderId === "root" ? "" : `/folder/${folderId}`}`;
  const session = { targetTabId: tabId };
  const hasHostPermission = !unactivatedTab || (JSON.parse(fs.readFileSync(path.join(root, "manifest.json"), "utf8")).host_permissions ?? []).includes(`${origin}/*`);
  let contentAttached = !unactivatedTab;
  const dispatch = (listener, raw, sender) => new Promise((resolve, reject) => {
    try {
      const asynchronous = listener({ channel, ...raw }, sender, resolve);
      if (!asynchronous) reject(new Error(`No response for ${raw.action}`));
    } catch (error) { reject(error); }
  });
  const background = vm.createContext({
    ...shared,
    chrome: {
      runtime: { id, getURL: (file) => `chrome-extension://${id}/${file}`, onMessage: { addListener(listener) { backgroundListener = listener; } } },
      storage: {
        local: {
          async setAccessLevel() {},
          async get(key) { return clone(key === null ? values : { [key]: values[key] }); },
          async set(entries) {
            if (writeHook?.predicate(entries)) {
              const hook = writeHook; writeHook = null;
              await hook.operation(clone(entries));
            }
            if (failWrite) { failWrite = false; throw new Error("Simulated storage failure"); }
            Object.assign(values, clone(entries));
          },
          async remove(key) { delete values[key]; },
        },
        session: { async get() { return clone(session); }, async set(entries) { Object.assign(session, clone(entries)); } },
      },
      tabs: {
        async get() { return { id: tabId, ...(hasHostPermission ? { url: tabUrl } : {}) }; },
        async query() { return [{ id: tabId, ...(hasHostPermission ? { url: tabUrl } : {}) }]; },
        sendMessage: (_, raw) => {
          if (!contentAttached) throw new Error("Could not establish connection. Receiving end does not exist.");
          messages.push(raw.action);
          if (raw.action === "CONTEXT" && contextHook) contextHook();
          return dispatch(contentListener, raw, { id });
        },
        onUpdated: noopEvent, onRemoved: noopEvent,
      },
      scripting: {
        async executeScript(options) {
          if (!hasHostPermission) throw new Error("Cannot access contents of the page. Extension manifest must request permission to access the respective host.");
          injections.push(clone(options));
          contentAttached = true;
        },
      },
      action: { onClicked: noopEvent },
      downloads: {
        async download(options) { downloads.push(options); return downloads.length; },
        async search() { return [{ state: "complete" }]; }, onChanged: noopEvent,
      },
    },
  });
  const content = vm.createContext({
    ...shared, window: {},
    chrome: { runtime: {
      id,
      sendMessage: async (raw) => {
        if (raw.action === "AUTO_EXPORT" && disconnectAutoExport) throw new Error("Simulated connection lost after finish ACK");
        if (raw.action === "COMMIT" && commitHook) await commitHook(raw.event);
        const response = await dispatch(backgroundListener, raw, { id, tab: { id: tabId } });
        if (raw.action === "COMMIT" && ackHook) await ackHook(raw.event, response);
        return response;
      },
      onMessage: { addListener(listener) { contentListener = listener; } },
    } },
  });
  vm.runInContext(artifact("background.js"), background);
  // Test-only constructor exposure keeps injected adapter errors in the content realm.
  vm.runInContext(artifact("content.js").replace(/\}\)\(\);\s*$/, "window.__testFlowError = FlowError;\n})();"), content);
  const state = content.window.__weiyunBatchShareV1;
  const FlowError = content.window.__testFlowError;
  assert.equal(typeof FlowError, "function", "An unminified compiled content bundle is required");
  const fault = (code, urls = []) => new FlowError(`Simulated ${code}`, code, true, urls);
  const context = {
    origin, folderId, folderUrl: tabUrl, folderName: folderId === "root" ? "全部文件" : folderId,
    account: "uin:12345678", documentNonce: state.adapter.documentNonce, expectedCount: count,
  };
  const snapshot = Array.from({ length: count }, (_, index) => ({
    key: `item-${index + 1}`, name: String(index + 1), kind: "folder", siteId: `folder:${index + 1}`,
    fingerprint: `fingerprint-${index + 1}`, pageHint: 1, scrollHint: 0,
  }));
  Object.assign(state.adapter, {
    context: () => clone(context), checkPage() {},
    async enumerate(progress, shouldPause) {
      await progress(snapshot.length, context.expectedCount);
      if (await shouldPause()) throw fault("PAUSE_SCAN");
      return { items: clone(snapshot), expected: context.expectedCount };
    },
    readShare() {
      if (!dialog) throw fault("DIALOG_MISSING");
      calls.push(["read", dialog.name]); return clone(dialog);
    },
    async openShare(item) {
      calls.push(["open", item.name]);
      if (openFault) throw fault(openFault);
      const attempt = (opens.get(item.name) || 0) + 1;
      opens.set(item.name, attempt);
      if (!dialog) dialog = {
        name: item.name, url: `https://share.weiyun.com/test${item.name}${attempt > 1 ? `retry${attempt}` : ""}`,
        password: null, passwordEnabled: false, expiry: null,
      };
      return clone(dialog);
    },
    async addPassword(item) {
      calls.push(["protect", item.name]);
      if ((opens.get(item.name) || 0) <= (protectFailures[item.name] || 0)) throw fault("PASSWORD_UNCONFIRMED", [dialog.url]);
      dialog = { ...dialog, password: "abcd", passwordEnabled: true }; return clone(dialog);
    },
    async confirmShare(item) {
      calls.push(["confirm", item.name]);
      const configured = confirmFaults[item.name];
      const code = Array.isArray(configured) ? configured[opens.get(item.name) - 1] : configured;
      if (code === "DIALOG_MISSING") { dialog = null; throw fault(code); }
      if (code === "URL_CHANGED") dialog = { ...dialog, url: "https://share.weiyun.com/changed", password: null, passwordEnabled: false };
      if (code === "PASSWORD_CHANGED") dialog = { ...dialog, password: "efgh" };
      if (code === "PASSWORD_UNCONFIRMED") dialog = { ...dialog, password: null, passwordEnabled: false };
      return clone(dialog);
    },
    async closeShare(item) {
      if (item && dialog && dialog.name !== item.name) return;
      calls.push(["close", dialog?.name ?? item?.name]);
      if (failClose) { failClose = false; throw fault("CLOSE_NOT_FOUND"); }
      dialog = null;
    },
  });
  const model = vm.runInContext("({ createTask, applyEvent, store, exportTxt, parseImport })", background);
  let task = model.createTask(context, tabId, "test-task", "initial-run");
  task = model.applyEvent(task, task.runId, { type: "scan_done", expected: count, items: snapshot });
  await model.store.saveNew(task);
  const getTask = (taskId = "test-task") => clone(values[`task:${taskId}`]);
  const idle = async (taskId = "test-task") => { await eventually(() => !state.runner?.isBusy, "Runner did not become idle"); await tick(); return getTask(taskId); };
  return {
    calls, downloads, messages, injections, session, context, model, getTask, idle, opens,
    allTasks: () => clone(Object.values(values)),
    setSnapshot(items, expected = items.length) { snapshot.splice(0, snapshot.length, ...clone(items)); context.expectedCount = expected; },
    getLastError: () => state.lastError, getDialog: () => clone(dialog),
    setDialog(value) { dialog = clone(value); },
    setDocumentNonce(value) { context.documentNonce = value; state.adapter.documentNonce = value; },
    failNextWrite() { failWrite = true; }, failNextClose() { failClose = true; },
    onWrite(predicate, operation) { writeHook = { predicate, operation }; },
    onCommit(operation) { commitHook = operation; }, onAck(operation) { ackHook = operation; }, onContext(operation) { contextHook = operation; },
    bumpRevision() { values["task:test-task"].revision += 1; }, replaceRun() { values["task:test-task"].runId = "replacement-run"; },
    async modify(operation) { return model.store.modify(task.id, operation); },
    async seedLegacy(status = "needs_review") {
      await this.modify((current) => {
        const error = { code: "PASSWORD_NOT_PERSISTED", message: "Legacy password-view failure", at: "2026-10-20T00:00:00.000Z", relatedUrls: ["https://share.weiyun.com/error"] };
        Object.assign(current.items[0], {
          status, attempts: 1, observedUrl: "https://share.weiyun.com/legacy", observedPassword: "old1", error,
          candidate: { url: "https://share.weiyun.com/candidate", password: "old2" }, relatedShares: ["https://share.weiyun.com/related"],
          manualReview: { url: "https://share.weiyun.com/legacy", password: "old1", acknowledgedAt: "2026-10-20T00:00:00.000Z", source: "saved_link" },
        });
        return { ...current, status: "needs_review", currentItemKey: null, error };
      });
      return getTask();
    },
    runnerRequest(action, fields = {}, sender = {}) {
      const current = getTask();
      return dispatch(backgroundListener, { action, taskId: current.id, runId: current.runId, documentNonce: current.context.documentNonce, ...fields }, { id, tab: { id: tabId }, ...sender });
    },
    contentRequest(action, fields = {}) { return dispatch(contentListener, { action, ...fields }, { id }); },
    panelRequest(action, fields = {}) { return dispatch(backgroundListener, { action, taskId: task.id, ...fields }, { id, url: `chrome-extension://${id}/panel.html` }); },
    async start() { const response = await this.contentRequest("RUN", { task: getTask() }); assert.equal(response.ok, true, response.error?.message); },
    async run() { await this.start(); return idle(); },
    async command(action, fields = {}) {
      const response = await dispatch(backgroundListener, { action, taskId: task.id, ...fields }, { id, url: `chrome-extension://${id}/panel.html` });
      await idle(); return clone(response);
    },
  };
}
const shareActions = (app) => app.calls.filter(([action]) => ["open", "protect", "confirm", "close"].includes(action));
const countCalls = (app, action, name = "1") => app.calls.filter(([type, item]) => type === action && item === name).length;

async function startFreshTask(app, reuseCompleted = true, fields = {}) {
  const response = await app.panelRequest("START", { newTask: true, reuseCompleted, ...fields });
  assert.equal(response.ok, true, response.error?.message);
  return app.idle(response.data.task.id);
}

test("adding item 73 preserves all 72 results and only shares the new item", async () => {
  const app = await harness({ count: 72 });
  const saved = await app.run();
  app.setSnapshot([...saved.items, { key: "item-73", name: "73", kind: "folder", siteId: "folder:73", fingerprint: "fingerprint-73", pageHint: 1, scrollHint: 0 }]);
  const task = await startFreshTask(app);
  assert.equal(task.status, "completed");
  assert.equal(task.expectedCount, 73);
  assert.equal(task.context.expectedCount, 73);
  assert.equal(task.reusedCount, 72);
  assert.equal(task.reuseSourceTaskId, saved.id);
  assert.equal(task.reusableItems, undefined);
  assert.deepEqual(task.items.slice(0, 72).map((item) => item.result), saved.items.map((item) => item.result));
  assert.equal(app.calls.filter(([action]) => action === "open").length, 73);
  assert.equal(countCalls(app, "open", "73"), 1);
  assert.deepEqual(app.getTask(), saved);
  assert.equal(app.allTasks().length, 2);
  assert.equal(decodeDownload(app.downloads[2]).split("\r\n").length, 74);
  assert.match(decodeDownload(app.downloads[2]), /目录：73 链接：https:\/\/share.weiyun.com\/test73/);
});

test("refreshing an unchanged directory reuses all results without another share", async () => {
  const app = await harness({ count: 2 });
  const saved = await app.run();
  app.setSnapshot(saved.items);
  const task = await startFreshTask(app);
  assert.equal(task.status, "completed");
  assert.equal(task.reusedCount, 2);
  assert.equal(app.calls.filter(([action]) => action === "open").length, 2);
  assert.deepEqual(app.getTask(), saved);
});

test("refresh uses stable IDs across renames but never reuses a same-name replacement", async () => {
  const app = await harness({ count: 3 });
  const saved = await app.run();
  app.setSnapshot([
    { ...saved.items[0], name: "renamed", fingerprint: "renamed-fingerprint" },
    { ...saved.items[1], key: "replacement", siteId: "folder:replacement", fingerprint: "replacement-fingerprint" }
  ]);
  const task = await startFreshTask(app);
  assert.equal(task.status, "completed");
  assert.equal(task.items.length, 2);
  assert.equal(task.reusedCount, 1);
  assert.deepEqual(task.items.find((item) => item.name === "renamed").result, saved.items[0].result);
  assert.notEqual(task.items.find((item) => item.key === "replacement").result.url, saved.items[1].result.url);
  assert.equal(countCalls(app, "open", "3"), 1);
  assert.deepEqual(app.getTask(), saved);
});

for (const changed of [false, true]) {
  test(`refresh without a stable ID ${changed ? "does not reuse changed metadata" : "matches an identical fingerprint"}`, async () => {
    const app = await harness();
    await app.run();
    await app.modify((task) => { task.items[0].siteId = null; return task; });
    const saved = app.getTask();
    app.setSnapshot([{ ...saved.items[0], fingerprint: changed ? "changed" : saved.items[0].fingerprint }]);
    const task = await startFreshTask(app);
    assert.equal(task.status, "completed");
    assert.equal(task.reusedCount, changed ? 0 : 1);
    assert.equal(countCalls(app, "open"), changed ? 2 : 1);
  });
}

test("an incomplete refresh preserves history and its saved candidates survive resume", async () => {
  const app = await harness({ count: 2 });
  const saved = await app.run();
  app.setSnapshot(saved.items, 3);
  const stopped = await startFreshTask(app);
  assert.equal(stopped.error.code, "PERSISTENCE_FAILED");
  assert.match(stopped.error.message, /目录数量未通过校验/);
  assert.equal(stopped.reusableItems.length, 2);
  assert.deepEqual(app.getTask(), saved);
  assert.equal(app.calls.filter(([action]) => action === "open").length, 2);
  app.setSnapshot(saved.items);
  const response = await app.panelRequest("RESUME", { taskId: stopped.id });
  assert.equal(response.ok, true, response.error?.message);
  const resumed = await app.idle(stopped.id);
  assert.equal(resumed.status, "completed");
  assert.equal(resumed.reusedCount, 2);
  assert.equal(app.calls.filter(([action]) => action === "open").length, 2);
});

test("full restart scans all 73 current items without reusing the saved 72 results", async () => {
  const app = await harness({ count: 72 });
  const saved = await app.run();
  app.setSnapshot([...saved.items, { key: "item-73", name: "73", kind: "folder", siteId: "folder:73", fingerprint: "fingerprint-73" }]);
  const task = await startFreshTask(app, false);
  assert.equal(task.status, "completed");
  assert.equal(task.items.length, 73);
  assert.equal(task.reusedCount, 0);
  assert.equal(app.calls.filter(([action]) => action === "open").length, 145);
  assert.equal(countCalls(app, "open", "73"), 1);
  assert.deepEqual(app.getTask(), saved);
});

test("a paused incomplete task can be replaced by a full restart without deleting history", async () => {
  const app = await harness();
  await app.seedLegacy();
  const saved = await app.modify((task) => ({ ...task, status: "paused" }));
  const task = await startFreshTask(app, false);
  assert.equal(task.status, "completed");
  assert.equal(task.reusedCount, 0);
  assert.deepEqual(app.getTask(), saved);
});

for (const reuseCompleted of [true, false]) {
  test(`an active runner rejects ${reuseCompleted ? "incremental refresh" : "full restart"} without a second task`, async () => {
    const app = await harness();
    const entered = deferred(), release = deferred();
    let reached = false;
    app.onCommit(async (event) => {
      if (event.type === "phase" && event.status === "opening_share") {
        reached = true;
        entered.resolve();
        await release.promise;
      }
    });
    await app.start();
    try {
      await eventually(() => reached, "Missing opening checkpoint");
      await entered.promise;
      const actions = clone(shareActions(app));
      const response = await app.panelRequest("START", { newTask: true, reuseCompleted });
      assert.equal(response.error?.code, "RUNNER_BUSY");
      assert.equal(app.allTasks().length, 1);
      assert.deepEqual(shareActions(app), actions);
    } finally { release.resolve(); }
    assert.equal((await app.idle()).status, "completed");
    assert.equal(countCalls(app, "open"), 1);
  });
}

test("refresh preserves successful results while retrying failed and newly added items", async () => {
  const protectFailures = { "2": Infinity };
  const app = await harness({ count: 2, protectFailures });
  const saved = await app.run();
  assert.equal(saved.status, "finished_with_errors");
  protectFailures["2"] = 0;
  app.setSnapshot([...saved.items, { key: "item-3", name: "3", kind: "folder", siteId: "folder:3", fingerprint: "fingerprint-3" }]);
  const task = await startFreshTask(app);
  assert.equal(task.status, "completed");
  assert.equal(task.reusedCount, 1);
  assert.deepEqual(task.items[0].result, saved.items[0].result);
  assert.equal(countCalls(app, "open", "1"), 1);
  assert.equal(countCalls(app, "open", "2"), 4);
  assert.equal(countCalls(app, "open", "3"), 1);
  assert.deepEqual(app.getTask(), saved);
});

test("refresh refuses another account and never creates a replacement task", async () => {
  const app = await harness();
  const saved = await app.run();
  app.context.account = "uin:87654321";
  const response = await app.panelRequest("START", { newTask: true, reuseCompleted: true });
  assert.equal(response.error?.code, "ACCOUNT_CHANGED");
  assert.equal(app.allTasks().length, 1);
  assert.deepEqual(app.getTask(), saved);
  assert.equal(countCalls(app, "open"), 1);
});

test("refreshing unknown-account results after navigation requires acknowledgement", async () => {
  const app = await harness();
  await app.run();
  await app.modify((task) => { task.context.account = null; return task; });
  app.context.account = null;
  app.setDocumentNonce("new-document");
  const response = await app.panelRequest("START", { newTask: true, reuseCompleted: true });
  assert.equal(response.error?.code, "ACCOUNT_RECONFIRM_REQUIRED");
  assert.equal(app.allTasks().length, 1);
  const task = await startFreshTask(app, true, { acknowledged: true });
  assert.equal(task.status, "completed");
  assert.equal(task.reusedCount, 1);
  assert.equal(countCalls(app, "open"), 1);
});

test("refresh refuses a concurrently revised source before starting a new runner", async () => {
  const app = await harness();
  await app.run();
  let reads = 0;
  app.onContext(() => { if (++reads === 2) app.bumpRevision(); });
  const response = await app.panelRequest("START", { newTask: true, reuseCompleted: true });
  assert.equal(response.error?.code, "REVISION_CONFLICT");
  assert.equal(app.allTasks().length, 1);
  assert.equal(countCalls(app, "open"), 1);
});

test("refresh persistence failure cannot share or overwrite the original task", async () => {
  const app = await harness();
  const saved = await app.run();
  app.failNextWrite();
  const response = await app.panelRequest("START", { newTask: true, reuseCompleted: true });
  assert.equal(response.error?.code, "PERSISTENCE_FAILED");
  assert.equal(app.allTasks().length, 1);
  assert.deepEqual(app.getTask(), saved);
  assert.equal(countCalls(app, "open"), 1);
});

test("one historical result cannot be copied to two current items", async () => {
  const app = await harness();
  const saved = await app.run();
  app.setSnapshot([saved.items[0], { ...saved.items[0], key: "another-key" }]);
  const task = await startFreshTask(app);
  assert.equal(task.error.code, "PERSISTENCE_FAILED");
  assert.match(task.error.message, /同一份历史结果/);
  assert.equal(task.items.length, 0);
  assert.equal(countCalls(app, "open"), 1);
  assert.deepEqual(app.getTask(), saved);
});

for (const origin of ["https://www.weiyun.com", "https://weiyun.com"]) {
  test(`CONNECT reads a newly opened ${origin} root without a toolbar activation`, async () => {
    const app = await harness({ unactivatedTab: true, origin, folderId: "root" });
    await app.modify((task) => ({ ...task, status: "paused" }));
    app.session.targetTabId = 99;
    const saved = app.getTask();
    const response = await app.panelRequest("CONNECT");
    assert.equal(response.ok, true, response.error?.message);
    assert.equal(response.data.context.folderUrl, `${origin}/disk`);
    assert.equal(response.data.context.folderId, "root");
    assert.equal(response.data.tabId, 1);
    assert.equal(app.session.targetTabId, 1);
    assert.deepEqual(app.injections, [{ target: { tabId: 1 }, files: ["content.js"], world: "ISOLATED" }]);
    assert.equal((await app.panelRequest("CONNECT")).ok, true);
    assert.equal((await app.panelRequest("BOOT")).ok, true);
    assert.equal(app.injections.length, 1);
    assert.deepEqual(app.getTask(), saved);
    assert.deepEqual(shareActions(app), []);
  });
}

test("CONNECT never receives host access or injects into unrelated websites", async () => {
  const app = await harness({ unactivatedTab: true, origin: "https://example.com", folderId: "root" });
  const response = await app.panelRequest("CONNECT");
  assert.equal(response.ok, false);
  assert.equal(response.error.code, "WRONG_PAGE");
  assert.deepEqual(app.injections, []);
  assert.deepEqual(shareActions(app), []);
});

test("normal automatic execution verifies same_dialog and downloads exactly result plus log", async () => {
  const app = await harness({ count: 3 });
  const task = await app.run();
  assert.equal(task.status, "completed");
  assert.deepEqual(task.items.map((item) => item.attempts), [1, 1, 1]);
  assert(task.items.every((item) => item.result.verification === "same_dialog"));
  assert.equal(app.downloads.length, 2);
  assert.equal(app.messages.includes("READ_REVIEW"), false);
  assert.equal(app.getDialog(), null);
});

for (const status of ["needs_review", "opening_share", "link_observed", "securing", "verifying"]) {
  test(`RESUME re-shares legacy ${status}, discards approval, archives history and preserves done`, async () => {
    const app = await harness({ count: 2 });
    await app.seedLegacy(status);
    await app.modify((task) => { Object.assign(task.items[1], { status: "done", result: result("https://share.weiyun.com/done2"), attempts: 1 }); return task; });
    app.setDocumentNonce("refreshed-document");
    const savedDone = app.getTask().items[1];
    assert.equal((await app.command("RESUME")).ok, true);
    const task = app.getTask();
    assert.equal(task.status, "completed");
    assert.deepEqual(task.items[1], savedDone);
    assert.equal(task.items[0].result.verification, "same_dialog");
    assert.equal(task.items[0].result.url, "https://share.weiyun.com/test1");
    assert.equal(task.items[0].manualReview, undefined);
    assert.equal(task.items[0].candidate, null);
    assert.equal(task.items[0].error, null);
    assert.equal(countCalls(app, "open"), 1);
    assert.equal(countCalls(app, "protect"), 1);
    assert.equal(app.calls.some(([, name]) => name === "2"), false);
    const history = JSON.stringify({ relatedShares: task.items[0].relatedShares, attemptHistory: task.items[0].attemptHistory });
    for (const token of ["/legacy", "/candidate", "/error", "/related", "PASSWORD_NOT_PERSISTED"]) assert(history.includes(token), token);
  });
}
test("opening_share with no saved URL is reset without human link confirmation", async () => {
  const app = await harness(); await app.seedLegacy("opening_share");
  await app.modify((task) => { task.items[0].observedUrl = null; return task; });
  assert.equal((await app.command("RESUME")).ok, true);
  assert.equal(app.getTask().status, "completed");
});
test("RESUME closes an existing legacy same-item dialog and opens a new share instead of adopting it", async () => {
  const app = await harness(); await app.seedLegacy();
  app.setDialog({ name: "1", url: "https://share.weiyun.com/legacy", password: "old1", passwordEnabled: true, expiry: null });
  assert.equal((await app.command("RESUME")).ok, true);
  const task = app.getTask(); assert.equal(task.status, "completed");
  assert.equal(task.items[0].result.url, "https://share.weiyun.com/test1");
  assert.equal(task.items[0].result.password, "abcd");
  const actions = shareActions(app);
  assert.deepEqual(actions.slice(0, 2), [["close", "1"], ["open", "1"]]);
  assert.equal(countCalls(app, "protect"), 1);
});
test("RESUME recovers a later interrupted item before earlier pending items and closes only its dialog", async () => {
  const app = await harness({ count: 3 });
  await app.modify((task) => {
    task.status = "interrupted";
    Object.assign(task.items[1], { status: "verifying", attempts: 1, observedUrl: "https://share.weiyun.com/legacy2", observedPassword: "old2" });
    return task;
  });
  app.setDialog({ name: "2", url: "https://share.weiyun.com/legacy2", password: "old2", passwordEnabled: true, expiry: null });
  assert.equal((await app.command("RESUME")).ok, true);
  assert.equal(app.getTask().status, "completed");
  assert.deepEqual(shareActions(app).slice(0, 2), [["close", "2"], ["open", "2"]]);
  assert.deepEqual(app.calls.filter(([action]) => action === "open").map(([, name]) => name), ["2", "1", "3"]);
  assert.equal(app.getTask().items[1].result.url, "https://share.weiyun.com/test2");
});

for (const code of ["PASSWORD_UNCONFIRMED", "DIALOG_MISSING", "URL_CHANGED", "PASSWORD_CHANGED"]) {
  test(`one-off ${code} automatically closes/reopens that item and uses the fresh result`, async () => {
    const app = await harness({ count: 2, confirmFaults: { "1": [code] } });
    const task = await app.run();
    assert.equal(task.status, "completed");
    assert.equal(task.items[0].attempts, 2);
    assert.equal(countCalls(app, "open"), 2);
    assert(countCalls(app, "protect") >= 2);
    assert.equal(task.items[0].result.url, "https://share.weiyun.com/test1retry2");
    assert.equal(task.items[0].result.password, "abcd");
    assert.equal(task.items[0].result.verification, "same_dialog");
    const secondOpen = app.calls.findIndex(([action, name], index) => index > 0 && action === "open" && name === "1");
    assert(app.calls.slice(0, secondOpen).some(([action, name]) => action === "close" && name === "1"));
    assert(JSON.stringify(task.items[0].attemptHistory).includes(code));
    if (code === "URL_CHANGED") for (const url of ["https://share.weiyun.com/test1", "https://share.weiyun.com/changed"]) assert(task.items[0].relatedShares.includes(url));
  });
}
test("password addition can fail twice and succeed on the third automatic attempt", async () => {
  const app = await harness({ protectFailures: { "1": 2 } });
  const task = await app.run();
  assert.equal(task.status, "completed");
  assert.equal(task.items[0].attempts, 3);
  assert.equal(countCalls(app, "open"), 3);
  assert.equal(countCalls(app, "protect"), 3);
});
test("three failed attempts mark failed, close its dialog and continue to the next item", async () => {
  const app = await harness({ count: 3, protectFailures: { "1": Infinity } });
  const task = await app.run();
  assert.equal(task.status, "finished_with_errors");
  assert.deepEqual(task.items.map((item) => item.status), ["failed", "done", "done"]);
  assert.deepEqual(task.items.map((item) => item.attempts), [3, 1, 1]);
  assert.equal(task.items[0].result, null);
  assert.equal(countCalls(app, "open"), 3);
  const next = app.calls.findIndex(([action, name]) => action === "open" && name === "2");
  assert.deepEqual(app.calls[next - 1], ["close", "1"]);
  assert.equal(app.downloads.length, 2);
});
test("pause after item_error ACK keeps an unexhausted item eligible for ordinary RESUME", async () => {
  const app = await harness({ count: 2, protectFailures: { "1": 1 } }); let paused = false;
  app.onAck(async (event, response) => {
    if (event.type === "item_error" && response.ok && !paused) {
      paused = true;
      await app.modify((task) => ({ ...task, pauseRequested: true, status: "pausing" }));
    }
  });
  const task = await app.run();
  assert(paused); assert.equal(task.status, "paused");
  assert.equal(task.items[0].status, "pending", "A temporary failed attempt must not be skipped by ordinary resume");
  assert.equal(task.items[0].attempts, 1); assert.equal(task.items[1].status, "pending");
  assert.equal((await app.command("RESUME")).ok, true);
  assert.equal(app.getTask().status, "completed");
  assert.equal(app.getTask().items[0].result.verification, "same_dialog");
  assert.equal(countCalls(app, "open"), 2); assert.equal(countCalls(app, "open", "2"), 1);
});

for (const code of ["ITEM_CHANGED", "ITEM_NOT_FOUND", "WRONG_SHARE", "MULTIPLE_DIALOGS", "AMBIGUOUS_CONTROL", "CAPTCHA", "SITE_BLOCKED"]) {
  test(`${code} stops without retrying or touching the next item`, async () => {
    const app = await harness({ count: 2, openFault: code });
    const task = await app.run();
    assert.equal(task.status, "error");
    assert.equal(task.items[0].status, "opening_share", "A safety stop must retain the interrupted phase, not mark the item failed");
    assert.equal(task.items[1].status, "pending");
    assert.equal(countCalls(app, "open"), 1);
    assert.equal(countCalls(app, "protect"), 0);
    assert.equal(app.calls.some(([, name]) => name === "2"), false);
    assert.equal(app.downloads.length, 0);
  });
}
test("wrong live dialog cannot be adopted, protected or closed as the target item", async () => {
  const app = await harness({ count: 2 });
  app.setDialog({ name: "another-item", url: "https://share.weiyun.com/wrong", password: null, passwordEnabled: false });
  const task = await app.run();
  assert.equal(task.items[0].result, null);
  assert.equal(task.items[1].status, "pending");
  assert.equal(countCalls(app, "protect"), 0);
  assert.equal(app.getDialog().name, "another-item");
});
for (const [field, value, code] of [["account", "uin:87654321", "ACCOUNT_CHANGED"], ["folderId", "other-folder", "DIRECTORY_CHANGED"]]) {
  test(`RESUME acknowledgement cannot bypass ${code}`, async () => {
    const app = await harness(); const stopped = await app.seedLegacy();
    app.context[field] = value;
    assert.equal((await app.command("RESUME", { acknowledged: true })).error?.code, code);
    assert.deepEqual(app.getTask(), stopped);
    assert.deepEqual(shareActions(app), []);
  });
  test(`${code} between attempts forbids cleanup/reopening and stops the next item`, async () => {
    const app = await harness({ count: 2, protectFailures: { "1": Infinity } }); let atChange;
    app.onCommit((event) => {
      if (event.type === "item_error") { atChange = clone(shareActions(app)); app.context[field] = value; }
    });
    const task = await app.run();
    assert(atChange); assert.deepEqual(shareActions(app), atChange);
    assert.equal(task.items[0].result, null); assert.equal(task.items[1].status, "pending");
    assert.equal(task.error?.code, code);
  });
}
test("unknown account across documents needs one account acknowledgement, not link review", async () => {
  const app = await harness({ count: 2 }); await app.seedLegacy();
  await app.modify((task) => { task.context.account = null; task.context.documentNonce = "old-document"; return task; });
  app.context.account = null;
  const stopped = app.getTask();
  assert.equal((await app.command("RESUME")).error?.code, "ACCOUNT_RECONFIRM_REQUIRED");
  assert.deepEqual(app.getTask(), stopped);
  assert.deepEqual(shareActions(app), []);
  assert.equal((await app.command("RESUME", { acknowledged: true })).ok, true);
  assert.equal(app.getTask().status, "completed");
  assert.equal(app.getTask().context.documentNonce, app.context.documentNonce);
  assert.equal(app.messages.includes("READ_REVIEW"), false);
});
test("unknown account in the same document does not require acknowledgement", async () => {
  const app = await harness(); await app.seedLegacy();
  await app.modify((task) => { task.context.account = null; return task; }); app.context.account = null;
  assert.equal((await app.command("RESUME")).ok, true);
  assert.equal(app.getTask().status, "completed");
});
test("concurrent revision change prevents RESUME from overwriting progress", async () => {
  const app = await harness(); const stopped = await app.seedLegacy();
  let reads = 0;
  app.onContext(() => { if (++reads === 2) app.bumpRevision(); });
  assert.equal((await app.command("RESUME")).error?.code, "REVISION_CONFLICT");
  assert.equal(app.getTask().revision, stopped.revision + 1);
  assert.equal(app.getTask().items[0].status, "needs_review");
  assert.deepEqual(shareActions(app), []);
});
test("RESUME persistence failure preserves legacy state and performs no share action", async () => {
  const app = await harness(); const stopped = await app.seedLegacy(); app.failNextWrite();
  assert.equal((await app.command("RESUME")).error?.code, "PERSISTENCE_FAILED");
  assert.deepEqual(app.getTask(), stopped);
  assert.deepEqual(shareActions(app), []);
});
for (const phase of ["opening_share", "link_observed", "securing", "verifying"]) {
  test(`failed ${phase} checkpoint ACK stops before any subsequent external action`, async () => {
    const app = await harness({ count: 2 }); let atFailure;
    app.onCommit((event) => { if (event.type === "phase" && event.status === phase) { atFailure = clone(shareActions(app)); app.failNextWrite(); } });
    const task = await app.run();
    assert(atFailure, "The requested checkpoint must be exercised");
    assert.deepEqual(shareActions(app), atFailure);
    assert.equal(task.items[0].result, null);
    assert.equal(task.items[1].status, "pending");
    assert.match(app.getLastError(), /./);
    assert.equal(app.downloads.length, 0);
  });
}
test("failed item_done ACK never closes the dialog, retries or opens another item", async () => {
  const app = await harness({ count: 2 }); let atFailure;
  app.onCommit((event) => { if (event.type === "item_done") { atFailure = clone(shareActions(app)); app.failNextWrite(); } });
  const task = await app.run();
  assert(atFailure); assert.deepEqual(shareActions(app), atFailure);
  assert.equal(task.items[0].result, null);
  assert.equal(task.items[1].status, "pending");
  assert.equal(app.getDialog().name, "1");
});
test("closing and opening the next item wait for item_done storage acknowledgement", async () => {
  const app = await harness({ count: 2 }); const entered = deferred(), release = deferred();
  app.onWrite((entries) => entries["task:test-task"]?.items[0].status === "done", async () => { entered.resolve(); await release.promise; });
  await app.start();
  try {
    let reached = false; void entered.promise.then(() => { reached = true; });
    await eventually(() => reached, "Missing done checkpoint");
    assert.equal(app.getTask().items[0].status, "verifying");
    assert.equal(countCalls(app, "close"), 0); assert.equal(countCalls(app, "open", "2"), 0);
  } finally { release.resolve(); }
  assert.equal((await app.idle()).status, "completed");
  const next = app.calls.findIndex(([action, name]) => action === "open" && name === "2");
  assert.deepEqual(app.calls[next - 1], ["close", "1"]);
});
test("failed retry checkpoint ACK performs no close, reopen or next-item action", async () => {
  const app = await harness({ count: 2, protectFailures: { "1": Infinity } }); let atFailure;
  app.onWrite((entries) => (entries["task:test-task"]?.items[0].attemptHistory?.length || 0) > 0, () => { atFailure = clone(shareActions(app)); app.failNextWrite(); });
  const task = await app.run();
  assert(atFailure, "Retry must persist its failed attempt first");
  assert.deepEqual(shareActions(app), atFailure);
  assert.equal(task.items[1].status, "pending");
});
for (const eventType of ["restart", "related_share"]) {
  test(`failed ${eventType} ACK prohibits all later share actions`, async () => {
    const app = await harness({ count: 2, confirmFaults: { "1": ["URL_CHANGED"] } }); let atFailure;
    app.onCommit((event) => {
      if (event.type === eventType) { atFailure = clone(shareActions(app)); app.failNextWrite(); }
    });
    const task = await app.run();
    assert(atFailure, `The ${eventType} checkpoint must be exercised`);
    assert.deepEqual(shareActions(app), atFailure);
    assert.equal(task.items[0].result, null); assert.equal(task.items[1].status, "pending");
  });
}
test("STALE_RUN during execution never closes, retries or starts the next item", async () => {
  const app = await harness({ count: 2 }); let atFailure;
  app.onCommit((event) => { if (event.type === "phase" && event.status === "verifying") { atFailure = clone(shareActions(app)); app.replaceRun(); } });
  const task = await app.run();
  assert(atFailure); assert.deepEqual(shareActions(app), atFailure);
  assert.equal(task.runId, "replacement-run");
  assert.equal(task.items[0].result, null); assert.equal(task.items[1].status, "pending");
});
for (const fields of [{ runId: "old-run" }, { documentNonce: "old-document" }]) {
  test(`runner rejects stale ${Object.keys(fields)[0]} without mutation`, async () => {
    const app = await harness(); const before = app.getTask();
    assert.equal((await app.runnerRequest("COMMIT", { event: { type: "phase", key: "item-1", status: "opening_share" }, ...fields })).error?.code, "STALE_RUN");
    assert.deepEqual(app.getTask(), before);
  });
}
test("runner rejects another tab without mutation", async () => {
  const app = await harness(); const before = app.getTask();
  assert.equal((await app.runnerRequest("GET_TASK", {}, { tab: { id: 2 } })).error?.code, "STALE_RUN");
  assert.deepEqual(app.getTask(), before);
});
test("close failure preserves acknowledged result and stops before the next item", async () => {
  const app = await harness({ count: 2 }); app.failNextClose();
  const task = await app.run();
  assert.equal(task.items[0].status, "done"); assert.equal(task.items[0].result.verification, "same_dialog");
  assert.equal(task.items[1].status, "pending"); assert.equal(task.status, "paused"); assert.equal(countCalls(app, "open", "2"), 0);
  app.setDialog(null); const before = countCalls(app, "open");
  assert.equal((await app.command("RESUME")).ok, true);
  assert.equal(app.getTask().status, "completed"); assert.equal(countCalls(app, "open"), before);
});
for (const alias of ["https://SHARE.WEIYUN.COM/test1", "https://share.weiyun.com:443/test1", "https://share.weiyun.com/test1/"]) {
  test(`canonical duplicate URL protection (${alias.includes(":443") ? "port" : alias.endsWith("/") ? "slash" : "host"})`, async () => {
    const app = await harness({ count: 2 }); const task = app.getTask();
    Object.assign(task.items[1], { status: "done", result: result(alias) });
    Object.assign(task.items[0], { status: "verifying", observedUrl: "https://share.weiyun.com/test1", observedPassword: "abcd" });
    assert.throws(() => app.model.applyEvent(task, task.runId, { type: "item_done", key: "item-1", result: result("https://share.weiyun.com/test1") }), { code: "DUPLICATE_URL" });
    await app.modify((current) => { current.items[1] = task.items[1]; return current; }); await app.run();
    assert.equal(app.getTask().items[0].result, null); assert.deepEqual(app.getTask().items[1].result, task.items[1].result);
    assert.equal(countCalls(app, "open"), 1, "Duplicates stop instead of retrying into another item");
  });
}
test("manual_review is rejected even with a valid-looking persisted legacy approval", async () => {
  const app = await harness(); const task = await app.seedLegacy("verifying"); task.status = "running";
  assert.throws(() => app.model.applyEvent(task, task.runId, { type: "item_done", key: "item-1", result: { ...result("https://share.weiyun.com/legacy", "old1", "manual_review"), reviewSource: "saved_link" } }), { code: "UNVERIFIED_RESULT" });
});
for (const [label, patch] of [
  ["missing password", { password: null }], ["invalid password", { password: "!" }],
  ["disabled protection", { passwordEnabled: false }], ["non-boolean protection", { passwordEnabled: "true" }],
]) {
  test(`item_done rejects ${label} instead of exporting an unprotected result`, async () => {
    const app = await harness(); const task = app.getTask();
    Object.assign(task.items[0], { status: "verifying", observedUrl: "https://share.weiyun.com/test1", observedPassword: "abcd" });
    assert.throws(() => app.model.applyEvent(task, task.runId, { type: "item_done", key: "item-1", result: { ...result("https://share.weiyun.com/test1"), ...patch } }), { code: "UNVERIFIED_RESULT" });
    assert.equal(task.items[0].result, null);
  });
}
test("scan messages cannot inject legacy manual approval", async () => {
  const app = await harness(); await app.modify(() => app.model.createTask(app.context, 1, "test-task", "scan-run"));
  const response = await app.runnerRequest("COMMIT", { event: { type: "scan_done", expected: 1, items: [{ key: "item-1", name: "1", kind: "folder", siteId: "folder:1", fingerprint: "fingerprint-1", pageHint: 1, scrollHint: 0, manualReview: { url: "https://share.weiyun.com/injected", password: "abcd", acknowledgedAt: "2026-10-21T00:00:00.000Z" } }] } });
  assert.equal(response.ok, true); assert.equal(app.getTask().items[0].manualReview, undefined);
});
test("removed RECONCILE and READ_REVIEW actions cannot approve a share", async () => {
  const app = await harness(); const before = await app.seedLegacy();
  assert.equal((await app.command("RECONCILE", { acknowledged: true })).ok, false);
  assert.equal((await app.contentRequest("READ_REVIEW", { item: before.items[0] })).ok, false);
  assert.deepEqual(app.getTask(), before); assert.deepEqual(shareActions(app), []);
});
test("uncertain imported candidates are automatically re-shared, never adopted as completed", async () => {
  const app = await harness({ count: 2 }); const backup = await app.seedLegacy();
  const candidates = app.model.parseImport(JSON.stringify(backup), app.context);
  await app.modify(() => { const task = app.model.createTask(app.context, 1, "test-task", "import-run"); task.importedCandidates = candidates; return task; });
  const task = await app.run();
  assert.equal(task.status, "completed"); assert.deepEqual(task.items.map((item) => item.status), ["done", "done"]);
  assert.equal(task.items[0].result.url, "https://share.weiyun.com/test1"); assert.equal(task.items[0].result.password, "abcd");
  assert.equal(task.items[0].result.verification, "same_dialog"); assert(JSON.stringify(task.items[0]).includes("https://share.weiyun.com/legacy"));
  assert.equal(countCalls(app, "open"), 1); assert.equal(countCalls(app, "protect"), 1);
});
test("TXT keeps non-contiguous directory names when re-exporting saved results without sharing", async () => {
  const app = await harness({ count: 2 });
  await app.modify((task) => {
    task.status = "completed";
    Object.assign(task.items[0], { name: "16", status: "done", result: result("https://share.weiyun.com/folder16") });
    Object.assign(task.items[1], { name: "18", status: "done", result: result("https://share.weiyun.com/folder18") });
    task.items.reverse();
    return task;
  });
  const savedItems = app.getTask().items;
  const expected = "\uFEFF目录：16 链接：https://share.weiyun.com/folder16 密码：abcd\r\n目录：18 链接：https://share.weiyun.com/folder18 密码：abcd\r\n";
  assert.equal(app.model.exportTxt(app.getTask()), expected);
  assert.equal((await app.panelRequest("EXPORT")).ok, true);
  assert.equal(decodeDownload(app.downloads[0]), expected);
  assert.deepEqual(app.getTask().items, savedItems);
  assert.deepEqual(shareActions(app), []);
});
test("TXT preserves leading zeroes, descriptive titles and non-numeric names", async () => {
  const app = await harness({ count: 3 });
  const task = app.getTask();
  const names = ["0018", "18 - 原名 & <完整版>", "专题目录"];
  for (const [index, item] of task.items.entries()) Object.assign(item, { name: names[index], status: "done", result: result(`https://share.weiyun.com/test${index + 1}`) });
  assert.equal(app.model.exportTxt(task), "\uFEFF目录：0018 链接：https://share.weiyun.com/test1 密码：abcd\r\n目录：18 - 原名 & <完整版> 链接：https://share.weiyun.com/test2 密码：abcd\r\n目录：专题目录 链接：https://share.weiyun.com/test3 密码：abcd\r\n");
});
test("TXT normalizes control characters in directory names to keep one line per result", async () => {
  const app = await harness();
  const task = app.getTask();
  Object.assign(task.items[0], { name: "18\r\n标题\t\u2028后续", status: "done", result: result("https://share.weiyun.com/test1") });
  assert.equal(app.model.exportTxt(task), "\uFEFF目录：18  标题  后续 链接：https://share.weiyun.com/test1 密码：abcd\r\n");
});
test("TXT is exact BOM/CRLF successful lines with directory names; details stay in the log", async () => {
  const app = await harness({ count: 3, protectFailures: { "1": Infinity } });
  await app.modify((task) => { task.context.folderName = "private-folder<&>"; return task; });
  const task = await app.run();
  const expected = "\uFEFF目录：2 链接：https://share.weiyun.com/test2 密码：abcd\r\n目录：3 链接：https://share.weiyun.com/test3 密码：abcd\r\n";
  assert.equal(app.model.exportTxt(task), expected); assert.equal(app.downloads.length, 2);
  const contents = app.downloads.map(decodeDownload);
  assert.equal(contents.filter((text) => text === expected).length, 1);
  const log = contents.find((text) => text !== expected);
  for (const token of ["private-folder<&>", app.context.folderUrl, "PASSWORD_UNCONFIRMED", "https://share.weiyun.com/test1"]) assert(log.includes(token), token);
  assert.doesNotMatch(expected, /\[|\]|&(?:amp|lt|gt|quot);|\u6709\u6548\u671f|PASSWORD/);
  assert.equal(Buffer.from(expected).subarray(0, 3).toString("hex"), "efbbbf");
  assert.equal(expected.replace(/\r\n/g, "").includes("\n"), false);
});
test("TXT excludes failed, pending and legacy needs_review entries even with saved URLs", async () => {
  const app = await harness({ count: 4 }); const task = app.getTask();
  Object.assign(task.items[0], { status: "failed", observedUrl: "https://share.weiyun.com/failed", error: { message: "Failure" } });
  Object.assign(task.items[1], { status: "done", result: result("https://share.weiyun.com/only", "pass2") });
  Object.assign(task.items[2], { status: "needs_review", observedUrl: "https://share.weiyun.com/uncertain" });
  assert.equal(app.model.exportTxt(task), "\uFEFF目录：2 链接：https://share.weiyun.com/only 密码：pass2\r\n");
});
test("repeated/concurrent AUTO_EXPORT and BOOT do not duplicate the two downloads", async () => {
  const app = await harness(); await app.run(); assert.equal(app.downloads.length, 2);
  const responses = await Promise.all(Array.from({ length: 5 }, () => app.runnerRequest("AUTO_EXPORT")));
  assert(responses.every((response) => response.ok)); assert.equal((await app.command("BOOT")).ok, true);
  assert.equal(app.downloads.length, 2);
});
test("finish ACK independently triggers both exports when the runner AUTO_EXPORT message disconnects", async () => {
  const app = await harness({ disconnectAutoExport: true });
  const task = await app.run(); assert.equal(task.status, "completed");
  await eventually(() => app.downloads.length === 2, "Background must export from its persisted finish, not require the disconnected runner");
  const contents = app.downloads.map(decodeDownload);
  assert.equal(contents.filter((text) => text === "\uFEFF目录：1 链接：https://share.weiyun.com/test1 密码：abcd\r\n").length, 1);
  assert.equal(contents.filter((text) => text.includes(app.context.folderUrl)).length, 1);
  assert.equal((await app.command("BOOT")).ok, true); assert.equal(app.downloads.length, 2);
});
test("BOOT repairs only the missing automatic log and never re-downloads the result", async () => {
  const app = await harness(); await app.run();
  await eventually(() => app.downloads.length === 2);
  await app.modify((task) => ({ ...task, autoLogExportRunId: null, logExportStatus: "none", logDownloadId: null }));
  assert.equal((await app.command("BOOT")).ok, true);
  await eventually(() => app.downloads.length === 3, "BOOT must repair the missing automatic log");
  assert(decodeDownload(app.downloads[2]).includes(app.context.folderUrl));
  assert.equal((await app.command("BOOT")).ok, true); assert.equal(app.downloads.length, 3);
});
test("ordinary RESUME with no pending work rejects without changing the run or re-downloading", async () => {
  const app = await harness({ count: 2, protectFailures: { "1": Infinity } });
  const task = await app.run(); assert.equal(task.status, "finished_with_errors");
  await eventually(() => app.downloads.length === 2); const before = app.getTask();
  assert.equal((await app.command("RESUME")).error?.code, "NO_PENDING_ITEMS");
  assert.deepEqual(app.getTask(), before); assert.equal(app.downloads.length, 2);
});
test("manual partial TXT and log exports do not suppress either complete automatic download", async () => {
  const app = await harness({ count: 3 }); const entered = deferred(), release = deferred();
  app.onCommit(async (event) => {
    if (event.type === "phase" && event.key === "item-2" && event.status === "opening_share") {
      entered.resolve(); await release.promise;
    }
  });
  await app.start();
  try {
    let reached = false; void entered.promise.then(() => { reached = true; });
    await eventually(() => reached, "Runner must reach item 2 before manual exports");
    assert.equal(app.getTask().items.filter((item) => item.status === "done").length, 1);
    assert.equal((await app.panelRequest("EXPORT")).ok, true);
    assert.equal((await app.panelRequest("EXPORT_LOG")).ok, true);
    assert.equal(app.downloads.length, 2);
    assert.equal(decodeDownload(app.downloads[0]), "\uFEFF目录：1 链接：https://share.weiyun.com/test1 密码：abcd\r\n");
  } finally { release.resolve(); }
  assert.equal((await app.idle()).status, "completed");
  assert.equal(app.downloads.length, 4);
  const expected = "\uFEFF目录：1 链接：https://share.weiyun.com/test1 密码：abcd\r\n目录：2 链接：https://share.weiyun.com/test2 密码：abcd\r\n目录：3 链接：https://share.weiyun.com/test3 密码：abcd\r\n";
  assert.equal(decodeDownload(app.downloads[2]), expected);
  const log = decodeDownload(app.downloads[3]);
  assert(log.includes(app.context.folderUrl)); assert(log.includes("https://share.weiyun.com/test3"));
  const responses = await Promise.all(Array.from({ length: 4 }, () => app.runnerRequest("AUTO_EXPORT")));
  assert(responses.every((response) => response.ok)); assert.equal(app.downloads.length, 4);
});
test("EXPORT_LOG downloads only a detailed log, not another simple TXT", async () => {
  const app = await harness(); await app.run(); const before = app.downloads.length;
  assert.equal((await app.command("EXPORT_LOG")).ok, true); assert.equal(app.downloads.length, before + 1);
  const log = decodeDownload(app.downloads.at(-1));
  assert.notEqual(log, app.model.exportTxt(app.getTask())); assert(log.includes(app.context.folderUrl));
});

async function panelHarness({ account = "uin:12345678", oldDocument = false, finishedWithErrors = false, completedCount = null, liveCount = null, taskStatus = null } = {}) {
  const app = await harness(); const task = await app.seedLegacy(); task.context.account = account;
  if (finishedWithErrors) { task.status = "finished_with_errors"; task.items[0].status = "failed"; task.items[0].attempts = 3; }
  if (completedCount !== null) {
    task.items = Array.from({ length: completedCount }, (_, index) => ({ ...task.items[0], key: `item-${index + 1}`, ordinal: index + 1, name: String(index + 1), status: "done", result: result(`https://share.weiyun.com/test${index + 1}`) }));
    task.expectedCount = completedCount;
    task.status = "completed";
  }
  if (taskStatus) task.status = taskStatus;
  if (oldDocument) task.context.documentNonce = "previous-document";
  const context = { ...app.context, account, expectedCount: liveCount ?? task.expectedCount };
  const nodes = new Map(), requests = [], confirmations = [];
  let answer = true, changed;
  const node = () => ({
    checked: false, scrollTop: 0, classList: { toggle() {} }, append() {}, replaceChildren() {}, handlers: new Map(),
    addEventListener(event, listener) { this.handlers.set(event, listener); },
    click() { this.handlers.get("click")?.({ target: this }); },
  });
  const html = artifact("panel.html");
  for (const [, id] of html.matchAll(/id="([^"]+)"/g)) nodes.set(id, node());
  const panel = vm.createContext({
    document: { getElementById: (id) => nodes.get(id), createElement: node },
    confirm(message) { confirmations.push(message); return answer; },
    chrome: {
      runtime: { async sendMessage(raw) {
        requests.push(clone(raw));
        if (raw.action === "BOOT") return { ok: true, data: { context, tabId: 1, tasks: [task] } };
        if ((raw.action === "RESUME" || raw.action === "START" && raw.reuseCompleted) && !task.context.account && task.context.documentNonce !== context.documentNonce) {
          if (raw.acknowledged !== true) return { ok: false, error: { code: "ACCOUNT_RECONFIRM_REQUIRED", message: "Confirm original account", uncertain: false, relatedUrls: [] } };
          task.context = clone(context);
        }
        if (raw.action === "START") return { ok: true, data: { task: { ...task, id: "new-task", context: clone(context), status: "scanning", items: [], snapshotAt: null, expectedCount: context.expectedCount }, existing: false } };
        return { ok: true, data: { ...task, context: clone(context), status: "paused" } };
      } },
      storage: { onChanged: { addListener(listener) { changed = listener; } } },
    }, task, context,
  });
  vm.runInContext(artifact("panel.js"), panel);
  await eventually(() => vm.runInContext("!busy && !!connection", panel));
  return { nodes, requests, confirmations, panel, html, changed: (...args) => changed(...args), answer(value) { answer = value; } };
}
test("completed 72-item panel surfaces both refresh choices and the live 73-item count", async () => {
  const app = await panelHarness({ completedCount: 72, liveCount: 73 });
  assert.equal(app.nodes.get("refresh-controls").hidden, false);
  assert.equal(app.nodes.get("add-items").disabled, false);
  assert.equal(app.nodes.get("new-task").disabled, false);
  assert.equal(app.nodes.get("directory-change").hidden, false);
  assert.match(app.nodes.get("directory-change").textContent, /当前目录 73 项，原任务快照 72 项/);
  assert(app.html.indexOf('id="new-task"') < app.html.indexOf('<details class="utilities">'));
  app.nodes.get("add-items").click();
  await eventually(() => app.requests.some((request) => request.action === "START"));
  const request = app.requests.find((entry) => entry.action === "START");
  assert.equal(request.reuseCompleted, true);
  assert.equal(request.newTask, true);
  assert.equal(request.taskId, "test-task");
  assert.equal(app.confirmations.length, 0);
});
test("full restart requires confirmation and does not request result reuse", async () => {
  const app = await panelHarness({ completedCount: 72, liveCount: 73 });
  app.answer(false);
  app.nodes.get("new-task").click();
  await eventually(() => !vm.runInContext("busy", app.panel));
  assert.equal(app.requests.some((request) => request.action === "START"), false);
  app.answer(true);
  app.nodes.get("new-task").click();
  await eventually(() => app.requests.some((request) => request.action === "START"));
  assert.equal(app.requests.find((entry) => entry.action === "START").reuseCompleted, false);
});
test("refresh choices remain available without a count change and are disabled during a run", async () => {
  const completed = await panelHarness({ completedCount: 72, liveCount: 72 });
  assert.equal(completed.nodes.get("directory-change").hidden, true);
  assert.equal(completed.nodes.get("add-items").disabled, false);
  const active = await panelHarness({ taskStatus: "running" });
  assert.equal(active.nodes.get("add-items").disabled, true);
  assert.equal(active.nodes.get("new-task").disabled, true);
});
test("refresh confirmation cannot reuse unknown-account results after cancellation", async () => {
  const app = await panelHarness({ completedCount: 72, liveCount: 73, account: null, oldDocument: true });
  app.answer(false);
  app.nodes.get("add-items").click();
  await eventually(() => app.confirmations.length === 1 && !vm.runInContext("busy", app.panel));
  assert.equal(app.requests.some((request) => request.acknowledged), false);
  app.answer(true);
  app.nodes.get("add-items").click();
  await eventually(() => app.requests.some((request) => request.action === "START" && request.acknowledged === true));
});
test("panel removes share-review forms, enables legacy RESUME and exposes export-log", async () => {
  const app = await panelHarness();
  for (const id of ["review", "review-ack", "review-current", "review-saved", "review-password", "review-url", "review-links", "reconcile"]) assert.equal(app.nodes.has(id), false, id);
  assert.doesNotMatch(app.html, /READ_REVIEW|RECONCILE|review-source/);
  assert.equal(app.nodes.get("resume").disabled, false); assert(app.nodes.has("export-log"));
  app.nodes.get("resume").click(); await eventually(() => app.requests.some((request) => request.action === "RESUME"));
  assert.equal(app.confirmations.length, 0);
  await eventually(() => vm.runInContext("!busy", app.panel));
  app.nodes.get("export-log").click(); await eventually(() => app.requests.some((request) => request.action === "EXPORT_LOG"));
});
test("unknown cross-document panel RESUME confirms on RPC rejection; cancellation never acknowledges", async () => {
  const app = await panelHarness({ account: null, oldDocument: true }); app.answer(false); app.nodes.get("resume").click();
  await eventually(() => app.confirmations.length === 1 && vm.runInContext("!busy", app.panel));
  assert.equal(app.requests.filter((request) => request.action === "RESUME").length, 1);
  assert.equal(app.requests.some((request) => request.acknowledged === true), false);
  app.answer(true); app.nodes.get("resume").click();
  await eventually(() => app.requests.some((request) => request.action === "RESUME" && request.acknowledged === true));
  await eventually(() => vm.runInContext("!busy", app.panel)); app.nodes.get("resume").click();
  await eventually(() => app.requests.filter((request) => request.action === "RESUME").length === 4);
  assert.equal(app.confirmations.length, 2, "A successful confirmation must not repeat in the same document");
});
test("finished-with-errors panel disables empty RESUME but retains explicit retry-failed", async () => {
  const app = await panelHarness({ finishedWithErrors: true });
  assert.equal(app.nodes.get("resume").disabled, true); assert.equal(app.nodes.get("retry").disabled, false);
  app.nodes.get("retry").click();
  await eventually(() => app.requests.some((request) => request.action === "RESUME" && request.retryFailed === true));
  assert.equal(app.confirmations.length, 0);
});
test("page refresh notifications during a busy panel operation are replayed afterward", async () => {
  const app = await panelHarness(), release = deferred(); app.panel.waitForOperation = () => release.promise;
  const operation = vm.runInContext("act(waitForOperation)", app.panel);
  app.changed({ targetDocumentVersion: { newValue: "new" } }, "session"); release.resolve(); await operation;
  await eventually(() => app.requests.filter((request) => request.action === "BOOT").length === 2);
  assert.equal(app.requests.filter((request) => request.action === "BOOT").length, 2);
});

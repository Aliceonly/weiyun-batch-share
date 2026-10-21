// src/model.ts
var SCHEMA_VERSION = 1;
var CHANNEL = "weiyun-batch-share/v1";
var ACTIVE_STATES = ["scanning", "running", "pausing"];
var FlowError = class extends Error {
  constructor(message, code = "FLOW_ERROR", uncertain = false, relatedUrls = []) {
    super(message);
    this.code = code;
    this.uncertain = uncertain;
    this.relatedUrls = relatedUrls;
    this.name = "FlowError";
  }
  code;
  uncertain;
  relatedUrls;
};
function asFlowError(error, uncertain = false) {
  if (error instanceof FlowError) return error;
  return new FlowError(
    error instanceof Error ? error.message : String(error),
    "UNEXPECTED",
    uncertain
  );
}
function errorInfo(error) {
  return {
    code: error.code,
    message: error.message,
    at: (/* @__PURE__ */ new Date()).toISOString(),
    ...error.relatedUrls.length ? { relatedUrls: error.relatedUrls } : {}
  };
}
function isActive(task) {
  return ACTIVE_STATES.includes(task.status);
}
function isShareUrl(value) {
  if (typeof value !== "string") return false;
  try {
    const url = new URL(value);
    return url.origin === "https://share.weiyun.com" && !url.username && !url.password && /^\/[A-Za-z0-9_-]+\/?$/.test(url.pathname) && !url.search && !url.hash;
  } catch {
    return false;
  }
}
function isPassword(value) {
  return typeof value === "string" && /^[A-Za-z0-9]{4,16}$/.test(value);
}
function shareUrlIdentity(value) {
  if (!isShareUrl(value)) return null;
  const url = new URL(value);
  return `${url.origin}${url.pathname.replace(/\/$/, "")}`;
}
function parseFolderUrl(value) {
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new FlowError("\u8BF7\u5148\u6253\u5F00\u5FAE\u4E91\u7F51\u9875\u7248\u7684\u4E00\u4E2A\u6587\u4EF6\u5939\u3002", "WRONG_PAGE");
  }
  if (url.protocol !== "https:" || !["www.weiyun.com", "weiyun.com"].includes(url.hostname) || url.port || url.username || url.password) {
    throw new FlowError("\u8BF7\u5728\u5FAE\u4E91\u7F51\u9875\u7248\u7684\u6587\u4EF6\u5939\u9875\u9762\u4F7F\u7528\u3002", "WRONG_PAGE");
  }
  const folder = url.pathname.match(/^\/disk\/folder\/([A-Za-z0-9_-]+)\/?$/);
  const root = /^\/disk\/?$/.test(url.pathname);
  if (!folder && !root || url.search || url.hash) {
    throw new FlowError("\u8BF7\u8FDB\u5165\u5177\u4F53\u6587\u4EF6\u5939\uFF0C\u9000\u51FA\u641C\u7D22\u3001\u7B5B\u9009\u6216\u5206\u4EAB\u8BBF\u95EE\u9875\u9762\u3002", "WRONG_PAGE");
  }
  return {
    origin: url.origin,
    folderId: folder?.[1] ?? "root",
    folderUrl: `${url.origin}${root ? "/disk" : `/disk/folder/${folder[1]}`}`
  };
}
var collator = new Intl.Collator("zh-CN", { numeric: true, sensitivity: "variant" });
function naturalSort(items) {
  return [...items].sort(
    (left, right) => collator.compare(left.name, right.name) || left.key.localeCompare(right.key)
  );
}
function sameFolder(left, right) {
  return left.origin === right.origin && left.folderId === right.folderId;
}
function assertContext(expected, actual) {
  if (!sameFolder(expected, actual)) {
    throw new FlowError("\u76EE\u6807\u76EE\u5F55\u5DF2\u53D8\u5316\uFF0C\u4EFB\u52A1\u5DF2\u505C\u6B62\u3002\u8BF7\u56DE\u5230\u539F\u76EE\u5F55\u540E\u7EE7\u7EED\u3002", "DIRECTORY_CHANGED");
  }
  if (expected.account && expected.account !== actual.account) {
    throw new FlowError("\u65E0\u6CD5\u786E\u8BA4\u5F53\u524D\u767B\u5F55\u8D26\u53F7\u4E0E\u539F\u4EFB\u52A1\u4E00\u81F4\uFF0C\u8BF7\u91CD\u65B0\u767B\u5F55\u539F\u8D26\u53F7\u540E\u518D\u7EE7\u7EED\u3002", "ACCOUNT_CHANGED");
  }
}
function createTask(context, tabId, id, runId) {
  const now = (/* @__PURE__ */ new Date()).toISOString();
  return {
    schemaVersion: SCHEMA_VERSION,
    id,
    runId,
    tabId,
    context,
    status: "scanning",
    revision: 0,
    createdAt: now,
    updatedAt: now,
    snapshotAt: null,
    expectedCount: context.expectedCount,
    foundCount: 0,
    items: [],
    pauseRequested: false,
    currentItemKey: null,
    message: "\u6B63\u5728\u8BFB\u53D6\u5B8C\u6574\u76EE\u5F55\uFF0C\u5C1A\u672A\u521B\u5EFA\u5206\u4EAB\u3002",
    error: null,
    exportStatus: "none",
    downloadId: null,
    logExportStatus: "none",
    logDownloadId: null,
    importedCandidates: []
  };
}
var transitions = {
  pending: ["opening_share"],
  opening_share: ["link_observed"],
  link_observed: ["securing"],
  securing: ["verifying"],
  verifying: ["done"],
  done: [],
  failed: [],
  needs_review: []
};
function requireItem(task, key) {
  const item = task.items.find((entry) => entry.key === key);
  if (!item) throw new FlowError("\u4EFB\u52A1\u9879\u76EE\u4E0D\u5B58\u5728\u3002", "INVALID_ITEM");
  return item;
}
function archiveAttempt(item, recordError = true) {
  item.relatedShares = [...new Set([
    ...item.relatedShares ?? [],
    item.observedUrl,
    item.candidate?.url,
    ...item.error?.relatedUrls ?? []
  ].filter(isShareUrl))];
  if (recordError && item.error && !(item.attemptHistory ?? []).some((error) => error.at === item.error.at && error.code === item.error.code && error.message === item.error.message)) {
    item.attemptHistory = [...item.attemptHistory ?? [], item.error];
  }
}
function resetItem(item, now) {
  const restartRequired = item.restartRequired || item.status !== "pending" || !!item.observedUrl || !!item.candidate || !!item.manualReview;
  archiveAttempt(item);
  item.status = "pending";
  item.observedUrl = null;
  item.observedPassword = null;
  item.result = null;
  item.candidate = null;
  item.error = null;
  delete item.manualReview;
  if (restartRequired) item.restartRequired = true;
  else delete item.restartRequired;
  item.updatedAt = now;
}
function applyEvent(original, runId, event) {
  if (original.runId !== runId) throw new FlowError("\u65E7\u6267\u884C\u5668\u5DF2\u5931\u6548\uFF0C\u7981\u6B62\u7EE7\u7EED\u64CD\u4F5C\u3002", "STALE_RUN");
  const task = structuredClone(original);
  if (["completed", "finished_with_errors"].includes(task.status) && event.type !== "task_error") {
    throw new FlowError("\u4EFB\u52A1\u5DF2\u7ECF\u7ED3\u675F\u3002", "TASK_FINISHED");
  }
  const now = (/* @__PURE__ */ new Date()).toISOString();
  switch (event.type) {
    case "scan_progress":
      if (task.snapshotAt) throw new FlowError("\u9879\u76EE\u5FEB\u7167\u5DF2\u7ECF\u56FA\u5B9A\u3002", "INVALID_TRANSITION");
      task.foundCount = event.found;
      task.expectedCount = event.expected;
      task.context.expectedCount = event.expected;
      task.message = `\u6B63\u5728\u8BFB\u53D6\u76EE\u5F55\uFF1A${event.found} / ${event.expected}`;
      break;
    case "scan_done": {
      if (task.snapshotAt || event.items.length !== event.expected) {
        throw new FlowError("\u76EE\u5F55\u6570\u91CF\u672A\u901A\u8FC7\u6821\u9A8C\u3002", "INCOMPLETE_SCAN");
      }
      const keys = new Set(event.items.map((item) => item.key));
      if (keys.size !== event.items.length) throw new FlowError("\u76EE\u5F55\u5B58\u5728\u65E0\u6CD5\u533A\u5206\u7684\u9879\u76EE\u3002", "AMBIGUOUS_ITEMS");
      for (const candidate of task.importedCandidates) {
        if (event.items.filter((item) => item.name === candidate.name).length !== 1) {
          throw new FlowError(`\u5BFC\u5165\u8BB0\u5F55\u201C${candidate.name}\u201D\u65E0\u6CD5\u552F\u4E00\u5339\u914D\u5F53\u524D\u76EE\u5F55\u3002`, "IMPORT_MISMATCH");
        }
      }
      task.items = naturalSort(event.items).map((item, index) => {
        const imported = task.importedCandidates.find((candidate) => candidate.name === item.name);
        return {
          key: item.key,
          name: item.name,
          kind: item.kind,
          siteId: item.siteId,
          fingerprint: item.fingerprint,
          scrollHint: item.scrollHint,
          pageHint: item.pageHint,
          ordinal: index + 1,
          status: "pending",
          attempts: 0,
          observedUrl: null,
          observedPassword: null,
          relatedShares: imported?.relatedShares ?? [],
          result: null,
          candidate: imported?.url ? { url: imported.url, password: imported.password } : null,
          error: null,
          attemptHistory: imported?.needsReview ? [{
            code: "IMPORTED_UNCERTAIN",
            message: "\u5BFC\u5165\u8BB0\u5F55\u4E2D\u8BE5\u9879\u76EE\u72B6\u6001\u4E0D\u786E\u5B9A\uFF0C\u5C06\u91CD\u65B0\u5206\u4EAB\u5E76\u8BB0\u5F55\u672C\u6B21\u7ED3\u679C\u3002",
            at: now
          }] : [],
          updatedAt: now
        };
      });
      task.expectedCount = event.expected;
      task.foundCount = event.expected;
      task.snapshotAt = now;
      task.status = task.pauseRequested ? "pausing" : "running";
      task.message = `\u6E05\u5355\u5DF2\u8BFB\u53D6\uFF0C\u5171 ${event.expected} \u9879\u3002`;
      break;
    }
    case "phase": {
      if (!["running", "pausing"].includes(task.status)) throw new FlowError("\u4EFB\u52A1\u5F53\u524D\u4E0D\u53EF\u6267\u884C\u3002", "NOT_RUNNING");
      const item = requireItem(task, event.key);
      if (!transitions[item.status].includes(event.status)) throw new FlowError("\u9879\u76EE\u72B6\u6001\u53D1\u751F\u51B2\u7A81\u3002", "INVALID_TRANSITION");
      if (task.currentItemKey && task.currentItemKey !== item.key) throw new FlowError("\u5DF2\u6709\u53E6\u4E00\u9879\u76EE\u6B63\u5728\u5904\u7406\u3002", "CONCURRENT_ITEM");
      if (event.url && !isShareUrl(event.url)) throw new FlowError("\u5206\u4EAB\u94FE\u63A5\u683C\u5F0F\u4E0D\u53D7\u652F\u6301\u3002", "INVALID_URL", true);
      if (event.password && !isPassword(event.password)) throw new FlowError("\u8BBF\u95EE\u5BC6\u7801\u683C\u5F0F\u5F02\u5E38\u3002", "INVALID_PASSWORD", true);
      if (event.url && item.observedUrl && item.observedUrl !== event.url) {
        throw new FlowError("\u672C\u6B21\u64CD\u4F5C\u4E2D\u5206\u4EAB\u94FE\u63A5\u53D1\u751F\u53D8\u5316\uFF0C\u5C06\u91CD\u65B0\u5C1D\u8BD5\u3002", "URL_CHANGED", true, [item.observedUrl, event.url]);
      }
      if (event.status === "opening_share") {
        item.attempts += 1;
        delete item.restartRequired;
      }
      item.status = event.status;
      if (event.url) item.observedUrl = event.url;
      if (event.password) item.observedPassword = event.password;
      item.updatedAt = now;
      task.currentItemKey = item.key;
      task.message = `\u6B63\u5728\u5904\u7406 ${item.ordinal} / ${task.items.length}\uFF1A${item.name}`;
      break;
    }
    case "item_done": {
      const item = requireItem(task, event.key);
      const result = event.result;
      if (item.status !== "verifying" || !isShareUrl(result.url) || !isPassword(result.password) || result.passwordEnabled !== true || result.verification !== "same_dialog" || result.url !== item.observedUrl || result.password !== item.observedPassword || !Number.isFinite(Date.parse(result.verifiedAt))) {
        throw new FlowError("\u94FE\u63A5\u6216\u5BC6\u7801\u672A\u901A\u8FC7\u5B8C\u6210\u6821\u9A8C\u3002", "UNVERIFIED_RESULT", true);
      }
      const duplicate = task.items.find((entry) => entry.key !== item.key && entry.result && shareUrlIdentity(entry.result.url) === shareUrlIdentity(result.url));
      if (duplicate) throw new FlowError(`\u5206\u4EAB\u94FE\u63A5\u4E0E\u201C${duplicate.name}\u201D\u91CD\u590D\uFF0C\u5DF2\u505C\u6B62\u4EE5\u907F\u514D\u8BB0\u5F55\u9519\u8BEF\u9879\u76EE\u3002`, "DUPLICATE_URL", true, [result.url]);
      item.result = result;
      item.status = "done";
      item.error = null;
      delete item.manualReview;
      item.updatedAt = now;
      task.currentItemKey = null;
      break;
    }
    case "related_share": {
      const item = requireItem(task, event.key);
      if (!isShareUrl(event.url) || item.status === "done") throw new FlowError("\u65E0\u6CD5\u8BB0\u5F55\u76F8\u5173\u5206\u4EAB\u94FE\u63A5\u3002", "INVALID_URL", true);
      if (!item.relatedShares.includes(event.url)) item.relatedShares.push(event.url);
      item.updatedAt = now;
      break;
    }
    case "restart": {
      if (!["running", "pausing"].includes(task.status)) throw new FlowError("\u4EFB\u52A1\u5F53\u524D\u4E0D\u53EF\u6267\u884C\u3002", "NOT_RUNNING");
      const item = requireItem(task, event.key);
      if (item.status === "done" || task.currentItemKey && task.currentItemKey !== item.key) {
        throw new FlowError("\u4E0D\u80FD\u91CD\u65B0\u5206\u4EAB\u5DF2\u5B8C\u6210\u9879\u76EE\u6216\u53E6\u4E00\u6B63\u5728\u5904\u7406\u7684\u9879\u76EE\u3002", "INVALID_TRANSITION");
      }
      resetItem(item, now);
      task.currentItemKey = null;
      task.message = `\u6B63\u5728\u91CD\u65B0\u5C1D\u8BD5 ${item.ordinal} / ${task.items.length}\uFF1A${item.name}`;
      break;
    }
    case "item_error": {
      const item = requireItem(task, event.key);
      if (item.status === "done") throw new FlowError("\u5DF2\u5B8C\u6210\u9879\u76EE\u4E0D\u80FD\u964D\u7EA7\u91CD\u8BD5\u3002", "INVALID_TRANSITION");
      item.status = "failed";
      item.error = event.error;
      item.attemptHistory = [...item.attemptHistory ?? [], event.error];
      archiveAttempt(item, false);
      item.updatedAt = now;
      task.currentItemKey = null;
      task.message = `\u201C${item.name}\u201D\u672C\u6B21\u5931\u8D25\uFF1A${event.error.message}`;
      break;
    }
    case "pause":
      task.pauseRequested = true;
      if (isActive(task)) task.status = "pausing";
      task.message = "\u6682\u505C\u5DF2\u8BF7\u6C42\uFF0C\u5F53\u524D\u9879\u76EE\u4FDD\u62A4\u53CA\u4FDD\u5B58\u5B8C\u6210\u540E\u6682\u505C\u3002";
      break;
    case "paused":
      task.status = "paused";
      task.pauseRequested = false;
      task.currentItemKey = null;
      task.message = event.message ?? "\u5DF2\u6682\u505C\uFF0C\u5DF2\u5B8C\u6210\u7ED3\u679C\u5DF2\u4FDD\u5B58\u3002";
      break;
    case "task_error": {
      task.status = "error";
      task.error = event.error;
      task.message = event.error.message;
      const item = task.items.find((entry) => entry.key === task.currentItemKey);
      if (item && item.status !== "done") {
        item.error = event.error;
        archiveAttempt(item);
        item.updatedAt = now;
      }
      break;
    }
    case "finish":
      if (task.items.some((item) => !["done", "failed"].includes(item.status))) {
        throw new FlowError("\u4ECD\u6709\u672A\u5B8C\u6210\u9879\u76EE\u3002", "UNFINISHED_TASK");
      }
      task.status = task.items.every((item) => item.status === "done") ? "completed" : "finished_with_errors";
      task.currentItemKey = null;
      task.message = task.status === "completed" ? "\u5168\u90E8\u5B8C\u6210\uFF0C\u6B63\u5728\u5BFC\u51FA\u7ED3\u679C\u548C\u65E5\u5FD7\u3002" : "\u5904\u7406\u7ED3\u675F\uFF0C\u90E8\u5206\u9879\u76EE\u5931\u8D25\uFF0C\u53EF\u4EC5\u91CD\u8BD5\u5931\u8D25\u9879\uFF1B\u6B63\u5728\u5BFC\u51FA\u7ED3\u679C\u548C\u65E5\u5FD7\u3002";
      break;
  }
  task.updatedAt = now;
  task.revision += 1;
  return task;
}
function resumeTask(task, context, tabId, runId, retryFailed = false) {
  if (task.status === "completed") throw new FlowError("\u4EFB\u52A1\u5DF2\u7ECF\u5B8C\u6210\uFF0C\u53EF\u76F4\u63A5\u5BFC\u51FA\u7ED3\u679C\u3002", "TASK_FINISHED");
  assertContext(task.context, context);
  if (task.status === "finished_with_errors" && (!retryFailed || !task.items.some((item) => item.status === "failed"))) {
    throw new FlowError("\u6CA1\u6709\u5F85\u7EE7\u7EED\u9879\u76EE\uFF0C\u8BF7\u4F7F\u7528\u201C\u4EC5\u91CD\u8BD5\u5931\u8D25\u9879\u201D\u6216\u5BFC\u51FA\u5DF2\u4FDD\u5B58\u7ED3\u679C\u3002", "NO_PENDING_ITEMS");
  }
  const next = structuredClone(task);
  if (task.context.account === null && task.context.documentNonce !== context.documentNonce) {
    throw new FlowError("\u9875\u9762\u5DF2\u91CD\u65B0\u6253\u5F00\uFF0C\u4E14\u65E0\u6CD5\u8BC6\u522B\u539F\u8D26\u53F7\u3002\u8BF7\u786E\u8BA4\u4ECD\u4E3A\u539F\u8D26\u53F7\u540E\u7EE7\u7EED\u3002", "ACCOUNT_RECONFIRM_REQUIRED");
  }
  next.tabId = tabId;
  next.runId = runId;
  next.context = { ...context };
  next.status = next.snapshotAt ? "running" : "scanning";
  next.pauseRequested = false;
  next.currentItemKey = null;
  next.error = null;
  next.exportStatus = "none";
  next.downloadId = null;
  next.logExportStatus = "none";
  next.logDownloadId = null;
  next.autoExportRunId = null;
  next.autoLogExportRunId = null;
  next.message = "\u6B63\u5728\u6062\u590D\u539F\u4EFB\u52A1\uFF1B\u4E2D\u65AD\u6216\u72B6\u6001\u4E0D\u786E\u5B9A\u7684\u9879\u76EE\u5C06\u91CD\u65B0\u5206\u4EAB\u3002";
  next.items.forEach((item) => {
    if (item.status !== "done" && (item.status !== "failed" || retryFailed)) {
      resetItem(item, (/* @__PURE__ */ new Date()).toISOString());
    }
  });
  next.updatedAt = (/* @__PURE__ */ new Date()).toISOString();
  next.revision += 1;
  return next;
}

// src/exporter.ts
function oneLine(value) {
  return String(value).replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]/g, " ").trim();
}
function hasExportableResult(item) {
  const result = item.result;
  return item.status === "done" && result !== null && isShareUrl(result?.url) && result.url === oneLine(result.url) && isPassword(result.password) && result.passwordEnabled === true;
}
function exportTxt(task, _date = /* @__PURE__ */ new Date()) {
  const lines = [...task.items].sort((a, b) => a.ordinal - b.ordinal).filter(hasExportableResult).map((item) => `${item.ordinal}.\u94FE\u63A5\uFF1A${item.result.url} \u5BC6\u7801\uFF1A${item.result.password}`);
  return `\uFEFF${lines.length ? `${lines.join("\r\n")}\r
` : ""}`;
}
function exportLog(task, date = /* @__PURE__ */ new Date()) {
  const lines = ["\u5FAE\u4E91\u5206\u4EAB\u5BFC\u51FA\u65E5\u5FD7"];
  const add = (label, value) => {
    lines.push(`${label}\uFF1A${value == null ? "\u65E0" : oneLine(value)}`);
  };
  const addUrls = (label, urls = []) => {
    for (const url of urls) add(label, url);
  };
  const addError = (label, error) => {
    if (!error) {
      add(label, "\u65E0");
      return;
    }
    add(`${label}\u4EE3\u7801`, error.code);
    add(`${label}\u539F\u56E0`, error.message);
    add(`${label}\u65F6\u95F4`, error.at);
    addUrls(`${label}\u76F8\u5173 URL\uFF08\u5386\u53F2\u8BB0\u5F55\uFF0C\u4E0D\u4EE3\u8868\u5DF2\u53D6\u6D88\uFF09`, error.relatedUrls);
  };
  const exportable = task.items.filter(hasExportableResult).length;
  const complete = task.status === "completed" && task.snapshotAt !== null && task.expectedCount === task.items.length && task.foundCount === task.items.length && exportable === task.items.length;
  const counts = /* @__PURE__ */ new Map();
  for (const item of task.items) counts.set(item.status, (counts.get(item.status) ?? 0) + 1);
  add("\u76EE\u5F55\u539F\u540D", task.context.folderName);
  add("\u6765\u6E90\u76EE\u5F55", task.context.folderUrl);
  add("\u76EE\u5F55 ID", task.context.folderId);
  add("\u8303\u56F4", "\u5F53\u524D\u76EE\u5F55\u7684\u76F4\u63A5\u9879\u76EE\uFF0C\u6BCF\u9879\u72EC\u7ACB\u5206\u4EAB");
  add("\u4EFB\u52A1 ID", task.id);
  add("\u6267\u884C ID", task.runId);
  add("\u4EFB\u52A1\u72B6\u6001", task.status);
  add("\u662F\u5426\u5B8C\u6574", complete ? "\u662F\uFF08\u5168\u90E8\u5B8C\u6210\uFF09" : "\u5426\uFF08\u672A\u5B8C\u6210 / \u90E8\u5206\u7ED3\u679C\uFF09");
  add("\u6E05\u5355\u9879\u76EE\u6570", task.expectedCount ?? "\u672A\u786E\u8BA4");
  add("\u5DF2\u53D1\u73B0\u9879\u76EE\u6570", task.foundCount);
  add("\u5DF2\u8BB0\u5F55\u9879\u76EE\u6570", task.items.length);
  add("\u53EF\u5BFC\u51FA\u6210\u529F\u9879", exportable);
  add("\u672A\u5BFC\u51FA\u9879\u76EE\u6570", task.items.length - exportable);
  add("\u5404\u9879\u72B6\u6001\u6570\u91CF", [...counts].map(([status, count]) => `${status}=${count}`).join("\uFF1B") || "\u65E0");
  add("\u521B\u5EFA\u65F6\u95F4", task.createdAt);
  add("\u66F4\u65B0\u65F6\u95F4", task.updatedAt);
  add("\u5FEB\u7167\u65F6\u95F4", task.snapshotAt);
  add("\u5BFC\u51FA\u65F6\u95F4", date.toISOString());
  add("\u4EFB\u52A1\u63D0\u793A", task.message);
  addError("\u4EFB\u52A1\u9519\u8BEF", task.error);
  add("\u9A8C\u8BC1\u8FB9\u754C", "\u7ED3\u679C TXT \u4EC5\u6536\u5F55 status=done\u3001URL/\u5BC6\u7801\u683C\u5F0F\u5408\u6CD5\u4E14 passwordEnabled=true \u7684\u5F53\u524D result\uFF1B\u672A\u72EC\u7ACB\u9A8C\u8BC1\u63A5\u6536\u7AEF\u8BBF\u95EE\uFF0C\u4E0D\u4FDD\u8BC1\u94FE\u63A5\u6301\u7EED\u6709\u6548\u3002");
  add("\u5386\u53F2\u8BF4\u660E", "\u5386\u53F2\u76F8\u5173\u94FE\u63A5\u4E0D\u4EE3\u8868\u5DF2\u53D6\u6D88\uFF1B\u4E2D\u65AD\u6216\u5BC6\u7801\u4E0D\u786E\u5B9A\u540E\u7684\u91CD\u590D\u5206\u4EAB\u53EF\u80FD\u4FDD\u7559\u65E7\u94FE\u63A5\uFF0C\u4EC5\u6700\u540E\u6210\u529F\u7684\u5F53\u524D result \u8FDB\u5165\u7ED3\u679C TXT\u3002");
  for (const item of [...task.items].sort((a, b) => a.ordinal - b.ordinal)) {
    lines.push("");
    add("\u9879\u76EE", `${item.ordinal}. ${item.name}`);
    add("\u9879\u76EE key", item.key);
    add("\u9879\u76EE\u539F\u540D", item.name);
    add("\u9879\u76EE\u7C7B\u578B", item.kind);
    add("\u9879\u76EE\u72B6\u6001", item.status);
    add("\u5C1D\u8BD5\u6B21\u6570", item.attempts);
    add("\u9879\u76EE\u66F4\u65B0\u65F6\u95F4", item.updatedAt);
    add("\u7ED3\u679C TXT", hasExportableResult(item) ? "\u5DF2\u6536\u5F55\u5F53\u524D result" : item.status === "done" ? "\u672A\u6536\u5F55\uFF1A\u5F53\u524D result \u7F3A\u5931\u3001\u51ED\u636E\u683C\u5F0F\u65E0\u6548\u6216\u5BC6\u7801\u672A\u542F\u7528" : "\u672A\u6536\u5F55\uFF1A\u5F53\u524D\u72B6\u6001\u4E0D\u662F done");
    addError("\u9879\u76EE\u9519\u8BEF", item.error);
    add("\u5F53\u524D result URL", item.result?.url);
    if (item.result) {
      add("result \u5BC6\u7801", item.result.password);
      add("result passwordEnabled", item.result.passwordEnabled);
      add("result \u6709\u6548\u671F", item.result.expiry);
      add("result \u9A8C\u8BC1\u65F6\u95F4", item.result.verifiedAt);
      add("result verification\uFF08\u65E7\u503C\u4EC5\u4E3A\u5386\u53F2\u6807\u7B7E\uFF09", item.result.verification);
      if (item.result.reviewSource) add("result reviewSource\uFF08\u5386\u53F2\u6807\u7B7E\uFF09", item.result.reviewSource);
    }
    add("\u5F53\u524D candidate URL\uFF08\u975E\u6210\u529F\u51ED\u636E\uFF09", item.candidate?.url);
    add("candidate \u5BC6\u7801", item.candidate?.password);
    add("\u5F53\u524D observed URL\uFF08\u975E\u6210\u529F\u51ED\u636E\uFF09", item.observedUrl);
    add("observed \u5BC6\u7801", item.observedPassword);
    addUrls("\u5386\u53F2\u76F8\u5173\u94FE\u63A5\uFF08\u4E0D\u4EE3\u8868\u5DF2\u53D6\u6D88\uFF09", item.relatedShares);
    const history = item.attemptHistory ?? [];
    add("\u5C1D\u8BD5\u9519\u8BEF\u5386\u53F2 attemptHistory \u6570\u91CF", history.length);
    history.forEach((error, index) => addError(`attemptHistory[${index + 1}] `, error));
  }
  for (const [index, candidate] of task.importedCandidates.entries()) {
    lines.push("");
    add("\u5BFC\u5165\u5019\u9009\u8BB0\u5F55", index + 1);
    add("\u5019\u9009\u539F\u540D", candidate.name);
    add("\u5BFC\u5165 candidate URL\uFF08\u975E\u6210\u529F\u51ED\u636E\uFF09", candidate.url);
    add("\u5BFC\u5165 candidate \u5BC6\u7801", candidate.password);
    addUrls("\u5BFC\u5165\u5386\u53F2\u76F8\u5173\u94FE\u63A5\uFF08\u4E0D\u4EE3\u8868\u5DF2\u53D6\u6D88\uFF09", candidate.relatedShares);
  }
  return `\uFEFF${lines.join("\r\n")}\r
`;
}
function safeFilename(name) {
  const value = name.replace(/[<>:"/\\|?*\u0000-\u001f]/g, "_").replace(/[. ]+$/g, "").slice(0, 70);
  return value && !/^(CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(?:\.|$)/i.test(value) ? value : "\u5FAE\u4E91\u76EE\u5F55";
}
function exportFilename(task, extension = "txt", purpose = "results") {
  const stamp = (/* @__PURE__ */ new Date()).toISOString().replace(/[-:]/g, "").replace(/\.\d+Z$/, "").replace("T", "_");
  const label = purpose === "log" ? "\u5BFC\u51FA\u65E5\u5FD7" : purpose === "backup" ? "\u8FDB\u5EA6\u5907\u4EFD" : task.status === "completed" ? "\u5206\u4EAB\u94FE\u63A5" : "\u90E8\u5206\u7ED3\u679C";
  return `\u5FAE\u4E91_${safeFilename(task.context.folderName)}_${label}_${stamp}.${extension}`;
}
function dataUrl(text, mime = "text/plain") {
  return `data:${mime};charset=utf-8,${encodeURIComponent(text)}`;
}

// src/importer.ts
function parseImport(contents, context) {
  if (contents.length > 2e6) throw new FlowError("\u8FDB\u5EA6\u6587\u4EF6\u8D85\u8FC7 2 MB\u3002", "IMPORT_TOO_LARGE");
  let value;
  try {
    value = JSON.parse(contents.replace(/^\uFEFF/, ""));
  } catch {
    throw new FlowError("\u8FDB\u5EA6\u6587\u4EF6\u4E0D\u662F\u6709\u6548\u7684 JSON\u3002", "INVALID_IMPORT");
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new FlowError("\u8FDB\u5EA6\u6587\u4EF6\u683C\u5F0F\u9519\u8BEF\u3002", "INVALID_IMPORT");
  const candidates = [];
  if (value.schemaVersion === 1 && Array.isArray(value.items) && value.context && typeof value.context === "object") {
    const source = value.context;
    const route = parseFolderUrl(String(source.folderUrl ?? ""));
    if (route.folderId !== context.folderId || route.origin !== context.origin) {
      throw new FlowError("\u5907\u4EFD\u7684\u6765\u6E90\u76EE\u5F55\u4E0E\u5F53\u524D\u76EE\u5F55\u4E0D\u540C\u3002", "IMPORT_WRONG_FOLDER");
    }
    if (source.account && source.account !== context.account) throw new FlowError("\u65E0\u6CD5\u786E\u8BA4\u5907\u4EFD\u6240\u5C5E\u8D26\u53F7\u3002", "IMPORT_WRONG_ACCOUNT");
    for (const raw of value.items) {
      if (!raw || typeof raw !== "object") throw new FlowError("\u8FDB\u5EA6\u9879\u76EE\u683C\u5F0F\u9519\u8BEF\u3002", "INVALID_IMPORT");
      const row = raw;
      const result = row.result && typeof row.result === "object" ? row.result : null;
      const candidate = row.candidate && typeof row.candidate === "object" ? row.candidate : null;
      const url = result?.url ?? row.observedUrl ?? candidate?.url ?? null;
      const password = result?.password ?? row.observedPassword ?? candidate?.password ?? null;
      const relatedShares = Array.isArray(row.relatedShares) ? row.relatedShares.map(String) : [];
      const uncertain = ["opening_share", "link_observed", "securing", "verifying", "needs_review"].includes(String(row.status)) || relatedShares.length > 0 || result?.verification === "manual_review";
      if (url !== null || uncertain) {
        candidates.push({
          name: String(row.name ?? ""),
          url: url === null ? null : String(url),
          password: password === null ? null : String(password),
          needsReview: uncertain,
          ...relatedShares.length ? { relatedShares } : {}
        });
      }
    }
    if (!value.items.length && Array.isArray(value.importedCandidates)) {
      for (const raw of value.importedCandidates) {
        if (!raw || typeof raw !== "object") throw new FlowError("\u5019\u9009\u8BB0\u5F55\u683C\u5F0F\u9519\u8BEF\u3002", "INVALID_IMPORT");
        const row = raw;
        candidates.push({
          name: String(row.name ?? ""),
          url: row.url === null ? null : String(row.url ?? ""),
          password: row.password === null ? null : String(row.password ?? ""),
          needsReview: row.needsReview === true,
          ...Array.isArray(row.relatedShares) ? { relatedShares: row.relatedShares.map(String) } : {}
        });
      }
    }
  } else if (Array.isArray(value.rows) && typeof value.sourceFolder === "string") {
    if (value.sourceFolder !== context.folderName) throw new FlowError("\u65E7\u8FDB\u5EA6\u7684\u76EE\u5F55\u540D\u79F0\u4E0E\u5F53\u524D\u76EE\u5F55\u4E0D\u5339\u914D\u3002", "IMPORT_WRONG_FOLDER");
    let highest = 0;
    for (const raw of value.rows) {
      if (!raw || typeof raw !== "object") throw new FlowError("\u65E7\u8FDB\u5EA6\u9879\u76EE\u683C\u5F0F\u9519\u8BEF\u3002", "INVALID_IMPORT");
      const row = raw;
      const index = Number(row.index);
      if (!Number.isSafeInteger(index) || index < 1) throw new FlowError("\u65E7\u8FDB\u5EA6\u4E2D\u7684\u5E8F\u53F7\u65E0\u6548\u3002", "INVALID_IMPORT");
      highest = Math.max(highest, index);
      candidates.push({ name: String(index), url: String(row.url ?? ""), password: String(row.password ?? ""), needsReview: false });
    }
    if (typeof value.total === "number" && highest < value.total) {
      candidates.push({ name: String(highest + 1), url: null, password: null, needsReview: true });
    }
  } else {
    throw new FlowError("\u4E0D\u662F\u53D7\u652F\u6301\u7684\u63D2\u4EF6\u8FDB\u5EA6\u6216\u65E7\u7248\u5FAE\u4E91\u5206\u4EAB checkpoint\u3002", "INVALID_IMPORT");
  }
  if (candidates.length > 1e4 || !candidates.length) throw new FlowError("\u8FDB\u5EA6\u4E2D\u6CA1\u6709\u53EF\u5BFC\u5165\u7684\u5206\u4EAB\u8BB0\u5F55\u3002", "INVALID_IMPORT");
  const names = /* @__PURE__ */ new Set();
  for (const candidate of candidates) {
    if (!candidate.name || candidate.name.length > 1024 || names.has(candidate.name)) throw new FlowError("\u8FDB\u5EA6\u5305\u542B\u65E0\u6548\u6216\u91CD\u590D\u9879\u76EE\u540D\u3002", "INVALID_IMPORT");
    if (candidate.url !== null && !isShareUrl(candidate.url)) throw new FlowError("\u8FDB\u5EA6\u5305\u542B\u975E\u5FAE\u4E91\u5206\u4EAB\u94FE\u63A5\u3002", "INVALID_IMPORT");
    if (candidate.password !== null && !isPassword(candidate.password)) throw new FlowError("\u8FDB\u5EA6\u4E2D\u7684\u5BC6\u7801\u683C\u5F0F\u9519\u8BEF\u3002", "INVALID_IMPORT");
    if (candidate.relatedShares?.some((url) => !isShareUrl(url))) throw new FlowError("\u8FDB\u5EA6\u5305\u542B\u975E\u6CD5\u76F8\u5173\u94FE\u63A5\u3002", "INVALID_IMPORT");
    names.add(candidate.name);
  }
  return candidates;
}

// src/protocol.ts
function request(action, fields = {}) {
  return { ...fields, channel: CHANNEL, action };
}
function isRequest(value) {
  return !!value && typeof value === "object" && value.channel === CHANNEL && typeof value.action === "string";
}

// src/store.ts
var TaskStore = class {
  constructor(storage) {
    this.storage = storage;
  }
  storage;
  tail = Promise.resolve();
  async get(id) {
    const value = await this.storage.get(`task:${id}`);
    return value ? value : null;
  }
  serialize(operation) {
    const result = this.tail.then(operation, operation);
    this.tail = result.catch(() => void 0);
    return result;
  }
  saveNew(task) {
    return this.serialize(async () => {
      if (await this.get(task.id)) throw new FlowError("\u4EFB\u52A1\u5DF2\u5B58\u5728\u3002", "TASK_EXISTS");
      await this.storage.set(`task:${task.id}`, task);
      return task;
    });
  }
  modify(id, operation) {
    return this.serialize(async () => {
      const current = await this.get(id);
      if (!current) throw new FlowError("\u627E\u4E0D\u5230\u4FDD\u5B58\u7684\u4EFB\u52A1\u3002", "TASK_NOT_FOUND");
      const next = operation(current);
      await this.storage.set(`task:${id}`, next);
      return next;
    });
  }
  event(id, runId, event) {
    return this.modify(id, (task) => applyEvent(task, runId, event));
  }
};

// src/background.ts
var ready = chrome.storage.local.setAccessLevel({ accessLevel: "TRUSTED_CONTEXTS" });
var store = new TaskStore({
  get: async (key) => (await chrome.storage.local.get(key))[key],
  set: async (key, value) => {
    try {
      await chrome.storage.local.set({ [key]: value });
    } catch {
      throw new FlowError("\u672C\u5730\u8FDB\u5EA6\u5199\u5165\u5931\u8D25\uFF0C\u5DF2\u505C\u6B62\u65B0\u589E\u5206\u4EAB\u3002\u8BF7\u5148\u5BFC\u51FA\u53EF\u7528\u7ED3\u679C\u3002", "PERSISTENCE_FAILED", true);
    }
  }
});
var commandTail = Promise.resolve();
function command(operation) {
  const result = commandTail.then(operation, operation);
  commandTail = result.catch(() => void 0);
  return result;
}
async function allTasks() {
  const values = await chrome.storage.local.get(null);
  return Object.entries(values).filter(([key]) => key.startsWith("task:")).map(([, value]) => value).sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
}
async function page(tabId, action, fields = {}) {
  const response = await chrome.tabs.sendMessage(tabId, request(action, fields));
  if (!response?.ok) {
    if (response && !response.ok) throw new FlowError(response.error.message, response.error.code, response.error.uncertain, response.error.relatedUrls);
    throw new FlowError("\u5FAE\u4E91\u9875\u9762\u672A\u54CD\u5E94\uFF0C\u8BF7\u5237\u65B0\u540E\u91CD\u65B0\u8FDE\u63A5\u3002", "PAGE_NOT_CONNECTED");
  }
  return response.data;
}
async function attach(tabId) {
  const tab = await chrome.tabs.get(tabId);
  parseFolderUrl(tab.url ?? "");
  try {
    return await page(tabId, "CONTEXT");
  } catch (error) {
    if (error instanceof FlowError) throw error;
    try {
      await chrome.scripting.executeScript({ target: { tabId }, files: ["content.js"], world: "ISOLATED" });
    } catch {
      throw new FlowError("\u672A\u83B7\u5F97\u5F53\u524D\u5FAE\u4E91 tab \u7684\u8BBF\u95EE\u6743\u9650\u3002\u8BF7\u5728\u8BE5 tab \u70B9\u51FB\u5DE5\u5177\u680F\u4E2D\u7684\u63D2\u4EF6\u56FE\u6807\u3002", "ACTIVATION_REQUIRED");
    }
    return page(tabId, "CONTEXT");
  }
}
async function targetTabId() {
  const target = (await chrome.storage.session.get("targetTabId")).targetTabId;
  if (typeof target === "number") {
    try {
      await chrome.tabs.get(target);
      return target;
    } catch {
    }
  }
  const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
  if (tabs[0]?.id === void 0) throw new FlowError("\u8BF7\u5148\u6253\u5F00\u5FAE\u4E91\u6587\u4EF6\u5939\u5E76\u70B9\u51FB\u63D2\u4EF6\u56FE\u6807\u3002", "NO_TARGET");
  return tabs[0].id;
}
async function folderTasks(context) {
  const tasks = (await allTasks()).filter((task) => sameFolder(task.context, context));
  for (let index = 0; index < tasks.length; index++) {
    const task = tasks[index];
    if (!isActive(task)) continue;
    const status = await page(task.tabId, "STATUS").catch(() => null);
    if (!status?.busy || status.runId !== task.runId) {
      tasks[index] = await store.modify(task.id, (value) => {
        if (!isActive(value)) return value;
        return {
          ...value,
          status: "interrupted",
          revision: value.revision + 1,
          updatedAt: (/* @__PURE__ */ new Date()).toISOString(),
          message: "\u539F\u6267\u884C\u5668\u672A\u8FD0\u884C\u6216\u5DF2\u5931\u8054\uFF0C\u8FDB\u5EA6\u5DF2\u4FDD\u5B58\u3002\u53EF\u7EE7\u7EED\u4EFB\u52A1\uFF1B\u4E0D\u786E\u5B9A\u9879\u76EE\u5C06\u91CD\u65B0\u5206\u4EAB\u3002"
        };
      });
    }
  }
  return tasks;
}
async function ensureIdle(task) {
  try {
    const status = await page(task.tabId, "STATUS");
    if (status.busy) throw new FlowError("\u539F\u6267\u884C\u5668\u4ECD\u5728\u8FD0\u884C\uFF0C\u8BF7\u5148\u6682\u505C\u5E76\u7B49\u5F85\u5F53\u524D\u9879\u76EE\u4FDD\u5B58\u5B8C\u6210\u3002", "RUNNER_BUSY");
  } catch (error) {
    if (error instanceof FlowError && error.code === "RUNNER_BUSY") throw error;
    const tab = await chrome.tabs.get(task.tabId).catch(() => null);
    if (tab) {
      const context = await attach(task.tabId).catch(() => null);
      if (!context || task.context.documentNonce === context.documentNonce) {
        throw new FlowError("\u539F\u9875\u9762\u6267\u884C\u5668\u72B6\u6001\u65E0\u6CD5\u786E\u8BA4\uFF0C\u8BF7\u5237\u65B0\u6216\u5173\u95ED\u539F tab \u540E\u518D\u6062\u590D\u3002", "RUNNER_UNCONFIRMED");
      }
    }
  }
}
async function startRunner(task) {
  try {
    await page(task.tabId, "RUN", { task });
  } catch (error) {
    const flow = asFlowError(error);
    await store.modify(task.id, (value) => ({
      ...value,
      status: "interrupted",
      message: flow.message,
      error: errorInfo(flow),
      updatedAt: (/* @__PURE__ */ new Date()).toISOString(),
      revision: value.revision + 1
    }));
    throw flow;
  }
  return task;
}
async function exportTask(task, mode = "results", automatic = false) {
  const backup = mode === "backup";
  const statusKey = mode === "log" ? "logExportStatus" : "exportStatus";
  const idKey = mode === "log" ? "logDownloadId" : "downloadId";
  const autoKey = mode === "log" ? "autoLogExportRunId" : "autoExportRunId";
  task = await getTask(task.id);
  if (automatic && task[autoKey] === task.runId) return task[idKey] ?? -1;
  if (!backup) await store.modify(task.id, (value) => ({
    ...value,
    [statusKey]: "requested",
    ...automatic ? { [autoKey]: task.runId } : {}
  }));
  try {
    const contents = backup ? JSON.stringify(task, null, 2) : mode === "log" ? exportLog(task) : exportTxt(task);
    const downloadId = await chrome.downloads.download({
      url: dataUrl(contents, backup ? "application/json" : "text/plain"),
      filename: exportFilename(task, backup ? "json" : "txt", mode),
      conflictAction: "uniquify",
      saveAs: false
    });
    if (!backup) {
      await store.modify(task.id, (value) => ({ ...value, [statusKey]: "requested", [idKey]: downloadId }));
      const entry = (await chrome.downloads.search({ id: downloadId }))[0];
      if (entry?.state === "complete" || entry?.state === "interrupted") {
        await store.modify(task.id, (value) => ({ ...value, [statusKey]: entry.state === "complete" ? "downloaded" : "failed" }));
      }
    }
    return downloadId;
  } catch {
    if (!backup) await store.modify(task.id, (value) => ({ ...value, [statusKey]: "failed", message: "\u7ED3\u679C\u5DF2\u4FDD\u5B58\uFF0C\u4E0B\u8F7D\u672A\u5B8C\u6210\uFF0C\u53EF\u91CD\u65B0\u5BFC\u51FA\u7ED3\u679C\u6216\u65E5\u5FD7\u3002" }));
    throw new FlowError("\u4E0B\u8F7D\u672A\u5B8C\u6210\uFF0C\u7ED3\u679C\u4ECD\u5DF2\u4FDD\u5B58\u3002\u8BF7\u91CD\u65B0\u70B9\u51FB\u5BFC\u51FA\u3002", "EXPORT_FAILED");
  }
}
async function automaticExports(taskId) {
  const task = await getTask(taskId);
  if (!["completed", "finished_with_errors"].includes(task.status)) return [];
  const downloads = [];
  let failure = null;
  for (const mode of ["results", "log"]) {
    try {
      downloads.push(await exportTask(task, mode, true));
    } catch (error) {
      failure = error;
    }
  }
  if (failure) throw failure;
  return downloads;
}
async function connectedTasks(context) {
  const tasks = await folderTasks(context);
  const latest = tasks[0];
  if (latest && ["completed", "finished_with_errors"].includes(latest.status) && (latest.autoExportRunId !== latest.runId || latest.autoLogExportRunId !== latest.runId)) {
    await command(() => automaticExports(latest.id)).catch(() => void 0);
    tasks[0] = await getTask(latest.id);
  }
  return tasks;
}
async function getTask(id) {
  if (typeof id !== "string") throw new FlowError("\u7F3A\u5C11\u4EFB\u52A1\u6807\u8BC6\u3002", "INVALID_TASK");
  const task = await store.get(id);
  if (!task) throw new FlowError("\u627E\u4E0D\u5230\u4FDD\u5B58\u7684\u4EFB\u52A1\u3002", "TASK_NOT_FOUND");
  return task;
}
async function panelCommand(raw) {
  if (raw.action === "CONNECT") {
    const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
    const id = tabs[0]?.id;
    if (id === void 0) throw new FlowError("\u672A\u627E\u5230\u5F53\u524D tab\u3002", "NO_TARGET");
    const context = await attach(id);
    await chrome.storage.session.set({ targetTabId: id });
    return { context, tabId: id, tasks: await connectedTasks(context) };
  }
  if (raw.action === "BOOT") {
    const id = await targetTabId();
    const context = await attach(id);
    return { context, tabId: id, tasks: await connectedTasks(context) };
  }
  if (raw.action === "LOAD") return getTask(raw.taskId);
  if (raw.action === "FOCUS") {
    const id = await targetTabId();
    await chrome.tabs.update(id, { active: true });
    return null;
  }
  if (raw.action === "DIAGNOSTICS") {
    const id = await targetTabId();
    await attach(id);
    const diagnosis = await page(id, "DIAGNOSE");
    return chrome.downloads.download({
      url: dataUrl(JSON.stringify(diagnosis, null, 2), "application/json"),
      filename: "\u5FAE\u4E91_\u9875\u9762\u8BCA\u65AD.json",
      conflictAction: "uniquify",
      saveAs: false
    });
  }
  if (["START", "IMPORT"].includes(raw.action)) {
    const tabId = await targetTabId();
    const context = await attach(tabId);
    const tasks = await allTasks();
    const existing = tasks.find((task3) => sameFolder(task3.context, context));
    for (const task3 of tasks.filter((entry) => isActive(entry))) {
      const status = await page(task3.tabId, "STATUS").catch(() => null);
      if (status?.busy) {
        if (existing?.id === task3.id) return { task: task3, existing: true };
        throw new FlowError("\u5DF2\u6709\u76EE\u5F55\u4EFB\u52A1\u6B63\u5728\u6267\u884C\uFF0C\u8BF7\u5148\u6682\u505C\u3002", "RUNNER_BUSY");
      }
    }
    if (existing && raw.newTask !== true && raw.action !== "IMPORT") return { task: existing, existing: true };
    if (existing && !["completed", "finished_with_errors", "error"].includes(existing.status)) {
      if (raw.action === "IMPORT") throw new FlowError("\u8BE5\u76EE\u5F55\u5DF2\u6709\u672A\u5B8C\u6210\u4EFB\u52A1\uFF0C\u8BF7\u5148\u6062\u590D\u6216\u5BFC\u51FA\u5E76\u5220\u9664\u65E7\u4EFB\u52A1\uFF0C\u518D\u5BFC\u5165\u3002", "EXISTING_TASK");
      if (raw.newTask === true) throw new FlowError("\u8BE5\u76EE\u5F55\u6709\u672A\u5B8C\u6210\u4EFB\u52A1\uFF0C\u8BF7\u5148\u7EE7\u7EED\u539F\u4EFB\u52A1\u3002", "EXISTING_TASK");
    }
    const task2 = createTask(context, tabId, crypto.randomUUID(), crypto.randomUUID());
    if (raw.action === "IMPORT") {
      if (typeof raw.contents !== "string") throw new FlowError("\u672A\u8BFB\u53D6\u5230\u8FDB\u5EA6\u6587\u4EF6\u3002", "INVALID_IMPORT");
      task2.importedCandidates = parseImport(raw.contents, context);
    }
    await store.saveNew(task2);
    return { task: await startRunner(task2), existing: false };
  }
  const task = await getTask(raw.taskId);
  if (raw.action === "PAUSE") return store.event(task.id, task.runId, { type: "pause" });
  if (raw.action === "EXPORT") return exportTask(task);
  if (raw.action === "EXPORT_LOG") return exportTask(task, "log");
  if (raw.action === "BACKUP") return exportTask(task, "backup");
  if (raw.action === "DELETE") {
    await ensureIdle(task);
    if (isActive(task)) throw new FlowError("\u8BF7\u5148\u6682\u505C\u4EFB\u52A1\u3002", "RUNNER_BUSY");
    await chrome.storage.local.remove(`task:${task.id}`);
    return null;
  }
  if (raw.action === "RESUME") {
    await ensureIdle(task);
    const tabId = await targetTabId();
    const context = await attach(tabId);
    assertContext(task.context, context);
    let recoverable = task;
    if (raw.acknowledged === true && task.context.account === null) {
      recoverable = { ...task, context: { ...task.context, documentNonce: context.documentNonce } };
    }
    const latestContext = await page(tabId, "CONTEXT");
    assertContext(context, latestContext);
    if (latestContext.documentNonce !== context.documentNonce) throw new FlowError("\u6062\u590D\u671F\u95F4\u9875\u9762\u5DF2\u5237\u65B0\uFF0C\u8BF7\u91CD\u65B0\u8BFB\u53D6\u540E\u7EE7\u7EED\u3002", "STALE_DOCUMENT");
    const resumed = resumeTask(recoverable, context, tabId, crypto.randomUUID(), raw.retryFailed === true);
    await store.modify(task.id, (current) => {
      if (current.revision !== task.revision) throw new FlowError("\u4EFB\u52A1\u72B6\u6001\u5DF2\u66F4\u65B0\uFF0C\u8BF7\u91CD\u65B0\u8BFB\u53D6\u3002", "REVISION_CONFLICT");
      return resumed;
    });
    return startRunner(resumed);
  }
  throw new FlowError("\u4E0D\u652F\u6301\u7684\u547D\u4EE4\u3002", "UNKNOWN_COMMAND");
}
async function runnerCommand(raw, sender) {
  const task = await getTask(raw.taskId);
  if (sender.tab?.id !== task.tabId || raw.runId !== task.runId || raw.documentNonce !== task.context.documentNonce) throw new FlowError("\u6267\u884C\u5668\u6216\u9875\u9762\u5DF2\u53D8\u5316\uFF0C\u7981\u6B62\u7EE7\u7EED\u5199\u5165\u3002", "STALE_RUN", true);
  if (raw.action === "GET_TASK") return task;
  if (raw.action === "COMMIT") {
    const event = raw.event;
    if (!event || typeof event.type !== "string" || ![
      "scan_progress",
      "scan_done",
      "phase",
      "item_done",
      "related_share",
      "restart",
      "item_error",
      "paused",
      "task_error",
      "finish"
    ].includes(event.type)) throw new FlowError("\u975E\u6CD5\u72B6\u6001\u547D\u4EE4\u3002", "INVALID_EVENT");
    const saved = await store.event(task.id, task.runId, event);
    if (event.type === "finish") {
      void command(() => automaticExports(saved.id)).catch(() => void 0);
    }
    return saved;
  }
  if (raw.action === "AUTO_EXPORT") {
    if (!["completed", "finished_with_errors"].includes(task.status)) throw new FlowError("\u4EFB\u52A1\u5C1A\u672A\u7ED3\u675F\u3002", "UNFINISHED_TASK");
    return automaticExports(task.id);
  }
  throw new FlowError("\u4E0D\u652F\u6301\u7684\u6267\u884C\u5668\u547D\u4EE4\u3002", "UNKNOWN_COMMAND");
}
chrome.runtime.onMessage.addListener((raw, sender, sendResponse) => {
  if (!isRequest(raw) || sender.id !== chrome.runtime.id) return false;
  const panel = sender.url === chrome.runtime.getURL("panel.html");
  const runner = !!sender.tab && ["GET_TASK", "COMMIT", "AUTO_EXPORT"].includes(raw.action);
  if (!panel && !runner) return false;
  void ready.then(
    () => panel ? ["START", "IMPORT", "RESUME", "DELETE", "EXPORT", "EXPORT_LOG", "BACKUP"].includes(raw.action) ? command(() => panelCommand(raw)) : panelCommand(raw) : raw.action === "AUTO_EXPORT" ? command(() => runnerCommand(raw, sender)) : runnerCommand(raw, sender)
  ).then((data) => sendResponse({ ok: true, data }), (error) => {
    const flow = asFlowError(error);
    sendResponse({ ok: false, error: { message: flow.message, code: flow.code, uncertain: flow.uncertain, relatedUrls: flow.relatedUrls } });
  });
  return true;
});
chrome.action.onClicked.addListener((tab) => {
  if (tab.id === void 0) return;
  void chrome.sidePanel.open({ windowId: tab.windowId }).catch(() => void 0);
  void chrome.storage.session.set({ targetTabId: tab.id });
});
chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
  if (changeInfo.status === "complete") {
    void chrome.storage.session.get("targetTabId").then((value) => {
      if (value.targetTabId === tabId) return chrome.storage.session.set({ targetDocumentVersion: crypto.randomUUID() });
    }).catch(() => void 0);
  }
  if (changeInfo.status !== "loading" && !changeInfo.url) return;
  void ready.then(allTasks).then(async (tasks) => {
    for (const task of tasks.filter((entry) => entry.tabId === tabId && isActive(entry))) {
      await store.modify(task.id, (value) => ({
        ...value,
        status: "interrupted",
        message: "\u76EE\u6807\u9875\u9762\u5DF2\u5237\u65B0\u6216\u5BFC\u822A\u3002\u56DE\u5230\u539F\u76EE\u5F55\u540E\u53EF\u7EE7\u7EED\uFF1B\u672A\u5B8C\u6210\u9879\u76EE\u5C06\u91CD\u65B0\u5206\u4EAB\u3002",
        revision: value.revision + 1,
        updatedAt: (/* @__PURE__ */ new Date()).toISOString()
      }));
    }
  }).catch(() => void 0);
});
chrome.tabs.onRemoved.addListener((tabId) => {
  void ready.then(allTasks).then(async (tasks) => {
    for (const task of tasks.filter((entry) => entry.tabId === tabId && isActive(entry))) {
      await store.modify(task.id, (value) => ({
        ...value,
        status: "interrupted",
        message: "\u76EE\u6807 tab \u5DF2\u5173\u95ED\uFF0C\u8FDB\u5EA6\u5DF2\u4FDD\u7559\u3002\u91CD\u65B0\u6253\u5F00\u539F\u76EE\u5F55\u540E\u53EF\u6062\u590D\u3002",
        revision: value.revision + 1,
        updatedAt: (/* @__PURE__ */ new Date()).toISOString()
      }));
    }
  }).catch(() => void 0);
});
chrome.downloads.onChanged.addListener((delta) => {
  const state = delta.state?.current;
  if (state !== "complete" && state !== "interrupted") return;
  void ready.then(allTasks).then(async (tasks) => {
    const task = tasks.find((entry) => entry.downloadId === delta.id || entry.logDownloadId === delta.id);
    if (!task) return;
    await store.modify(task.id, (value) => ({
      ...value,
      [value.logDownloadId === delta.id ? "logExportStatus" : "exportStatus"]: state === "complete" ? "downloaded" : "failed"
    }));
  }).catch(() => void 0);
});

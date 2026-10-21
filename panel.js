// src/model.ts
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
function isActive(task) {
  return ACTIVE_STATES.includes(task.status);
}
var collator = new Intl.Collator("zh-CN", { numeric: true, sensitivity: "variant" });
function taskCounts(task) {
  const done = task.items.filter((item) => item.status === "done").length;
  const failed = task.items.filter((item) => item.status === "failed").length;
  const review = task.items.filter((item) => item.status === "needs_review").length;
  return { done, failed, review, pending: task.items.length - done - failed - review };
}

// src/protocol.ts
function request(action, fields = {}) {
  return { ...fields, channel: CHANNEL, action };
}
async function rpc(action, fields = {}) {
  let response;
  try {
    response = await chrome.runtime.sendMessage(request(action, fields));
  } catch {
    throw new FlowError("\u63D2\u4EF6\u8FDE\u63A5\u5DF2\u4E2D\u65AD\u3002\u8BF7\u91CD\u65B0\u70B9\u51FB\u63D2\u4EF6\u56FE\u6807\uFF0C\u8BFB\u53D6\u4FDD\u5B58\u8FDB\u5EA6\u3002", "CONNECTION_LOST", true);
  }
  if (!response) throw new FlowError("\u63D2\u4EF6\u540E\u53F0\u672A\u54CD\u5E94\uFF0C\u8BF7\u91CD\u65B0\u6253\u5F00\u9762\u677F\u3002", "CONNECTION_LOST", true);
  if (!response.ok) {
    const error = response.error;
    throw new FlowError(error.message, error.code, error.uncertain, error.relatedUrls);
  }
  return response.data;
}

// src/panel.ts
var connection = null;
var current = null;
var busy = false;
function element(id) {
  const node = document.getElementById(id);
  if (!node) throw new Error(`Missing panel element: ${id}`);
  return node;
}
var labels = {
  scanning: "\u8BFB\u53D6\u76EE\u5F55",
  running: "\u6B63\u5728\u5206\u4EAB",
  pausing: "\u51C6\u5907\u6682\u505C",
  paused: "\u5DF2\u6682\u505C",
  interrupted: "\u5DF2\u4E2D\u65AD",
  needs_review: "\u9700\u8981\u6838\u5BF9",
  completed: "\u5168\u90E8\u5B8C\u6210",
  finished_with_errors: "\u90E8\u5206\u5931\u8D25",
  error: "\u5DF2\u505C\u6B62"
};
var itemLabels = {
  pending: "\u5F85\u5904\u7406",
  opening_share: "\u751F\u6210\u94FE\u63A5",
  link_observed: "\u5DF2\u8BFB\u53D6\u94FE\u63A5",
  securing: "\u6DFB\u52A0\u5BC6\u7801",
  verifying: "\u9A8C\u8BC1\u4FDD\u5B58",
  done: "\u5DF2\u5B8C\u6210",
  failed: "\u5931\u8D25",
  needs_review: "\u9700\u6838\u5BF9"
};
function notice(message, error = false) {
  const node = element("notice");
  node.hidden = !message;
  node.textContent = message;
  node.classList.toggle("error", error);
}
function renderTasks() {
  const select = element("task-select");
  const tasks = connection?.tasks ?? [];
  select.replaceChildren();
  if (!tasks.length) {
    const option = document.createElement("option");
    option.value = "";
    option.textContent = "\u6682\u65E0\u4EFB\u52A1";
    select.append(option);
  }
  for (const task of tasks) {
    const option = document.createElement("option");
    option.value = task.id;
    option.textContent = `${new Date(task.createdAt).toLocaleString("zh-CN")} \xB7 ${labels[task.status]} \xB7 ${task.items.length} \u9879`;
    select.append(option);
  }
  if (current) select.value = current.id;
}
function setCurrent(task) {
  current = task;
  if (task && connection) {
    const index = connection.tasks.findIndex((entry) => entry.id === task.id);
    if (index < 0) connection.tasks.unshift(task);
    else connection.tasks[index] = task;
  }
  renderTasks();
  render();
}
function render() {
  element("folder-name").textContent = connection?.context.folderName ?? "\u7B49\u5F85\u8FDE\u63A5\u5FAE\u4E91";
  element("folder-meta").textContent = connection ? `${connection.context.expectedCount === null ? "\u76EE\u5F55\u9879\u6570\u5F85\u8BC6\u522B" : `\u9875\u9762\u663E\u793A ${connection.context.expectedCount} \u9879`} \xB7 ${connection.context.account ? "\u5DF2\u8BC6\u522B\u8D26\u53F7" : "\u672A\u8BFB\u53D6\u5230\u8D26\u53F7\u6807\u8BC6"}` : "\u8FDB\u5165\u5FAE\u4E91\u6587\u4EF6\u5939\uFF0C\u70B9\u51FB\u6D4F\u89C8\u5668\u5DE5\u5177\u680F\u4E2D\u7684\u63D2\u4EF6\u56FE\u6807\u3002";
  const active = !!current && isActive(current);
  const counts = current ? taskCounts(current) : { done: 0, failed: 0, review: 0, pending: 0 };
  element("count-done").textContent = String(counts.done);
  element("count-total").textContent = String(current?.expectedCount ?? connection?.context.expectedCount ?? "\u2014");
  element("count-issues").textContent = String(counts.failed + counts.review);
  const status = element("status");
  status.textContent = current ? labels[current.status] : "\u5C31\u7EEA";
  status.classList.toggle("issue", !!current && ["needs_review", "error", "interrupted", "finished_with_errors"].includes(current.status));
  element("progress").value = current?.items.length ? counts.done / current.items.length * 100 : 0;
  element("task-message").textContent = current?.status === "completed" && current.exportStatus === "downloaded" ? "\u5168\u90E8\u5B8C\u6210\uFF0CTXT \u5DF2\u4E0B\u8F7D\u3002" : current?.message ?? "\u5B8C\u6574\u8BFB\u53D6\u6E05\u5355\u540E\uFF0C\u81EA\u52A8\u9010\u9879\u6DFB\u52A0\u5BC6\u7801\u5E76\u4FDD\u5B58\u7ED3\u679C\u3002";
  const start2 = element("start");
  start2.hidden = !!current;
  start2.disabled = busy || !connection;
  element("run-controls").hidden = !current;
  element("pause").disabled = busy || !active || current?.status === "pausing";
  const unresolved = current?.items.some((item) => ["needs_review", "opening_share"].includes(item.status));
  element("resume").disabled = busy || !current || active || current.status === "completed" || !!unresolved;
  element("retry").disabled = busy || !current || active || counts.failed === 0 || counts.review > 0;
  element("export-controls").hidden = !current;
  element("export").disabled = busy || !current;
  element("backup").disabled = busy || !current;
  element("connect").disabled = busy;
  element("import").disabled = busy || active;
  element("diagnose").disabled = busy || !connection || active;
  element("new-task").hidden = !current || !["completed", "finished_with_errors", "error"].includes(current.status);
  element("new-task").disabled = busy;
  element("delete").hidden = !current;
  element("delete").disabled = busy || active;
  const downloadLabels = {
    none: "",
    requested: "\u5DF2\u53D1\u8D77\u4E0B\u8F7D\uFF0C\u8BF7\u67E5\u770B Chrome \u4E0B\u8F7D\u5217\u8868\u3002",
    downloaded: "TXT \u5DF2\u4E0B\u8F7D\u3002",
    failed: "\u4E0B\u8F7D\u672A\u5B8C\u6210\uFF0C\u7ED3\u679C\u5DF2\u4FDD\u5B58\uFF0C\u53EF\u91CD\u65B0\u5BFC\u51FA\u3002"
  };
  element("download-state").textContent = current ? downloadLabels[current.exportStatus] : "";
  const reviewItem = current?.items.find((item) => item.status === "needs_review" || item.status === "opening_share");
  const accountAck = current && connection && !current.context.account && current.context.documentNonce !== connection.context.documentNonce;
  const showReview = !active && (!!reviewItem || !!accountAck);
  element("review").hidden = !showReview;
  element("review-heading").textContent = reviewItem ? `\u5148\u6838\u5BF9\uFF1A${reviewItem.name}` : "\u786E\u8BA4\u539F\u8D26\u53F7\u540E\u6062\u590D";
  element("review-message").textContent = reviewItem ? reviewItem.error?.message ?? "\u4E0A\u6B21\u64CD\u4F5C\u53EF\u80FD\u5DF2\u7ECF\u751F\u6210\u94FE\u63A5\uFF0C\u8BF7\u6253\u5F00\u5BF9\u5E94\u9879\u76EE\u7684\u5206\u4EAB\u5F39\u7A97\u6838\u5BF9\u3002" : "\u9875\u9762\u91CD\u65B0\u6253\u5F00\u540E\u65E0\u6CD5\u81EA\u52A8\u8BC6\u522B\u539F\u8D26\u53F7\uFF0C\u8BF7\u786E\u8BA4\u5F53\u524D\u767B\u5F55\u8D26\u53F7\u4E0E\u539F\u4EFB\u52A1\u4E00\u81F4\u3002";
  element("review-ack-label").textContent = reviewItem ? "\u6211\u5DF2\u786E\u8BA4\u5F53\u524D\u4E3A\u539F\u8D26\u53F7\uFF0C\u5E76\u5DF2\u5904\u7406\u8BE5\u9879\u53CA\u76F8\u5173\u94FE\u63A5\u3002" : "\u6211\u5DF2\u786E\u8BA4\u5F53\u524D\u767B\u5F55\u7684\u662F\u8BE5\u4EFB\u52A1\u539F\u6765\u7684\u5FAE\u4E91\u8D26\u53F7\u3002";
  const reconcile = element("reconcile");
  reconcile.textContent = reviewItem ? "\u91C7\u7528\u5F53\u524D\u5F39\u7A97\u94FE\u63A5\u5E76\u7EE7\u7EED" : "\u6838\u5BF9\u8D26\u53F7\u5E76\u6062\u590D";
  reconcile.disabled = busy || !element("review-ack").checked;
  element("review-links").replaceChildren();
  const links = new Set([reviewItem?.observedUrl, ...reviewItem?.relatedShares ?? [], ...reviewItem?.error?.relatedUrls ?? []].filter((url) => !!url));
  for (const url of links) {
    const item = document.createElement("li");
    const link = document.createElement("a");
    link.textContent = url;
    link.href = url;
    link.target = "_blank";
    link.rel = "noopener noreferrer";
    item.append(link);
    element("review-links").append(item);
  }
  element("results-section").hidden = !current?.items.length;
  element("list-count").textContent = current ? `${current.items.length} \u9879` : "";
  const list = element("item-list");
  const scrollTop = list.scrollTop;
  list.replaceChildren();
  for (const item of current?.items ?? []) {
    const row = document.createElement("li");
    row.className = item.status;
    row.title = item.error?.message ?? item.name;
    const ordinal = document.createElement("span");
    ordinal.className = "ordinal";
    ordinal.textContent = String(item.ordinal).padStart(2, "0");
    const name = document.createElement("span");
    name.className = "item-name";
    name.textContent = item.name;
    const state = document.createElement("span");
    state.className = "item-state";
    state.textContent = itemLabels[item.status] ?? item.status;
    row.append(ordinal, name, state);
    list.append(row);
  }
  list.scrollTop = scrollTop;
}
async function act(operation) {
  if (busy) return;
  busy = true;
  notice("");
  render();
  try {
    await operation();
  } catch (error) {
    notice(asFlowError(error).message, true);
  } finally {
    busy = false;
    render();
  }
}
async function connect(action = "CONNECT") {
  connection = await rpc(action);
  setCurrent(connection.tasks[0] ?? null);
}
async function start(newTask = false) {
  const response = await rpc("START", { newTask });
  setCurrent(response.task);
  if (response.existing) notice("\u5DF2\u8BFB\u53D6\u6B64\u76EE\u5F55\u7684\u73B0\u6709\u4EFB\u52A1\uFF0C\u53EF\u7EE7\u7EED\u4EFB\u52A1\u6216\u5BFC\u51FA\u7ED3\u679C\u3002");
}
function on(id, operation) {
  element(id).addEventListener("click", () => {
    void act(operation);
  });
}
on("connect", () => connect());
on("start", () => start());
on("new-task", () => start(true));
on("pause", async () => {
  setCurrent(await rpc("PAUSE", { taskId: current?.id }));
});
on("resume", async () => {
  setCurrent(await rpc("RESUME", { taskId: current?.id }));
});
on("retry", async () => {
  setCurrent(await rpc("RESUME", { taskId: current?.id, retryFailed: true }));
});
on("export", async () => {
  await rpc("EXPORT", { taskId: current?.id });
  notice("\u5DF2\u53D1\u8D77 TXT \u4E0B\u8F7D\u3002");
});
on("backup", async () => {
  await rpc("BACKUP", { taskId: current?.id });
  notice("\u5DF2\u53D1\u8D77\u8FDB\u5EA6\u5907\u4EFD\u4E0B\u8F7D\u3002\u5907\u4EFD\u542B\u5206\u4EAB\u94FE\u63A5\u548C\u5BC6\u7801\uFF0C\u8BF7\u59A5\u5584\u4FDD\u7BA1\u3002");
});
on("diagnose", async () => {
  await rpc("DIAGNOSTICS");
  notice("\u5DF2\u5BFC\u51FA\u9875\u9762\u7ED3\u6784\u8BCA\u65AD\uFF0C\u4E0D\u5305\u542B\u6587\u4EF6\u540D\u3001\u5BC6\u7801\u6216\u767B\u5F55 token\u3002");
});
on("focus", async () => {
  await rpc("FOCUS");
});
on("reconcile", async () => {
  const hasReview = current?.items.some((item) => item.status === "needs_review" || item.status === "opening_share");
  setCurrent(await rpc(hasReview ? "RECONCILE" : "RESUME", { taskId: current?.id, acknowledged: true }));
  element("review-ack").checked = false;
});
on("delete", async () => {
  if (!confirm("\u5220\u9664\u8BE5\u4EFB\u52A1\u7684\u672C\u5730\u8FDB\u5EA6\uFF1F\u8BF7\u5148\u5BFC\u51FA\u9700\u8981\u4FDD\u7559\u7684\u8BB0\u5F55\u3002\u6B64\u64CD\u4F5C\u4E0D\u4F1A\u53D6\u6D88\u5FAE\u4E91\u5206\u4EAB\u3002")) return;
  await rpc("DELETE", { taskId: current?.id });
  await connect("BOOT");
});
element("review-ack").addEventListener("change", render);
element("task-select").addEventListener("change", () => {
  void act(async () => {
    const id = element("task-select").value;
    if (id) setCurrent(await rpc("LOAD", { taskId: id }));
  });
});
element("import").addEventListener("click", () => {
  element("import-file").click();
});
element("import-file").addEventListener("change", (event) => {
  const file = event.target.files?.[0];
  if (!file) return;
  void act(async () => {
    if (file.size > 2e6) throw new Error("\u8FDB\u5EA6\u6587\u4EF6\u8D85\u8FC7 2 MB\u3002");
    const response = await rpc("IMPORT", { contents: await file.text() });
    setCurrent(response.task);
    notice("\u8FDB\u5EA6\u5DF2\u5BFC\u5165\uFF0C\u6B63\u5728\u91CD\u65B0\u6838\u5BF9\u76EE\u5F55\u3002");
  }).finally(() => {
    element("import-file").value = "";
  });
});
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === "session" && changes.targetTabId && !busy) {
    void act(() => connect("BOOT"));
    return;
  }
  if (area !== "local" || !current) return;
  const change = changes[`task:${current.id}`];
  if (change?.newValue) setCurrent(change.newValue);
});
render();
void act(() => connect("BOOT"));

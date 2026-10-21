"use strict";
(() => {
  // src/model.ts
  var CHANNEL = "weiyun-batch-share/v1";
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

  // src/adapter.ts
  var selectors = {
    row: [
      ".mod-list-group-files .list-group > .list-group-item",
      ".file-list .file-item",
      ".file-list .list-item",
      ".file-list li",
      ".mod-file-list .list-item",
      ".mod-file-list li",
      ".file-list-item",
      ".disk-file-list .list-item",
      ".list-view .list-item",
      ".list-view .list-tr",
      ".list-item",
      "[role='row'][data-id]",
      "[data-file-id]",
      "[data-dir-id]",
      "[data-folder-id]"
    ].join(","),
    nearestRow: "[data-file-id],[data-dir-id],[data-folder-id],[data-id],li,[role='row'],.file-item,.list-item,.file-list-item,.list-tr,.list-group-item",
    name: ".mod-list-group-files .item-tit .info .tit,.file-name,.filename,.file_name,.fileName,[data-file-name],[class*='file-name'],[class*='file_name'],[class*='fileName']",
    nameWithinRow: ".item-tit .info .tit,.file-name,.filename,.file_name,.fileName,[data-file-name],[class*='file-name'],.name a,a.name,.name,.item-name,.list-name",
    excluded: "aside,nav,header,[class*='breadcrumb'],[class*='bread-crumb'],.modal-dialog,[role='dialog'],[role='menu'],.context-menu,.contextmenu",
    breadcrumb: [
      ".breadcrumb .current",
      ".breadcrumb .cur",
      ".breadcrumb li:last-child",
      ".mod-breadcrumb .item:last-child",
      ".breadcrumb .item:last-child",
      ".breadcrumb a:last-child",
      "[class*='breadcrumb'] [title]",
      "[class*='bread-crumb'] [title]",
      "[aria-label='\u8DEF\u5F84'] [aria-current]",
      "[class*='breadcrumb'] span",
      "[class*='bread-crumb'] span"
    ],
    menu: ".context-menu,.contextmenu,.mod-context-menu,.mod-contextmenu,[role='menu'],.dropdown-menu,.menu-list,.disk-context-menu,[class*='context-menu'],[class*='contextmenu'],[class*='context_menu']",
    modal: ".modal-dialog-share",
    close: "button[aria-label='\u5173\u95ED\u5F39\u7A97'],[aria-label='\u5173\u95ED\u5F39\u7A97'],button[aria-label='\u5173\u95ED'],.modal-dialog-close,.modal-close,.dialog-close,.btn-close,[title='\u5173\u95ED']",
    total: "[class*='total'],[class*='count'],[class*='footer'],[class*='bottom'],[class*='tips'],[role='status']",
    error: ".toast,.toast-message,.notification,[role='alert'],.error-tip,.error-msg,.mod-login,.captcha,.tcaptcha-transform",
    loading: ".mod-list-group-files .load-more-main .mod-loadmore.load,.file-list-loading,.list-loading,.loading-mask,.mod-loading,[aria-busy='true']",
    next: ".pagination-next,.page-next,[aria-label='\u4E0B\u4E00\u9875'],[title='\u4E0B\u4E00\u9875']",
    previous: ".pagination-prev,.page-prev,[aria-label='\u4E0A\u4E00\u9875'],[title='\u4E0A\u4E00\u9875']"
  };
  function visible(element) {
    if (!(element instanceof HTMLElement)) return false;
    const style = getComputedStyle(element);
    return style.display !== "none" && style.visibility !== "hidden" && element.getClientRects().length > 0 && !element.closest("[hidden],[aria-hidden='true']");
  }
  function text(element) {
    return element?.textContent?.replace(/\s+/g, " ").trim() ?? "";
  }
  function allVisible(selector, root = document) {
    return [...root.querySelectorAll(selector)].filter(visible);
  }
  function exactControl(root, labels) {
    const nodes = allVisible("button,a,[role='button'],[role='menuitem'],li,span,div", root);
    if (root instanceof HTMLElement && visible(root)) nodes.unshift(root);
    const candidates = nodes.filter((element) => labels.includes(text(element)) || labels.includes(element.getAttribute("aria-label") ?? "")).filter((element, _, list) => !list.some((child) => child !== element && element.contains(child)));
    if (candidates.length > 1) {
      const actionable = candidates.filter((element) => element.matches("button,a,[role='button'],[role='menuitem']"));
      if (actionable.length === 1) return actionable[0];
      throw new FlowError(`\u627E\u5230\u591A\u4E2A\u201C${labels[0]}\u201D\u5165\u53E3\uFF0C\u65E0\u6CD5\u5B89\u5168\u9009\u62E9\u3002`, "AMBIGUOUS_CONTROL");
    }
    return candidates[0] ?? null;
  }
  function waitUntil(probe, timeout, message, uncertain = false) {
    return new Promise((resolve, reject) => {
      let settled = false;
      let interval;
      let deadline;
      let observer;
      const cleanup = () => {
        clearInterval(interval);
        clearTimeout(deadline);
        observer?.disconnect();
      };
      const check = () => {
        if (settled) return;
        try {
          const value = probe();
          if (value !== null && value !== void 0 && value !== false) {
            settled = true;
            cleanup();
            resolve(value);
          }
        } catch (error) {
          settled = true;
          cleanup();
          reject(error);
        }
      };
      interval = setInterval(check, 120);
      deadline = setTimeout(() => {
        if (settled) return;
        settled = true;
        cleanup();
        reject(new FlowError(message, "DOM_TIMEOUT", uncertain));
      }, timeout);
      observer = new MutationObserver(check);
      observer.observe(document.documentElement, { childList: true, subtree: true, attributes: true, characterData: true });
      check();
    });
  }
  function settle(quiet = 100, maximum = 650) {
    return new Promise((resolve) => {
      let quietTimer;
      const done = () => {
        clearTimeout(quietTimer);
        clearTimeout(maxTimer);
        observer.disconnect();
        resolve();
      };
      const restart = () => {
        clearTimeout(quietTimer);
        quietTimer = setTimeout(done, quiet);
      };
      const observer = new MutationObserver(restart);
      const maxTimer = setTimeout(done, maximum);
      observer.observe(document.documentElement, { childList: true, subtree: true, characterData: true });
      restart();
    });
  }
  var WeiyunAdapter = class {
    bound = null;
    page = 1;
    documentNonce = crypto.randomUUID();
    bind(context) {
      this.bound = context;
    }
    context() {
      const route = parseFolderUrl(location.href);
      let folderName = route.folderId === "root" ? "\u5168\u90E8\u6587\u4EF6" : "";
      for (const selector of selectors.breadcrumb) {
        const values = allVisible(selector).map((node) => (node.getAttribute("title") || text(node)).trim()).filter((value) => value && !["\u5168\u90E8\u6587\u4EF6", ">", "/", "\u2026", "..."].includes(value));
        if (values.length) {
          folderName = values.at(-1);
          break;
        }
      }
      const currentLinks = allVisible(`a[href='${location.pathname}'],a[href='${route.folderUrl}']`).filter((node) => !node.closest(selectors.row));
      if (!folderName && currentLinks.length === 1) folderName = currentLinks[0].getAttribute("title") || text(currentLinks[0]);
      const user = allVisible(".user-info[data-uin],.user-info [data-uin],.mod-user[data-uin],.mod-user [data-uin]").find((node) => !node.closest(".modal-dialog"));
      const uin = user?.getAttribute("data-uin") ?? "";
      const account = /^\d{5,20}$/.test(uin) ? `uin:${uin}` : null;
      return {
        ...route,
        folderName: folderName || `\u5F53\u524D\u76EE\u5F55_${route.folderId.slice(0, 8)}`,
        account: account || null,
        documentNonce: this.documentNonce,
        expectedCount: this.total()
      };
    }
    guard() {
      if (this.bound) assertContext(this.bound, this.context());
      else parseFolderUrl(location.href);
    }
    checkPage() {
      this.guard();
      for (const element of allVisible(selectors.error)) {
        const message = text(element).slice(0, 350);
        if (/验证码|安全验证|操作频繁|频繁操作|稍后再试|登录失效|重新登录|登录已过期|分享失败|服务异常|请求失败/.test(message)) {
          throw new FlowError(`\u5FAE\u4E91\u63D0\u793A\uFF1A${message}`, "SITE_BLOCKED", true);
        }
      }
      if (allVisible("iframe").some((node) => /captcha|tcaptcha/i.test(node.getAttribute("src") ?? ""))) {
        throw new FlowError("\u5FAE\u4E91\u8981\u6C42\u9A8C\u8BC1\uFF0C\u8BF7\u5728\u9875\u9762\u4E2D\u5B8C\u6210\u540E\u6838\u5BF9\u5E76\u7EE7\u7EED\u3002", "CAPTCHA", true);
      }
    }
    total() {
      const candidates = allVisible(selectors.total).filter((node) => !node.closest(".modal-dialog,aside,nav")).map((node) => text(node));
      candidates.push(document.body.innerText);
      const counts = /* @__PURE__ */ new Set();
      for (const value of candidates) {
        for (const match of value.matchAll(/(?:共(?:有|计)?|总计|总共)\s*([\d,，]+)\s*(?:项|个(?:文件|项目|文件夹)?)/g)) {
          const count = Number(match[1].replace(/[,，]/g, ""));
          if (Number.isSafeInteger(count) && count >= 0 && count <= 1e4) counts.add(count);
        }
      }
      return counts.size === 1 ? [...counts][0] : null;
    }
    rows() {
      const rows = new Set(allVisible(selectors.row).filter((node) => !node.closest(selectors.excluded)));
      for (const name of allVisible(selectors.name)) {
        if (name.closest(selectors.excluded)) continue;
        let row = name.closest(selectors.nearestRow);
        if (!row) {
          let parent = name.parentElement;
          for (let depth = 0; parent && depth < 4; depth++, parent = parent.parentElement) {
            if (parent.parentElement && parent.className && [...parent.parentElement.children].some(
              (sibling) => sibling !== parent && sibling.className === parent.className
            )) {
              row = parent;
              break;
            }
          }
        }
        if (visible(row) && !row.closest(selectors.excluded)) rows.add(row);
      }
      return [...rows].filter((node, _, list) => !list.some((child) => child !== node && node.contains(child)));
    }
    readRows() {
      const context = this.context();
      const records = [];
      for (const row of this.rows()) {
        const nameNode = row.matches(selectors.name) ? row : row.querySelector(selectors.nameWithinRow) ?? row.querySelector("a[title]");
        const name = (nameNode?.getAttribute("data-file-name") || nameNode?.getAttribute("title") || text(nameNode)).trim();
        if (!name || name.length > 1024) continue;
        const anchor = row.querySelector("a[href*='/disk/folder/']") ?? (nameNode instanceof HTMLAnchorElement ? nameNode : nameNode?.querySelector("a"));
        let folderHref = null;
        if (anchor) {
          try {
            folderHref = new URL(anchor.getAttribute("href") ?? "", location.href).pathname.match(/^\/disk\/folder\/([A-Za-z0-9_-]+)\/?$/);
          } catch {
          }
        }
        const isFolder = !!folderHref || /^(folder|dir|directory)$/i.test(row.getAttribute("data-type") ?? "") || !!row.querySelector(".icon-folder,[class*='icon-folder'],[class*='folder-icon'],[data-type='folder'],.thumb > .icon-file-m") || /(?:^|[\s_-])(folder|directory)(?:$|[\s_-])/i.test(row.className);
        const kind = isFolder ? "folder" : row.querySelector("[class*='icon-file'],[class*='file-icon']") ? "file" : "unknown";
        let siteId = folderHref?.[1] ? `folder:${folderHref[1]}` : null;
        for (const attr of ["data-file-id", "data-dir-id", "data-folder-id", "data-fid", "data-id"]) {
          const value = row.getAttribute(attr);
          if (value && (attr !== "data-id" || /^[a-f\d-]{16,}$/i.test(value))) {
            siteId ??= `${attr}:${value}`;
            break;
          }
        }
        const size = text(row.querySelector(".txt-size,.file-size,.size,[data-size]"));
        const modified = row.getAttribute("data-mtime") || row.getAttribute("data-modify-time") || "";
        const fingerprint = JSON.stringify([name, kind, size, modified]);
        const key = `${context.folderId}/${siteId ?? `name:${encodeURIComponent(name)}:${kind}`}`;
        records.push({
          node: row,
          item: { key, name, kind, siteId, fingerprint, scrollHint: this.scroller(row).scrollTop, pageHint: this.page }
        });
      }
      const keys = /* @__PURE__ */ new Set();
      for (const record of records) {
        if (keys.has(record.item.key)) throw new FlowError("\u9875\u9762\u5305\u542B\u540C\u540D\u6216\u91CD\u590D\u9879\u76EE\uFF0C\u65E0\u6CD5\u53EF\u9760\u533A\u5206\uFF0C\u8BF7\u5148\u6838\u5BF9\u3002", "AMBIGUOUS_ITEMS");
        keys.add(record.item.key);
      }
      return records;
    }
    scroller(row) {
      let candidate = row?.parentElement ?? this.rows()[0]?.parentElement;
      while (candidate && candidate !== document.body) {
        const style = getComputedStyle(candidate);
        if (candidate.scrollHeight > candidate.clientHeight + 12 && /(auto|scroll|overlay|hidden)/.test(style.overflowY)) return candidate;
        candidate = candidate.parentElement;
      }
      return document.scrollingElement || document.documentElement;
    }
    pagination(direction) {
      const controls = allVisible(selectors[direction]).filter(
        (node) => !node.matches(":disabled,[disabled],[aria-disabled='true'],.disabled") && !node.closest(".disabled,[aria-disabled='true'],.modal-dialog")
      );
      if (controls.length > 1) throw new FlowError("\u5B58\u5728\u591A\u4E2A\u5206\u9875\u63A7\u4EF6\uFF0C\u9700\u8981\u66F4\u65B0\u9875\u9762\u9002\u914D\u3002", "AMBIGUOUS_PAGINATION");
      return controls[0] ?? null;
    }
    async changePage(direction) {
      const control = this.pagination(direction);
      if (!control) return false;
      this.guard();
      const before = this.readRows().map((entry) => entry.item.key).join("|");
      control.click();
      await waitUntil(() => {
        this.checkPage();
        const after = this.readRows().map((entry) => entry.item.key).join("|");
        return after && after !== before && !allVisible(selectors.loading).length;
      }, 1e4, "\u5206\u9875\u672A\u5B8C\u6210\uFF0C\u76EE\u5F55\u8BFB\u53D6\u5DF2\u505C\u6B62\u3002");
      this.page += direction === "next" ? 1 : -1;
      return true;
    }
    async firstPage() {
      const active = allVisible(".pagination .active,[aria-current='page']")[0];
      this.page = Number(text(active)) || this.page || 1;
      for (let count = 0; this.pagination("previous"); count++) {
        if (count >= 100) throw new FlowError("\u5206\u9875\u6570\u91CF\u8FC7\u591A\uFF0C\u8BF7\u7F29\u5C0F\u76EE\u5F55\u8303\u56F4\u3002", "TOO_MANY_PAGES");
        await this.changePage("previous");
      }
      this.page = 1;
    }
    async enumerate(progress, shouldPause) {
      this.checkPage();
      if (allVisible(selectors.modal).length) throw new FlowError("\u8BF7\u5148\u5173\u95ED\u5F53\u524D\u5206\u4EAB\u5F39\u7A97\uFF0C\u518D\u5F00\u59CB\u65B0\u4EFB\u52A1\u3002", "DIALOG_OPEN");
      const expected = await waitUntil(
        () => {
          this.checkPage();
          return this.total();
        },
        8e3,
        "\u65E0\u6CD5\u8BC6\u522B\u76EE\u5F55\u603B\u9879\u6570\u3002\u8BF7\u786E\u8BA4\u5217\u8868\u5DF2\u52A0\u8F7D\uFF0C\u6216\u5BFC\u51FA\u9875\u9762\u8BCA\u65AD\u7528\u4E8E\u66F4\u65B0\u9002\u914D\u3002"
      );
      await this.firstPage();
      this.scroller().scrollTop = 0;
      await settle();
      const items = /* @__PURE__ */ new Map();
      const start = Date.now();
      let bottomUnchanged = 0;
      let lastSize = -1;
      let lastReported = -1;
      for (let step = 0; step < 500 && Date.now() - start < 12e4; step++) {
        if (await shouldPause()) throw new FlowError("\u76EE\u5F55\u8BFB\u53D6\u5DF2\u6682\u505C\u3002", "PAUSE_SCAN");
        this.checkPage();
        if (this.total() !== expected) throw new FlowError("\u8BFB\u53D6\u8FC7\u7A0B\u4E2D\u76EE\u5F55\u603B\u6570\u53D1\u751F\u53D8\u5316\uFF0C\u8BF7\u91CD\u65B0\u8BFB\u53D6\u3002", "DIRECTORY_CHANGED");
        for (const { item } of this.readRows()) {
          const old = items.get(item.key);
          if (old && old.fingerprint !== item.fingerprint) throw new FlowError("\u76EE\u5F55\u5185\u5BB9\u5728\u8BFB\u53D6\u8FC7\u7A0B\u4E2D\u53D1\u751F\u53D8\u5316\u3002", "ITEM_CHANGED");
          items.set(item.key, item);
        }
        if (items.size > expected) throw new FlowError("\u91C7\u96C6\u6570\u91CF\u8D85\u8FC7\u9875\u9762\u603B\u6570\uFF0C\u53EF\u80FD\u6DF7\u5165\u5176\u4ED6\u533A\u57DF\uFF0C\u8BF7\u5BFC\u51FA\u9875\u9762\u8BCA\u65AD\u3002", "COUNT_OVERFLOW");
        if (items.size !== lastReported) {
          await progress(items.size, expected);
          lastReported = items.size;
        }
        if (items.size === expected && !allVisible(selectors.loading).length) {
          await settle(160, 850);
          if (this.total() !== expected) throw new FlowError("\u76EE\u5F55\u5DF2\u53D8\u5316\uFF0C\u8BF7\u91CD\u65B0\u8BFB\u53D6\u3002", "DIRECTORY_CHANGED");
          if (this.bound) this.bound = { ...this.bound, expectedCount: expected };
          return { items: [...items.values()], expected };
        }
        const scroll = this.scroller();
        const atBottom = scroll.scrollTop + scroll.clientHeight >= scroll.scrollHeight - 8;
        bottomUnchanged = atBottom && items.size === lastSize ? bottomUnchanged + 1 : 0;
        lastSize = items.size;
        if (atBottom && bottomUnchanged >= 4) {
          if (await this.changePage("next")) {
            bottomUnchanged = 0;
            this.scroller().scrollTop = 0;
          } else throw new FlowError(`\u4EC5\u627E\u5230 ${items.size} / ${expected} \u9879\uFF0C\u5C1A\u672A\u5B8C\u6574\u8BFB\u53D6\uFF0C\u672A\u521B\u5EFA\u4EFB\u4F55\u5206\u4EAB\u3002`, "INCOMPLETE_SCAN");
        } else {
          scroll.scrollTop = Math.min(scroll.scrollTop + Math.max(180, scroll.clientHeight * 0.75), scroll.scrollHeight);
          scroll.dispatchEvent(new Event("scroll", { bubbles: true }));
        }
        await settle(atBottom ? 400 : 120, 900);
      }
      throw new FlowError(`\u76EE\u5F55\u8BFB\u53D6\u8D85\u65F6\uFF1A${items.size} / ${expected} \u9879\u3002\u8BF7\u5BFC\u51FA\u9875\u9762\u8BCA\u65AD\u3002`, "SCAN_TIMEOUT");
    }
    async locate(item) {
      this.checkPage();
      if (this.bound?.expectedCount !== null && this.bound?.expectedCount !== void 0) {
        const actual = this.total();
        if (actual !== this.bound.expectedCount) throw new FlowError("\u76EE\u5F55\u9879\u6570\u5DF2\u53D8\u5316\uFF0C\u8BF7\u5148\u6838\u5BF9\u539F\u4EFB\u52A1\u3002", "DIRECTORY_CHANGED");
      }
      for (let count = 0; this.page !== item.pageHint && count < 100; count++) {
        if (!await this.changePage(this.page < item.pageHint ? "next" : "previous")) break;
      }
      const find = () => {
        const row = this.readRows().find((entry) => entry.item.key === item.key);
        if (!row) return null;
        if (row.item.name !== item.name || row.item.fingerprint !== item.fingerprint) {
          throw new FlowError(`\u201C${item.name}\u201D\u7684\u540D\u79F0\u6216\u5185\u5BB9\u7279\u5F81\u5DF2\u53D8\u5316\uFF0C\u8BF7\u6838\u5BF9\u3002`, "ITEM_CHANGED");
        }
        return row.node;
      };
      let found = find();
      if (found) {
        found.scrollIntoView({ block: "center" });
        await settle(60, 300);
        return find() ?? found;
      }
      const scroll = this.scroller();
      scroll.scrollTop = item.scrollHint;
      scroll.dispatchEvent(new Event("scroll", { bubbles: true }));
      await settle(160, 600);
      found = find();
      if (found) {
        found.scrollIntoView({ block: "center" });
        return found;
      }
      scroll.scrollTop = 0;
      for (let count = 0; count < 150; count++) {
        this.checkPage();
        await settle(100, 400);
        found = find();
        if (found) {
          found.scrollIntoView({ block: "center" });
          return found;
        }
        if (scroll.scrollTop + scroll.clientHeight >= scroll.scrollHeight - 8) break;
        scroll.scrollTop += Math.max(180, scroll.clientHeight * 0.75);
        scroll.dispatchEvent(new Event("scroll", { bubbles: true }));
      }
      throw new FlowError(`\u65E0\u6CD5\u5B9A\u4F4D\u201C${item.name}\u201D\uFF0C\u672A\u70B9\u51FB\u5206\u4EAB\u3002`, "ITEM_NOT_FOUND");
    }
    modal() {
      const modals = allVisible(selectors.modal);
      if (modals.length > 1) throw new FlowError("\u540C\u65F6\u51FA\u73B0\u591A\u4E2A\u5206\u4EAB\u5F39\u7A97\uFF0C\u5DF2\u6682\u505C\u3002", "MULTIPLE_DIALOGS", true);
      return modals[0] ?? null;
    }
    async openShare(item) {
      this.checkPage();
      const existing = this.modal();
      if (existing) return this.readShare(item);
      const row = await this.locate(item);
      this.guard();
      const rect = row.getBoundingClientRect();
      row.dispatchEvent(new MouseEvent("contextmenu", {
        bubbles: true,
        cancelable: true,
        view: window,
        button: 2,
        buttons: 2,
        clientX: Math.max(1, rect.left + Math.min(rect.width / 2, 120)),
        clientY: Math.max(1, rect.top + rect.height / 2)
      }));
      let share = null;
      try {
        share = await waitUntil(() => {
          this.checkPage();
          const menus = allVisible(selectors.menu).filter(
            (menu) => !allVisible(selectors.menu, menu).some((child) => child !== menu)
          );
          const controls = menus.map((menu) => exactControl(menu, ["\u5206\u4EAB"])).filter((value) => !!value);
          if (controls.length > 1) throw new FlowError("\u591A\u4E2A\u53F3\u952E\u5206\u4EAB\u5165\u53E3\u540C\u65F6\u53EF\u89C1\uFF0C\u5DF2\u505C\u6B62\u3002", "AMBIGUOUS_CONTROL");
          return controls[0];
        }, 1800, "\u53F3\u952E\u83DC\u5355\u672A\u51FA\u73B0\u3002");
      } catch (error) {
        if (!(error instanceof FlowError) || error.code !== "DOM_TIMEOUT") throw error;
        const direct = allVisible("[data-action='share'],[title='\u5206\u4EAB'],[aria-label='\u5206\u4EAB'],.btn-share", row);
        if (direct.length === 1) share = direct[0];
        else throw new FlowError("\u65E0\u6CD5\u8BC6\u522B\u8BE5\u9879\u76EE\u7684\u5206\u4EAB\u83DC\u5355\uFF0C\u5C1A\u672A\u70B9\u51FB\u5206\u4EAB\u3002\u8BF7\u5BFC\u51FA\u9875\u9762\u8BCA\u65AD\u3002", "MENU_NOT_FOUND");
      }
      this.guard();
      share.click();
      try {
        return await waitUntil(() => {
          this.checkPage();
          if (!this.modal()) return null;
          const modal = this.modal();
          const anchor = modal.querySelector(".share-link a.link");
          if (!anchor?.getAttribute("href")) return null;
          return this.readShare(item);
        }, 15e3, "\u5206\u4EAB\u5F39\u7A97\u6216\u94FE\u63A5\u672A\u53CA\u65F6\u51FA\u73B0\uFF0C\u53EF\u80FD\u5DF2\u7ECF\u751F\u6210\u94FE\u63A5\uFF0C\u8BF7\u5148\u6838\u5BF9\u3002", true);
      } catch (error) {
        if (error instanceof FlowError && error.uncertain) throw error;
        throw new FlowError(error instanceof Error ? error.message : String(error), "OPEN_SHARE_UNCERTAIN", true);
      }
    }
    readShare(item) {
      this.guard();
      const modal = this.modal();
      if (!modal) throw new FlowError("\u5206\u4EAB\u5F39\u7A97\u5DF2\u6D88\u5931\uFF0C\u9700\u8981\u6838\u5BF9\u3002", "DIALOG_MISSING", true);
      const nameNode = modal.querySelector(".file-name");
      const name = (nameNode?.getAttribute("title") || text(nameNode)).trim();
      const anchor = modal.querySelector(".share-link a.link");
      const href = anchor?.getAttribute("href") ?? "";
      let url = href;
      try {
        url = new URL(href, location.href).href;
      } catch {
      }
      if (name !== item.name || !isShareUrl(url)) {
        throw new FlowError("\u5206\u4EAB\u5F39\u7A97\u9879\u76EE\u540D\u6216\u94FE\u63A5\u4E0E\u76EE\u6807\u4E0D\u7B26\uFF0C\u5DF2\u505C\u6B62\u3002", "WRONG_SHARE", true, [url].filter(isShareUrl));
      }
      const input = modal.querySelector(".pw input");
      const wrapper = modal.querySelector(".pw-wrapper");
      const value = input?.value.trim() ?? "";
      const enabledControl = exactControl(modal, ["\u53D6\u6D88\u63D0\u53D6\u7801", "\u53D6\u6D88\u8BBF\u95EE\u5BC6\u7801", "\u53D6\u6D88\u5BC6\u7801"]);
      const enabled = visible(wrapper) && !!enabledControl && isPassword(value);
      const linkPassword = text(anchor).match(/(?:密码|提取码)\s*[：:]\s*([A-Za-z0-9]{4,16})/)?.[1];
      if (enabled && linkPassword && linkPassword !== value) {
        throw new FlowError("\u5F39\u7A97\u4E2D\u7684\u5BC6\u7801\u4FE1\u606F\u4E0D\u4E00\u81F4\uFF0C\u8BF7\u6838\u5BF9\u3002", "PASSWORD_MISMATCH", true, [url]);
      }
      const expiryElement = modal.querySelector(".validity,.expire,.expire-time,.expiration,.share-expire,[class*='validity']");
      const expiry = text(expiryElement) || text(modal).match(/(?:有效期|到期时间)\s*[：:]?\s*([^，。\n]{1,45})/)?.[0] || null;
      return { name, url, password: enabled ? value : null, passwordEnabled: enabled, expiry };
    }
    async addPassword(item) {
      this.checkPage();
      const before = this.readShare(item);
      if (before.passwordEnabled) return before;
      const button = exactControl(this.modal(), ["\u6DFB\u52A0\u63D0\u53D6\u7801", "\u6DFB\u52A0\u8BBF\u95EE\u5BC6\u7801", "\u6DFB\u52A0\u5BC6\u7801"]);
      if (!button) throw new FlowError("\u65E0\u6CD5\u8BC6\u522B\u6DFB\u52A0\u5BC6\u7801\u6309\u94AE\u3002\u94FE\u63A5\u53EF\u80FD\u5C1A\u672A\u53D7\u5BC6\u7801\u4FDD\u62A4\uFF0C\u8BF7\u5148\u5904\u7406\u3002", "PASSWORD_BUTTON_MISSING", true, [before.url]);
      this.guard();
      button.click();
      return waitUntil(() => {
        this.checkPage();
        const current = this.readShare(item);
        if (current.url !== before.url) throw new FlowError("\u52A0\u5BC6\u7801\u65F6\u94FE\u63A5\u53D1\u751F\u53D8\u5316\uFF0C\u5DF2\u6682\u505C\u3002", "URL_CHANGED", true, [before.url, current.url]);
        return current.passwordEnabled ? current : null;
      }, 12e3, "\u6DFB\u52A0\u5BC6\u7801\u672A\u786E\u8BA4\u6210\u529F\uFF0C\u94FE\u63A5\u53EF\u80FD\u5C1A\u672A\u53D7\u4FDD\u62A4\uFF0C\u8BF7\u5148\u6838\u5BF9\u3002", true);
    }
    async closeShare() {
      this.guard();
      const modal = this.modal();
      if (!modal) return;
      const buttons = allVisible(selectors.close, modal);
      const button = buttons[0] ?? exactControl(modal, ["\u5173\u95ED\u5F39\u7A97", "\u5173\u95ED"]);
      if (!button) throw new FlowError("\u65E0\u6CD5\u627E\u5230\u5206\u4EAB\u5F39\u7A97\u7684\u5173\u95ED\u6309\u94AE\u3002", "CLOSE_NOT_FOUND");
      button.click();
      await waitUntil(() => !this.modal(), 5e3, "\u5206\u4EAB\u5F39\u7A97\u672A\u5173\u95ED\u3002");
    }
    diagnostics() {
      let context = null;
      let rows = [];
      let parsedRowCount = 0;
      let error = null;
      try {
        context = this.context();
        rows = this.rows();
        parsedRowCount = this.readRows().length;
      } catch (caught) {
        error = String(caught);
      }
      const safeClasses = /* @__PURE__ */ new Set([
        "file-list",
        "file-item",
        "list-item",
        "mod-file-list",
        "file-list-item",
        "disk-file-list",
        "list-view",
        "list-tr",
        "file-name",
        "filename",
        "file_name",
        "fileName",
        "name",
        "item-name",
        "list-name",
        "file-size",
        "size",
        "icon-folder",
        "folder-icon",
        "icon-file",
        "file-icon",
        "folder",
        "directory",
        "context-menu",
        "contextmenu",
        "mod-context-menu",
        "mod-contextmenu",
        "dropdown-menu",
        "menu-list",
        "disk-context-menu",
        "mod-list-group",
        "mod-list-group-files",
        "list-group-bd",
        "list-group-wrapper",
        "list-group",
        "list-group-item",
        "item-inner",
        "item-tit",
        "item-info",
        "item-info-list",
        "info",
        "tit",
        "thumb",
        "label",
        "txt",
        "txt-size",
        "txt-time",
        "icon",
        "icon-m",
        "icon-file-m",
        "icon-check-s",
        "icon-checkbox"
      ]);
      const safeAttributes = /* @__PURE__ */ new Set([
        "class",
        "title",
        "href",
        "role",
        "data-id",
        "data-file-id",
        "data-dir-id",
        "data-folder-id",
        "data-type",
        "data-fid",
        "data-file-name",
        "aria-label",
        "tabindex",
        "style"
      ]);
      const structure = (node) => ({
        tag: node.tagName,
        classes: [...node.classList].filter((value) => safeClasses.has(value)),
        unlistedClassCount: [...node.classList].filter((value) => !safeClasses.has(value)).length,
        attributeNames: node.getAttributeNames().filter((value) => safeAttributes.has(value))
      });
      return {
        adapterVersion: "0.1.2",
        path: location.pathname,
        folderId: context?.folderId,
        expectedCount: context?.expectedCount,
        rowCandidateCount: rows.length,
        parsedRowCount,
        nameCandidateCount: allVisible(selectors.name).filter((node) => !node.closest(selectors.excluded)).length,
        scrollContainer: (() => {
          const node = this.scroller(rows[0]);
          return { ...structure(node), clientHeight: node.clientHeight, scrollHeight: node.scrollHeight, scrollTop: node.scrollTop };
        })(),
        visibleMenuStructure: allVisible(selectors.menu).map(structure),
        shareDialogPresent: !!this.modal(),
        rowStructure: rows.slice(0, 6).map((node) => ({
          ...structure(node),
          children: [...node.querySelectorAll("*")].slice(0, 12).map(structure)
        })),
        error,
        note: "\u4EC5\u542B\u9875\u9762\u7ED3\u6784\uFF0C\u4E0D\u542B\u6587\u4EF6\u540D\u3001\u5206\u4EAB\u94FE\u63A5\u3001\u5BC6\u7801\u6216\u767B\u5F55 token\u3002"
      };
    }
  };

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
  function isRequest(value) {
    return !!value && typeof value === "object" && value.channel === CHANNEL && typeof value.action === "string";
  }

  // src/runner.ts
  var Runner = class {
    constructor(adapter, port) {
      this.adapter = adapter;
      this.port = port;
    }
    adapter;
    port;
    busy = false;
    get isBusy() {
      return this.busy;
    }
    async run() {
      if (this.busy) throw new FlowError("\u540C\u4E00\u9875\u9762\u5DF2\u6709\u4EFB\u52A1\u5728\u8FD0\u884C\u3002", "RUNNER_BUSY");
      this.busy = true;
      try {
        let task = await this.port.get();
        assertContext(task.context, this.adapter.context());
        this.adapter.checkPage();
        if (!task.snapshotAt) {
          const snapshot = await this.adapter.enumerate(
            async (found, expected) => {
              await this.port.commit({ type: "scan_progress", found, expected });
            },
            async () => (await this.port.get()).pauseRequested
          );
          task = await this.port.commit({ type: "scan_done", ...snapshot });
        }
        const recoveryFirst = [...task.items].sort((left, right) => {
          const priority = (item) => item.manualReview ? 0 : ["link_observed", "securing", "verifying"].includes(item.status) ? 1 : 2;
          return priority(left) - priority(right) || left.ordinal - right.ordinal;
        });
        for (const original of recoveryFirst) {
          task = await this.port.get();
          if (task.pauseRequested) {
            await this.port.commit({ type: "paused" });
            return;
          }
          if (!["running", "pausing"].includes(task.status)) return;
          const item = task.items.find((entry) => entry.key === original.key);
          if (["done", "failed"].includes(item.status)) continue;
          if (item.status === "needs_review") return;
          try {
            assertContext(task.context, this.adapter.context());
            this.adapter.checkPage();
            const result = await this.processItem(item);
            await this.port.commit({ type: "item_done", key: item.key, result });
            try {
              await this.adapter.closeShare();
            } catch (error) {
              await this.port.commit({ type: "paused", message: `\u7ED3\u679C\u5DF2\u4FDD\u5B58\uFF0C\u4F46\u5F39\u7A97\u672A\u5173\u95ED\uFF1A${asFlowError(error).message}` });
              return;
            }
          } catch (error) {
            let flow = asFlowError(error, true);
            if (!flow.uncertain && (item.observedUrl || ["link_observed", "securing", "verifying"].includes(item.status))) {
              flow = new FlowError(
                `\u4E0A\u6B21\u5206\u4EAB\u5C1A\u672A\u5B8C\u6210\u9A8C\u8BC1\uFF0C\u4E0D\u80FD\u8DF3\u8FC7\u8BE5\u9879\uFF1A${flow.message}`,
                flow.code,
                true,
                [item.observedUrl, ...flow.relatedUrls].filter((url) => !!url)
              );
            }
            if (flow.code === "PERSISTENCE_FAILED" || flow.code === "STALE_RUN") throw flow;
            task = await this.port.commit({ type: "item_error", key: item.key, error: errorInfo(flow), uncertain: flow.uncertain });
            if (flow.uncertain || task.status === "needs_review") return;
          }
        }
        task = await this.port.get();
        if (task.pauseRequested) {
          await this.port.commit({ type: "paused" });
        } else {
          task = await this.port.commit({ type: "finish" });
          await this.port.finished(task).catch(() => void 0);
        }
      } catch (error) {
        const flow = asFlowError(error);
        if (flow.code === "PAUSE_SCAN") {
          await this.port.commit({ type: "paused", message: "\u76EE\u5F55\u8BFB\u53D6\u5DF2\u6682\u505C\uFF0C\u5C1A\u672A\u521B\u5EFA\u5206\u4EAB\u3002" }).catch(() => void 0);
        } else {
          await this.port.commit({ type: "task_error", error: errorInfo(flow), uncertain: flow.uncertain }).catch(() => void 0);
        }
        throw flow;
      } finally {
        this.busy = false;
      }
    }
    validate(observation, item, secured = false) {
      if (observation.name !== item.name || !isShareUrl(observation.url)) {
        throw new FlowError("\u5206\u4EAB\u5F39\u7A97\u4E0E\u76EE\u6807\u9879\u76EE\u4E0D\u4E00\u81F4\uFF0C\u5DF2\u505C\u6B62\u3002", "WRONG_SHARE", true, [observation.url].filter(isShareUrl));
      }
      if (secured && (!observation.passwordEnabled || !isPassword(observation.password))) {
        throw new FlowError("\u8BBF\u95EE\u5BC6\u7801\u5C1A\u672A\u786E\u8BA4\u4FDD\u5B58\uFF0C\u9700\u8981\u5148\u6838\u5BF9\u5F53\u524D\u5206\u4EAB\u3002", "PASSWORD_UNCONFIRMED", true, [observation.url]);
      }
    }
    async protectUnexpected(item, observation) {
      await this.port.commit({ type: "related_share", key: item.key, url: observation.url });
      if (observation.name === item.name && !observation.passwordEnabled) {
        await this.adapter.addPassword(item).catch(() => void 0);
      }
    }
    async processItem(item) {
      if (item.manualReview) {
        const reviewed = this.adapter.readShare(item);
        this.validate(reviewed, item, true);
        if (reviewed.url !== item.manualReview.url) {
          throw new FlowError("\u6838\u5BF9\u540E\u5206\u4EAB\u94FE\u63A5\u5DF2\u53D8\u5316\uFF0C\u8BF7\u91CD\u65B0\u6838\u5BF9\u5F53\u524D\u5F39\u7A97\u3002", "URL_CHANGED", true, [item.manualReview.url, reviewed.url]);
        }
        if (reviewed.password !== item.manualReview.password) {
          throw new FlowError("\u6838\u5BF9\u540E\u5BC6\u7801\u5DF2\u53D8\u5316\uFF0C\u8BF7\u91CD\u65B0\u6838\u5BF9\u5F53\u524D\u5F39\u7A97\u3002", "PASSWORD_CHANGED", true, [reviewed.url]);
        }
        // Reopening would repeat the automatic check the user just reconciled.
        return {
          url: reviewed.url,
          password: reviewed.password,
          passwordEnabled: true,
          expiry: reviewed.expiry,
          verifiedAt: (/* @__PURE__ */ new Date()).toISOString(),
          verification: "manual_review"
        };
      }
      const fresh = item.status === "pending";
      if (fresh) await this.port.commit({ type: "phase", key: item.key, status: "opening_share" });
      if (!fresh && !item.observedUrl) {
        throw new FlowError("\u4E0A\u6B21\u53EF\u80FD\u5DF2\u521B\u5EFA\u94FE\u63A5\uFF0C\u4E0D\u80FD\u81EA\u52A8\u91CD\u5EFA\u3002\u8BF7\u5148\u6838\u5BF9\u3002", "UNKNOWN_PREVIOUS_SHARE", true);
      }
      let observed = await this.adapter.openShare(item);
      this.validate(observed, item);
      const expectedUrl = item.observedUrl ?? item.candidate?.url;
      if (expectedUrl && observed.url !== expectedUrl) {
        await this.protectUnexpected(item, observed);
        throw new FlowError("\u5F53\u524D\u94FE\u63A5\u4E0E\u5DF2\u4FDD\u5B58\u94FE\u63A5\u4E0D\u540C\uFF0C\u5DF2\u6682\u505C\uFF0C\u907F\u514D\u91CD\u590D\u5206\u4EAB\u3002", "URL_CHANGED", true, [expectedUrl, observed.url]);
      }
      if (item.candidate?.password && observed.passwordEnabled && observed.password !== item.candidate.password) {
        throw new FlowError("\u73B0\u6709\u5BC6\u7801\u4E0E\u5BFC\u5165\u8BB0\u5F55\u4E0D\u540C\uFF0C\u5DF2\u4FDD\u7559\u73B0\u6709\u8BBE\u7F6E\uFF0C\u8BF7\u6838\u5BF9\u3002", "IMPORTED_PASSWORD_CHANGED", true, [observed.url]);
      }
      if (fresh) {
        await this.port.commit({ type: "phase", key: item.key, status: "link_observed", url: observed.url });
        await this.port.commit({ type: "phase", key: item.key, status: "securing" });
      } else if (item.status === "link_observed") {
        await this.port.commit({ type: "phase", key: item.key, status: "securing" });
      }
      if (!observed.passwordEnabled) observed = await this.adapter.addPassword(item);
      this.validate(observed, item, true);
      if (observed.url !== (expectedUrl ?? observed.url)) {
        throw new FlowError("\u8BBE\u7F6E\u5BC6\u7801\u65F6\u94FE\u63A5\u53D1\u751F\u53D8\u5316\uFF0C\u8BF7\u6838\u5BF9\u3002", "URL_CHANGED", true, [expectedUrl, observed.url].filter(Boolean));
      }
      if (!fresh) {
        const current2 = (await this.port.get()).items.find((entry) => entry.key === item.key);
        if (current2.status === "verifying") {
          if (current2.observedPassword && current2.observedPassword !== observed.password) {
            throw new FlowError("\u6062\u590D\u65F6\u53D1\u73B0\u5BC6\u7801\u53D8\u5316\uFF0C\u8BF7\u6838\u5BF9\u73B0\u6709\u5206\u4EAB\u3002", "PASSWORD_CHANGED", true, [observed.url]);
          }
        }
      }
      const current = (await this.port.get()).items.find((entry) => entry.key === item.key);
      if (current.status !== "verifying") {
        await this.port.commit({ type: "phase", key: item.key, status: "verifying", url: observed.url, password: observed.password });
      }
      await this.adapter.closeShare();
      const reopened = await this.adapter.openShare(item);
      this.validate(reopened, item);
      if (reopened.url !== observed.url) {
        await this.protectUnexpected(item, reopened);
        throw new FlowError("\u91CD\u65B0\u6253\u5F00\u5206\u4EAB\u65F6\u751F\u6210\u4E86\u4E0D\u540C\u94FE\u63A5\uFF0C\u65E0\u6CD5\u786E\u8BA4\u590D\u7528\u884C\u4E3A\u3002\u5DF2\u6682\u505C\uFF0C\u8BF7\u6838\u5BF9\u4E24\u4E2A\u94FE\u63A5\u3002", "REOPEN_CREATED_NEW_SHARE", true, [observed.url, reopened.url]);
      }
      if (!reopened.passwordEnabled) {
        await this.protectUnexpected(item, reopened);
        throw new FlowError("\u91CD\u65B0\u6253\u5F00\u540E\u5BC6\u7801\u672A\u4FDD\u7559\uFF0C\u5DF2\u5C1D\u8BD5\u8865\u5145\u4FDD\u62A4\uFF0C\u8BF7\u6838\u5BF9\u3002", "PASSWORD_NOT_PERSISTED", true, [reopened.url]);
      }
      this.validate(reopened, item, true);
      if (reopened.password !== observed.password) {
        throw new FlowError("\u91CD\u65B0\u6253\u5F00\u540E\u5BC6\u7801\u4E0D\u540C\uFF0C\u9700\u8981\u6838\u5BF9\u3002", "PASSWORD_CHANGED", true, [reopened.url]);
      }
      return {
        url: reopened.url,
        password: reopened.password,
        passwordEnabled: true,
        expiry: reopened.expiry,
        verifiedAt: (/* @__PURE__ */ new Date()).toISOString(),
        verification: "reopened_dialog"
      };
    }
  };

  // src/content.ts
  if (!window.__weiyunBatchShareV1) {
    const state = { adapter: new WeiyunAdapter(), runner: null, runId: null, lastError: null };
    window.__weiyunBatchShareV1 = state;
    chrome.runtime.onMessage.addListener((raw, sender, sendResponse) => {
      if (!isRequest(raw) || sender.id !== chrome.runtime.id) return false;
      try {
        if (raw.action === "CONTEXT") {
          sendResponse({ ok: true, data: state.adapter.context() });
        } else if (raw.action === "STATUS") {
          sendResponse({
            ok: true,
            data: { busy: !!state.runner?.isBusy, runId: state.runId, documentNonce: state.adapter.documentNonce, lastError: state.lastError }
          });
        } else if (raw.action === "DIAGNOSE") {
          sendResponse({ ok: true, data: state.adapter.diagnostics() });
        } else if (raw.action === "READ_REVIEW") {
          if (state.runner?.isBusy) throw new FlowError("\u6267\u884C\u5668\u5C1A\u672A\u505C\u6B62\uFF0C\u8BF7\u7A0D\u540E\u6838\u5BF9\u3002", "RUNNER_BUSY");
          const item = raw.item;
          const observation = state.adapter.readShare(item);
          sendResponse({ ok: true, data: observation });
        } else if (raw.action === "RUN") {
          if (state.runner?.isBusy) throw new FlowError("\u5F53\u524D\u9875\u9762\u5DF2\u6709\u4EFB\u52A1\u8FD0\u884C\u3002", "RUNNER_BUSY");
          const task = raw.task;
          if (!task?.id || !task.runId || task.context.documentNonce !== state.adapter.documentNonce) {
            throw new FlowError("\u9875\u9762\u5DF2\u91CD\u65B0\u52A0\u8F7D\uFF0C\u8BF7\u91CD\u65B0\u8FDE\u63A5\u3002", "STALE_DOCUMENT");
          }
          state.adapter.bind(task.context);
          state.runId = task.runId;
          state.lastError = null;
          const fields = { taskId: task.id, runId: task.runId, documentNonce: state.adapter.documentNonce };
          state.runner = new Runner(state.adapter, {
            get: () => rpc("GET_TASK", fields),
            commit: async (event) => {
              try {
                return await rpc("COMMIT", { ...fields, event });
              } catch (error) {
                const flow = asFlowError(error, true);
                throw new FlowError(
                  `\u8FDB\u5EA6\u4FDD\u5B58\u672A\u786E\u8BA4\uFF0C\u5DF2\u505C\u6B62\u65B0\u589E\u64CD\u4F5C\uFF1A${flow.message}`,
                  flow.code === "STALE_RUN" ? "STALE_RUN" : "PERSISTENCE_FAILED",
                  true
                );
              }
            },
            finished: () => rpc("AUTO_EXPORT", fields)
          });
          sendResponse({ ok: true, data: { started: true } });
          void state.runner.run().catch((error) => {
            state.lastError = asFlowError(error).message;
          });
        } else {
          throw new FlowError("\u4E0D\u652F\u6301\u7684\u9875\u9762\u547D\u4EE4\u3002", "UNKNOWN_COMMAND");
        }
      } catch (error) {
        const flow = asFlowError(error);
        sendResponse({ ok: false, error: { message: flow.message, code: flow.code, uncertain: flow.uncertain, relatedUrls: flow.relatedUrls } });
      }
      return false;
    });
  }
})();

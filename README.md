# 微云 · 逐项分享

个人使用的 Manifest V3 Chrome extension，目标发布版本 `0.1.4`（测试版）。读取微云当前目录的直接项目，串行分享并导出结果和日志，不递归分享子目录内容。实际版本以扩展管理页重新加载后显示的版本为准。

**0.1.4 允许对未完成项重复分享，不再逐项人工核对链接或密码。每项每轮最多自动尝试 3 次（含首次），仍失败记为 `failed` 并继续下一项；本机原任务中已保存的 `done` 项跳过。** 网站可能复用或生成新链接，旧分享不保证撤销，旧密码不保证不变。

验证仅以本次**同一分享弹窗**内的项目、链接和有效密码显示为依据，不关闭再重开验证，也不代表独立服务端或接收端访问验证。本轮仅使用本地 fixture，无真实云盘写入，不声称真实 60 项 E2E 成功。具体测试环境及最终结果以发布包的 `TESTING.md` 为准，本文不固定测试数量。

## 安装与升级

首次安装：解压发布包，在 `chrome://extensions` 打开“开发者模式”，点击“加载已解压的扩展程序”，选择直接包含 `manifest.json` 的目录；固定工具栏图标，在同一 Chrome profile 中登录[微云网页版](https://www.weiyun.com)。Codex 内置浏览器的登录状态不能假定与 Chrome 共享。使用插件不需要 Node.js、Python、AI API key 或后端服务。

**升级原任务到 0.1.4：**

1. 暂停正在运行的任务，等到安全持久化边界，先导出进度 JSON，按需导出 TXT 和日志；这些文件含敏感分享信息。
2. 用 0.1.4 发布内容覆盖**原来加载的同一个插件目录**。不要卸载、清空 storage、更换 browser profile 或加载目录，以保留原 extension ID 与本地任务。
3. 在 `chrome://extensions`（Edge 为 `edge://extensions`）点击插件“重新加载”，确认版本为 `0.1.4`。仅覆盖文件不等于已更新。
4. **刷新原微云 tab**，回到原账号、原目录，再点击工具栏图标读取原任务。只重新打开面板不能替换旧 content script。
5. 点击“继续任务”。旧 `needs_review` 和其他中断未完成项进入自动重试，不需要打开历史分享页、填写密码或逐项批准；已 `done` 项不重复处理。

无法识别稳定账号且跨 document 恢复时，可按提示一次确认原账号；这是本次恢复的身份确认，不是逐项分享核对。已识别账号不同或目录变化时仍停止。已有本地任务无需重新导入 JSON，也不要为了升级重建整批任务。

## 使用与恢复

面板顶部的“打开微云主目录”会在当前浏览器的新标签页打开微云网页版主目录，沿用该 browser profile 的登录状态，不改变已有任务的目标 tab；尚未登录时按微云页面提示登录即可。

1. 打开目标微云目录，等待总项数显示，点击工具栏插件图标打开 Side Panel。
2. 确认目录和数量；新任务点击“全部分享并导出 TXT”，已有任务选择继续。
3. 保持目标 tab 打开，不同时选择其他项目、导航目录或操作分享弹窗。
4. 正常处理结束后自动下载**结果 TXT 和日志 TXT**；可分别手动导出 TXT、日志或 JSON。

- **自动重试**：链接、密码或中断结果不确定时允许重新执行分享流程，每项每轮最多 3 次；历史 URL 记录到日志，不要求人工采用旧结果。
- **仅重试失败项**：显式为 `failed` 项开始新一轮有限重试，保留以前的尝试与历史记录，不重做 `done` 项。
- **暂停/继续**：在安全 checkpoint 暂停；继续原快照的剩余未完成项，不因单项失败跳过后续项目，也不无限重试。
- **仍须整批停止**：账号或目录变化、验证码/CAPTCHA、限流、项目身份歧义或错误项目、存储失败/缺少 ACK、stale run 或执行器绑定失效。这些错误不能当作普通单项失败吞掉后继续。
- **执行器失联**：先刷新或关闭旧 tab，确保旧执行器不再操作，再回原目录恢复；不同时启动两个 runner。

当前弹窗能读取有效密码时使用本次显示值；无法确认时可在次数上限内重新分享或设置密码，不从旧 `observedPassword` 推断当前有效密码。空白弹窗不证明服务端密码丢失。网站先生成链接、再设置密码，可能存在短暂的无密码窗口；重试还可能留下多个分享，插件不会自动撤销它们。

## 结果、日志与备份

**结果 TXT** 使用 UTF-8 BOM、Windows CRLF，只输出成功项，每项一行，格式如下（示例为虚构值）：

```text
1.链接：https://share.weiyun.com/EXAMPLE 密码：abcd
```

没有标题、名称、有效期、状态说明或未完成占位。编号使用原快照 `ordinal`，不重新连续编号：第 2 项失败时，成功项可为 `1.`、`3.`。零成功时不写占位内容。

**日志 TXT** 单独记录统计、任务/项目状态、失败原因、尝试与重试、历史 URL 及验证边界。日志中的旧链接可能仍有效，列出它们不代表已撤销或已受密码保护。结果 TXT 不夹带日志。

**JSON** 保存完整进度，供恢复或迁移。导入外部 JSON 或旧 checkpoint 只产生候选与历史记录，即使文件声称已完成，也不直接信任为成功；候选项重新执行分享并在当前同一弹窗确认。导入与继续本机原任务不同，后者跳过已持久化的 `done` 项。

两个自动下载分别执行；下载失败不重做分享，可单独重新导出缺少的结果或日志。下载位置及是否询问由浏览器设置决定。

## 权限与隐私

- 发布权限仅为 `activeTab`、`scripting`、`storage`、`sidePanel`、`downloads`，无持久全站 host permissions，不申请 cookie、clipboard、debugger 或 nativeMessaging 权限。
- 点击工具栏图标为当前 tab 授予 `activeTab`；仅从浏览器菜单打开面板不一定有访问权限。
- 任务保存在本机 `chrome.storage.local`，不使用 `storage.sync` 或第三方后端；分享操作仍通过微云网页与微云服务通信。
- 结果和 JSON 含链接、密码，日志也含敏感分享信息。本地 storage 和导出文件不是加密保险箱；删除本地任务不撤销云盘分享。
- 页面诊断仅输出 allowlist 内的结构信息，不输出文件名、分享 URL、密码、cookie 或 token。数量不完整或无法唯一定位项目时停止，可导出诊断定位问题。
- 不提供删除云盘文件、撤销历史分享、私有 API 加速、绕过验证码或限流的功能。

## 从源码构建与测试

需要 Node.js 22+；普通安装使用发布目录，无需 Node.js：

```powershell
npm install
npm run typecheck
npm test
npm run build
```

将生成的 `dist` 加载为 unpacked extension。更新源码后重新构建、reload extension、刷新微云 tab；不要在任务运行中重载。

浏览器 integration tests 使用 Playwright、独立 profile 与完全拦截的本地 fixture，不使用用户 Chrome profile 或真实云盘：

```powershell
npm install --no-save playwright
npx playwright install chromium
$env:WEIYUN_CHROME_PATH = '<支持 --load-extension 的 Chromium 或 Chrome for Testing 可执行文件路径>'
node scripts/browser-test.mjs
node scripts/adapter-test.mjs
```

目标平台为 Chrome 120+；用于 automation 的 `--load-extension` 支持与手动加载扩展不同。fixture 不能证明真实服务端密码保存、接收端访问、分享复用、限流或真实批量耗时，不承诺固定完成时间。

实现约束见 [IMPLEMENTATION.md](docs/IMPLEMENTATION.md)，本次变更见 [BUGFIX-0.1.4.md](docs/BUGFIX-0.1.4.md)。[0.1.1](docs/BUGFIX-0.1.1.md)、[0.1.2](docs/BUGFIX-0.1.2.md)、[0.1.3](docs/BUGFIX-0.1.3.md) 仅保留历史说明，其中旧版人工核对、批准及重开验证用法不适用于当前版本。

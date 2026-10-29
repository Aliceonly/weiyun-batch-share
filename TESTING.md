# 测试与交付状态

版本：0.1.4（测试版）
测试时间：2026-10-21T14:22:04.126Z

## 2026-10-29：补齐新增项目与全量重分享

- 主面板显示“补齐新增项目”和“全部重新分享”，不再要求到折叠区寻找重建入口。当前页面 73 项、旧任务快照 72 项时显示明确提示；数量相同也可重新扫描，运行中禁止重复启动。
- 补齐建立新任务，按稳定 ID 或严格元数据匹配复用已完成结果，只处理新增及未完成项；全量重分享经确认后处理当前全部项目。两种操作都保留原任务，结果 TXT 仍按项目名称导出。
- `node --test tests/reconcile.test.cjs`：95 项通过。覆盖 72 → 73、无新增、失败项与新增项同时补齐、稳定 ID 重命名、同名替换、无 ID 的元数据变更、扫描中断恢复、重复身份、运行中拒绝、账号确认、revision 冲突、存储失败及面板按钮行为。
- 隔离 Chromium 147.0.7727.15 使用真实扩展消息、storage 与 runner，并仅替换本地 fixture 的目录/分享 adapter：补齐复用 72 项，只打开第 73 项；全量重分享打开全部 73 项。旧任务深度比较保持不变，已复用结果不变，页面无 JavaScript 异常。
- 面板文档在普通扩展标签页中验证，280px 与 360px 宽度无横向溢出，两个操作入口可用；未验证原生 Side Panel 容器。所有微云页面请求均拦截为本地 fixture，未向真实云盘执行分享，也不证明服务端密码状态。

## 2026-10-29：按目录名称导出

- 结果 TXT 每行使用 `目录：项目原名 链接：分享 URL 密码：密码`，不再把快照位置当作目录编号；不连续的 `16`、`18`、前导零、描述性名称及非数字名称均保留。
- 自动导出、手动导出和已有任务重新导出共用同一格式；重导出仅使用已保存的成功结果，不重新分享，不改变原任务项目。名称中的换行和控制字符规范为空格，保留 UTF-8 BOM 与 CRLF。
- `node --test tests/reconcile.test.cjs`：75 项通过。新增跳号目录重导出、完整名称保留及名称换行处理回归；更新自动下载和部分导出的格式断言。未执行真实云盘分享。

## 2026-10-29：新标签页重新读取

- 修复前在隔离的 Chromium 147.0.7727.15 中复现：从面板入口打开主目录后，新 tab 未获得 `activeTab` 授权，Chrome 不返回 tab URL，`CONNECT` 报 `WRONG_PAGE`。
- 仅授予 `www.weiyun.com` 与 `weiyun.com` 的 HTTPS host_permissions 后，同一面板文档可直接通过“重新读取”连接新主目录；未点击工具栏、未重新加载面板，两种域名均通过，目标 tab 绑定正确。
- `node --test tests/reconcile.test.cjs`：72 项通过，包括新标签页首次注入、重复连接、目标 tab 切换、已有任务保留及无关网站拒绝访问。`git diff --check` 与相关 JavaScript 语法检查通过。
- 浏览器验证使用真实扩展 API 和本地拦截的微云 fixture，面板文档在标签页中运行；不代表原生 Side Panel 容器或真实账号的现场验收，未向真实微云执行分享。

## 已通过

- TypeScript strict typecheck。
- 70 项核心、自动重试及极简 TXT / 独立日志 regression tests 全部通过。
- 69 项编译产物上的恢复、重试、存储 ACK、并发、账号与下载保护 regression tests 全部通过。
- 3 项基于已捕获 DOM 结构的 adapter regression tests 全部通过。
- MV3 extension 在隔离的 Chromium 系 Edge profile 中运行；微云网页请求由本地 fixture 拦截，没有向真实微云创建分享或修改密码。
- Browser fixture: full-60。
- Browser fixture: url-retry。
- Browser fixture: password-retry-twice。
- Browser fixture: retry-exhausted-continue。
- Browser fixture: password-uncertain-recode。
- Browser fixture: pause-reload-resume。
- Browser fixture: incomplete-diagnostics。
- Browser fixture: captured-list-60。
- Browser fixture: legacy-refresh。
- Browser fixture: legacy-live-password-view。
- Browser fixture: import-uncertain。
- Browser fixture: unknown-account-refresh。
- Browser fixture: wrong-item-stops。
- 覆盖真实 service worker、isolated content script、runtime messages、storage 和 downloads API 集成。
- 旧 needs_review 与无 URL 中断项可直接继续；链接或密码不确定时最多自动尝试 3 次，仍失败则记入日志并继续后项。
- 已完成项不重做；未完成项重新分享后只采用本次成功结果，历史相关链接仅进入日志。没有人工核对或批准入口。
- 同一弹窗确认 URL 与有效密码，不关闭重开来推断服务端密码状态；结果不代表独立服务端或接收端验证。
- 完成后分别下载极简结果 TXT 与详细日志，自动重复请求不重复下载；手动导出仍可重试下载。
- 账号/目录/项目变化、错误弹窗、验证码/限流、缺少存储 ACK 或 stale runner 仍阻止新增分享。
- 2026-10-21 的发布 manifest 无 host_permissions；2026-10-29 为修复新标签页“重新读取”失效，仅增加两个微云 HTTPS 域名的 host_permissions，未增加全站访问权限。

## 验证边界

- 尚未对真实微云执行本次版本的批量分享端到端验收，也没有执行真实 60 项分享。
- 微云服务端的链接复用、密码保存、分享频率限制及不同布局/账号的兼容性需要现场验收。
- Chrome 手动安装、真实工具栏点击与 Side Panel 展示链路仍需现场验证；fixture 不代表真实服务端性能。
- 重新分享可能创建额外链接或改变原密码；旧链接不自动撤销，不能把日志中的历史链接当作当前有效结果。

## 更新并继续

1. 先导出进度 JSON 备份；覆盖原来加载的同一个插件目录，保留 extension ID、browser profile 和 storage。
2. 在 chrome://extensions 或 edge://extensions 中重新加载，确认版本为 0.1.4。
3. 刷新原微云 tab，回到原账号、原目录，点击插件图标，再点击继续任务。无需核对旧分享链接或密码。
4. 若网站不提供账号标识，刷新后可能只需一次确认仍为原账号，这不是逐项分享核对。
5. 完成后查看极简结果 TXT；失败原因、历史 URL 与尝试记录看导出日志，必要时仅重试失败项。
6. 正式目录使用前，建议先用 3–5 项专用测试目录确认结果可以访问。

历史 bugfix 文档保留用于版本追溯；以 README 与 BUGFIX-0.1.4.md 的当前行为为准。
未修改交付目录的 .git，未创建 commit。通用发布包和源码包均不包含真实分享结果或进度中的凭据。

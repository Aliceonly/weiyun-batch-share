# 0.1.1: 目录读取 0 / 60

## 根因

旧版 adapter 的行规则集中于 `.file-item` / `.list-item` 等结构，名称规则集中于 `.file-name`。2026-10-21 读取真实登录页面发现，文件列表实际使用：

```html
<div class="mod-list-group mod-list-group-files">
  <div class="list-group-bd" tabindex="0">
    <div class="list-group-wrapper">
      <ul class="list-group">
        <li class="list-group-item">
          <div class="item-inner">
            <div class="item-tit">
              <div class="thumb"><i class="icon icon-m icon-file-m"></i></div>
              <div class="info"><div><a class="tit" title="Synthetic item" href="javascript:void(0)">Synthetic item</a></div></div>
            </div>
            <div class="item-info"><span class="item-info-list"><span class="txt txt-size">1 MB</span></span></div>
          </div>
        </li>
      </ul>
    </div>
  </div>
</div>
```

名称和大小已替换为合成数据。真实页面没有在这些行上提供稳定的 `data-file-id`；因此仍使用既有的目录、精确名称、类型及大小特征核对，不伪造稳定 ID。

页面底部总数可以读取，但旧版行和名称 selector 的真实匹配数均为 0。结果不是 60 项已被分享，而是完整清单检查阻止了所有分享操作。

## 复现与修复

快速 feedback loop：`node scripts/adapter-test.mjs`。设置本机 `WEIYUN_PLAYWRIGHT_PATH` / `WEIYUN_CHROME_PATH` 后可运行，完全使用本地合成数据和隔离 browser，不连接真实云盘。

修复前，捕获结构的 fixture 稳定失败：

```text
AssertionError: 0 / 60: captured list-group rows must be recognized before scrolling
0 !== 50
```

修复后，识别初始 50 项，并通过实际列表的滚动祖先加载至 60 项，名称为连续 1–60，未派发任何分享动作。隐藏列表没有成为滚动目标，因此无需更换已有 scroller 算法。另有隐藏及无关列表排除、名称不可读诊断的 regression tests。

分享菜单的真实 `.menu-list` 结构也加入完整 MV3 fixture 测试。每个项目独立生成链接、添加密码、重开核对、持久化的行为在本地测试页面执行，不向真实微云生成分享。

## 真实页面只读核对

- 初始渲染 50 项，滚动后渲染 60 项。
- 新行 selector 匹配 60 项，名称可解析 60 项，名称无重复且是 1–60。
- 60 项图标均为页面可见的文件夹图标，对应 `.thumb > .icon-file-m`。
- 只展开右键菜单检查 DOM，未点击“分享”，未修改密码或已有分享。

这里验证的是真实 DOM 结构及 lazy loading，不是新 extension 在真实网站上完成分享。真实服务端保存、已有分享复用、限流和手动安装链路仍需小目录验收。

## 更新注意

覆盖原 extension 目录并在扩展管理页重新加载后，还必须刷新微云 tab，避免旧 content script 继续存在。保留原目录和 extension identity，不卸载插件、不清空 storage。扫描失败而尚未创建快照的任务可以继续重扫；其他历史任务仍按既有恢复和人工核对规则处理。

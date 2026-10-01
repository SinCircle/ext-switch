# 扩展开关

一个 300px 的小面板，点一下工具栏图标就出来，逐个开关**你的其他浏览器扩展**。

*A 300px popup to switch your other browser extensions on and off: one click each, batch on/off,
undo, three sort modes.*

Chrome / Edge 通用，Manifest V3，权限只有 `management` 和 `storage`。

浏览器的扩展管理页要开标签页、滚动、点两下才到位。而"临时关掉某几个扩展"是高频动作：
排查冲突、看视频时关掉广告拦截、跑测试时关掉脚本注入。这个面板就是为这件事做的。

## 装

1. `git clone` 或直接下载这个仓库
2. 打开 `chrome://extensions`（Edge 是 `edge://extensions`），打开右上角**开发者模式**
3. 点**加载已解压的扩展程序**，选含 `manifest.json` 的那一层目录

会多要一条**「管理您的应用、扩展程序和主题」**授权。这是 `chrome.management` API 要求的——
读别的扩展的状态、改它的开关都得靠它，没有更窄的权限可以申请。

## 用

| 操作 | 怎么做 |
| --- | --- |
| 开关某个扩展 | 点那一行**任意位置**。整行都是热区，不用瞄准右边那个开关 |
| 找扩展 | 面板一打开光标就在搜索框里，直接打字过滤；`/` 随时跳回来 |
| 换排序方式 | 底栏「排序」→ 开着的排前面（默认）/ 按名称 / 最近开启的排前面 |
| 全部关 / 全部开 | 底栏左边两个按钮 |
| 撤销 | 底栏那个「撤销」，退掉**上一次批量操作** |
| 键盘 | `↑` `↓` 移动，空格 / 回车切换 |

点开关时那一行会**浮起来、飞过去、落回**新位置，一共 400ms；被挤动的行同时滑过去让位。
系统开了「减少动态效果」就不播动画，直接到位。

排序方式记在 `storage.local`，关掉面板、重启浏览器都还在。

## 开发

需要本机有 Chrome（不在标准路径就设 `CHROME_PATH`）。

```bash
# 造假扩展当测试数据——无头跑的是全新 profile，不装的话列表永远是空的
uv run --with pillow python test/make-fixtures.py --many 10

# 全部验收：18 条场景，约 1 分钟（--verbose 连原始输出一起打）
node test/check.mjs

# 单独用驱动，改完之后肉眼看
node test/popup-drive.mjs --fixtures --headful
node test/popup-drive.mjs --fixtures --click "text=排序" --shot out.png
node test/popup-drive.mjs --fixtures --dark --shot out.png
```

改图标：`uv run --with pillow python tools/make-icons.py`。

```
manifest.json         权限只有 management + storage；没有后台脚本、没有内容脚本
popup.html/.css/.js   面板的全部逻辑
icons/                图标（tools/make-icons.py 生成）
test/check.mjs        验收：18 条场景
test/popup-drive.mjs  无头驱动：装扩展、开 popup、点击、求值、截图
test/make-fixtures.py 造假扩展当测试数据
docs/design.md        设计取舍、实测结论、没验到的部分
```

验收里最要紧的两条：**界面上的开关状态必须跟 `chrome.management` 报的真实状态一致**
（只看界面会假通过），以及**重排动画的三段要逐帧量对**（只看"顺序变了"分不出滑过去还是
跳过去）。为什么这么验、哪些是实测出来的结论、哪些还没验，全在
[docs/design.md](docs/design.md)。

## 已知边界

- 停不掉自己，面板里也不列自己。
- 面板打开期间装了 / 卸了扩展，要重开面板才更新。
- 内置扩展（`mayDisable === false`，比如 PDF 阅读器）只能跳过，浏览器不许关。
- 重排不带动滚动：飞到视野外面去的那一行不会把面板滚过去。
- 排序菜单浮在列表上，扩展少的时候会盖住靠下的几行。
- 没做预设组、键盘快捷键、站点级开关。

## 许可

MIT

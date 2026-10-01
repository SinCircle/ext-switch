# 扩展开关

点一下工具栏图标，弹出一个小面板，逐个开关**别的**扩展。

A tiny Chrome/Edge popup (Manifest V3) to toggle your *other* extensions — one click per
extension, batch on/off, undo, three sort modes, and a reorder animation that picks the row up
and puts it down in its new place.

Chrome 和 Edge 同一份代码，MV3。没有后台脚本、没有内容脚本，权限只有 `management` + `storage`。

## 装

1. 打开 `chrome://extensions`（Edge 是 `edge://extensions`）
2. 右上角打开 **开发者模式**
3. 点 **加载已解压的扩展程序**，选这个仓库的目录（就是含 `manifest.json` 的那一层）

装的时候会多要一条 **「管理您的应用、扩展程序和主题」** 的授权。这是 `chrome.management`
API 自身要求的，读别的扩展的状态、改它的开关都得靠它，没有更窄的权限可以申请。

## 用

| 操作 | 怎么做 |
| --- | --- |
| 开关某个扩展 | 点那一行**任意位置**（整行都是热区，不用瞄准右边那个 30px 的开关） |
| 找扩展 | 面板一打开光标就在搜索框里，直接打字过滤（大小写不敏感），`/` 随时跳回来；清空点右边那个 ×（不给 `Esc` 绑清空——`Esc` 关掉 popup 是浏览器级行为，两个动作会叠在一起） |
| 换排序方式 | 底部右边「排序」→ 弹出一列选一项。默认 **开着的排前面**，另有 **按名称** 和 **最近开启的排前面** |
| 全部关 / 全部开 | 底部左边两个按钮 |
| 撤销 | 底部右边那个，退掉**上一次批量操作** |
| 键盘走列表 | `↑` `↓` 移动，空格 / 回车切换；排序菜单开着时 `↑` `↓` 在菜单里走 |

**开关和排序都有动画**：点一下，那一行会**浮起来**（放大一点、往上抬一点、投出一层淡影）→ **飞过去** → **落回**新位置（开着的往上、关掉的往下），一共 400ms。同一组里被挤动的行只是平着滑过去让位，不加任何装饰——全都做成带影子的卡片的话，一片行互相盖来盖去，反而看不清动的是哪一个。全部开 / 全部关 / 撤销没有"点的那一行"可言，所以只是整片平着滑。系统开了「减少动态效果」就完全不滑，直接到位。

**排序方式存在 `storage.local`**，所以关掉面板、重启浏览器都还是你选的那个。其中「最近开启」需要额外记一份「哪个扩展上次被**这个面板**打开过、什么时候」——在被面板打开时记下时刻、关掉时作废，存在同一处。在 `chrome://extensions` 里手动开的扩展不记（那会儿面板没在跑，无从知道时刻），它们按名字排在"最近开启"那一档后面。

**撤销的边界**：它只记批量操作。逐条点开关不进这个记录——要退回来就再点一下那个开关。
快照存在 `storage.session` 里，所以关掉面板再打开撤销还亮着；浏览器一重启就过期。
快照连每个扩展「上次被打开的时刻」一起存，所以撤销之后顺序也回到动之前的样子。
已经全关的时候再点「全部关」不会假装做了事，也不会把快照冲掉。

## 界面上几个刻意的决定

- **开关不用蓝绿**。亮色模式「开」是墨黑，深色模式反相成近白，唯一的颜色留给焦点环和
  错误提示。换来的是：开着的行名字是墨色，关掉的压暗一档，整列扫下来就知道哪些在跑。
- **只列 `type === "extension"`**。应用和主题不算插件。
- **`mayDisable === false` 的内置扩展不列**（PDF 阅读器之类，用户本来也关不掉），
  改成在列表底部说明「已跳过 N 个」，免得有人来找。
- **排序默认「开着的排前面」**：组内按 `zh-Hans-CN`（中文名按拼音排前面，拉丁名 A–Z 在后面，
  跟浏览器自己的中文排序一致，所以位置能形成肌肉记忆）。想回到"开着的关着的一起按名字排"
  就在排序菜单里选「按名称」。
- **重排不是瞬移，是"拎起来放过去"**：点的那一行先浮起来，再飞过去，最后落回原尺寸。
  浮起来那一行的底色临时换成悬停色、并抬到最上层——不换的话它从邻居的文字上面碾过去，
  两行字会糊在一起。**让位的行什么都不加**，就是平着滑。
- **图标优先用扩展自己声明的**；取不到就退回一个按名字取首字的瓦片。
- 不列自己——自己停不掉自己。

## 目录

```
manifest.json      权限只有 management + storage；没有后台脚本、没有内容脚本
popup.html/.css/.js  全部逻辑都在这里
icons/             由 tools/make-icons.py 生成
tools/make-icons.py
test/check.mjs     验收入口
test/popup-drive.mjs  无头驱动：装扩展、开 popup、点击、求值、截图
test/make-fixtures.py 造假扩展当测试数据
docs/design.md     设计取舍与验证记录（为什么这么写、哪些是实测出来的、验证到哪一步）
```

## 开发和验证

```bash
# 生成图标（改了 tools/make-icons.py 之后）
uv run --with pillow python tools/make-icons.py
uv run --with pillow python tools/make-icons.py --sheet icons/_sheet.png   # 出对照图，肉眼验

# 造假扩展当测试数据（无头跑的是全新 profile，不装的话列表永远是空的）
uv run --with pillow python test/make-fixtures.py --many 10

# 全部验收，跑一遍约 1 分钟
node test/check.mjs
node test/check.mjs --verbose     # 连原始输出一起打

# 单独用驱动，改完之后肉眼看
node test/popup-drive.mjs --fixtures --dump
node test/popup-drive.mjs --fixtures --fixtures-many --shot out.png
node test/popup-drive.mjs --fixtures --dark --shot out.png
node test/popup-drive.mjs --fixtures --click "text=全部关" --click "text=撤销" --dump
node test/popup-drive.mjs --fixtures --headful          # 想手点时用
node test/popup-drive.mjs --fixtures --click "text=排序" --shot out.png   # 看排序菜单
node test/popup-drive.mjs --fixtures --reduce-motion --dump               # 模拟「减少动态效果」
node test/popup-drive.mjs --fixtures --click "row=Alpha Notes" --probe-anim --dump  # 量重排动画
```

`node test/check.mjs` 每次都是全新的临时 Chrome profile，场景之间不会互相污染。最要紧的
一条断言是 **界面上的开关状态跟 `chrome.management` 报的真实状态必须一致**——只看界面
会假通过，UI 翻了而扩展其实没被停用是最容易漏的失败。

另一条是**动画**：不光要"顺序变了"，还要"第一帧的位移等于前后两次实测位置之差、从旧位置
起手、并且那个动画真的跑完了"（`--probe-anim` 把 `Element.prototype.animate` 包一层来量）。
只看"`animate()` 被调用过"会假通过——先瞬移、再在原地做一次 0 位移的动画也能骗过去。

这个 profile 里还会混进外界装的扩展——Chrome 会把注册表里声明成「外部扩展」的那些装进每一个
新 profile（实测本机那台是 IDM）。它比面板第一次读列表晚一两秒落地，而面板只在打开时读一次，
所以同一次跑里开头的 dump 是 4 行、`reload` 之后会变成 5 行。所以顺序类断言只比对自己那 4 个
假扩展（"不列自己"和"界面与真实状态一致"两条仍然跑全表），那是环境在变，不是面板的行为。

## 已知边界

- 停不掉自己，面板里也不列自己。
- 批量操作对每个扩展是串行 `setEnabled`，上百个会慢；换来的是单个失败能精确定位。
- 面板打开期间有扩展被装上/卸掉，列表要重开才更新（面板存活只有几秒，不值得为它加监听）。
- 内置扩展（`mayDisable === false`）只能跳过、不能开关，这是浏览器的限制。
- **滑到视野外面不自动滚**。列表滚下去以后把一行打开、它飞到顶部离屏了，面板不会跟着滚
  （要正确就得先算目标位置再滚，多一层两阶段计算；列表最高 480px，顶部那组多数在视野里，
  不值这个复杂度）。想找回它就滚一下或搜名字。
- **排序菜单是浮在列表上的**，所以行数很少时它会盖住靠下的那几行；点菜单外面（包括被盖住的
  那几行）只关菜单，不会顺手把底下那一行打开或关掉。
- 没做预设组、键盘快捷键、站点级开关——按「简约」取舍掉的。

## 许可

MIT，见 [LICENSE](LICENSE)。

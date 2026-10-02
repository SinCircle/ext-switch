/* 扩展开关 —— 面板逻辑
 *
 * 只有一个界面：点工具栏图标弹出的小面板。没有后台脚本、没有内容脚本——
 * 面板打开时读一次 chrome.management.getAll()，关掉就什么都不剩（除了下面那两份偏好，
 * 它们本来就该留着）。
 *
 * 三个状态来源要分清：
 *   1. items        面板自己记的当前状态（点开关就改它，不重新读一遍）
 *   2. storage.session 里的一份快照，只存「上一次批量操作之前的样子」，给撤销用
 *   3. chrome.management 的真实状态
 * 平时以 1 为准，因为 setEnabled 之后立刻 getAll() 不保证已经反映新值；
 * 只在「别的地方也改了扩展」（onEnabled / onDisabled）时才去对齐 3。
 *
 * 另外两份存在 storage.local 的偏好（跟面板同寿不如跟浏览器同寿）：
 *   sort    排序方式，见 SORTS
 *   recent  每个扩展「上次被面板打开」的时刻，给「最近开启的排前面」用
 *
 * 面板上有两处菜单：底栏「排序」，和右键某一行的动作菜单。它们共用同一套「只开一个、
 * 点外面那一下吃掉、方向键在项之间走」的处理，见下面「菜单」那一节。
 */
'use strict';

const SELF_ID = chrome.runtime.id;
const SNAPSHOT_KEY = 'undoSnapshot';
const SORT_KEY = 'sort';
const RECENT_KEY = 'recent';

/* 按名字排：中文按拼音排在前，拉丁 A–Z 在后，希腊字母垫底（localeCompare 的 zh 规则）。
 * 名字完全一样时用 id 兜底，保证顺序是确定的——不然同分的行每次排出来的位置可能不同，
 * 看起来就像列表自己在抖。 */
function byName(a, b) {
  return a.name.localeCompare(b.name, 'zh-Hans-CN', { numeric: true, sensitivity: 'base' })
    || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
}

/* 「最近开启」只在开着的里面分两档：有开启时刻的（面板打开过）排前面，按时刻倒序；
 * 没有的（浏览器启动时本来就开着的，或者别处打开的）按名字排在后面。
 * 关着的没有"最近开启"可言，所以它们全都归到最后一档去按名字排。 */
const timed = (it) => (it.onAt ? 0 : 1);

const SORTS = [
  { id: 'on-first', cmp: (a, b) => (b.on - a.on) || byName(a, b) },
  { id: 'name', cmp: byName },
  {
    id: 'recent',
    cmp: (a, b) => (b.on - a.on) || (timed(a) - timed(b))
      || ((b.onAt || 0) - (a.onAt || 0)) || byName(a, b),
  },
];

const prefersReduced = () => matchMedia('(prefers-reduced-motion: reduce)').matches;

const el = {
  list: document.getElementById('list'),
  q: document.getElementById('q'),
  clear: document.getElementById('clear'),
  empty: document.getElementById('empty'),
  note: document.getElementById('hidden-note'),
  loading: document.getElementById('loading'),
  toast: document.getElementById('toast'),
  allOff: document.getElementById('all-off'),
  allOn: document.getElementById('all-on'),
  undo: document.getElementById('undo'),
  sort: document.getElementById('sort'),
  menu: document.getElementById('sort-menu'),
  rowMenu: document.getElementById('row-menu'),
};

/** @type {{id:string,name:string,on:boolean,onAt?:number,icon:string|null,optionsUrl:string,homepageUrl:string,fromStore:boolean,row:HTMLElement,sw:HTMLElement}[]} */
const items = [];
const byId = new Map();

let sortId = SORTS[0].id;
/** 扩展 id → 上次被面板打开的时刻。真源在 storage.local，内存这份是它的镜像。 */
let recent = {};

// ── 读扩展 ─────────────────────────────────────────────────────────

/* 只列 type === "extension" 的：应用（packaged_app 等）和主题不在「插件」范围内。
 * mayDisable === false 的是浏览器内置的组件扩展（PDF 阅读器之类），用户本来也关不掉，
 * 列出来只会白占地方 —— 数一下，在列表底部说明「已跳过 N 个」，免得有人来找。
 * 也排除自己：自己停不掉自己。 */
async function readExtensions() {
  const all = await chrome.management.getAll();
  const mine = [];
  let locked = 0;
  for (const e of all) {
    if (e.type !== 'extension' || e.id === SELF_ID) continue;
    if (!e.mayDisable) { locked++; continue; }
    mine.push({
      id: e.id, name: e.name || e.id, on: e.enabled, icon: pickIcon(e.icons),
      // 下面这三样只有右键菜单用得上：有没有选项页/主页，是不是商店装的
      // （商店那条链接对开发方式装的扩展是个 404 页面，所以那种情形干脆不给这一项）
      optionsUrl: e.optionsUrl || '',
      homepageUrl: e.homepageUrl || '',
      fromStore: e.installType === 'normal',
    });
  }
  return { mine, locked };   // 不在这儿排：排序方式是可配的，交给 resort()
}

/* 显示尺寸是 18px（高分屏上 36 物理像素），所以优先挑 32 那一档；
 * 只有小图或只有大图时退而求其次用最大的。 */
function pickIcon(icons) {
  if (!icons || !icons.length) return null;
  const bySize = [...icons].sort((a, b) => a.size - b.size);
  return (bySize.find((i) => i.size >= 32) || bySize[bySize.length - 1]).url;
}

// ── 建行 ───────────────────────────────────────────────────────────

/* 别的扩展的图标能不能直接 <img> 加载，取决于对方有没有把它声明成
 * web_accessible_resources —— 申请不到就退回字符瓦片。所以这里不赌，
 * 两条路都铺好：加载失败当场换成瓦片。 */
function makeIcon(it) {
  if (!it.icon) return tile(it.name);
  const img = document.createElement('img');
  img.className = 'fav';
  img.alt = '';
  img.src = it.icon;
  img.addEventListener('error', () => img.replaceWith(tile(it.name)), { once: true });
  return img;
}

function tile(name) {
  const d = document.createElement('span');
  d.className = 'tile';
  d.textContent = initial(name);
  return d;
}

/* 取一个能代表名字的字符：优先第一个汉字或字母数字，都没有就取首字符。 */
function initial(name) {
  const s = (name || '').trim();
  if (!s) return '?';
  const m = s.match(/[\p{Script=Han}A-Za-z0-9]/u);
  return (m ? m[0] : s[0]).toUpperCase();
}

function buildRow(it) {
  const li = document.createElement('li');
  li.className = 'row';
  li.dataset.on = it.on ? '1' : '0';
  li.dataset.id = it.id;

  const sw = document.createElement('button');
  sw.type = 'button';
  sw.className = 'sw';
  sw.setAttribute('role', 'switch');
  sw.setAttribute('aria-checked', String(it.on));
  sw.setAttribute('aria-label', it.name);
  sw.title = it.name;

  /* 点击挂在整行上，不挂在开关上：开关只有 30×18，整行是 288×38；
   * 后者不用瞄准，快得多。开关自己的点击冒泡上来也走这一条，所以不会翻两次。
   * 键盘操作照旧——<button> 拿到回车/空格后触发的 click 也从这里走。
   * 菜单开着的时候这一行收不到 click：「点菜单外面只关菜单」那条监听挂在捕获阶段，
   * 会把这一下吃掉（所以点被右键的那一行也只是收起菜单，不会顺手把开关翻了）。 */
  li.addEventListener('click', () => toggle(it));

  li.append(makeIcon(it), Object.assign(document.createElement('span'),
    { className: 'name', textContent: it.name }), sw);
  it.row = li;
  it.sw = sw;
  return li;
}

function paint(it) {
  it.row.dataset.on = it.on ? '1' : '0';
  it.sw.setAttribute('aria-checked', String(it.on));
}

// ── 排序 / 重排动画 ────────────────────────────────────────────────

/* 重排动画的节拍。被点的那一行分三段走完：**浮起来**（放大一点、往上升一点、投出淡影）→
 * **飞过去**（就浮着横越到新位置）→ **降下去**（落回原尺寸、影子收掉，停在原地）。
 * 一开始写的是 220ms 直接滑过去，太快：看不出动的是哪一个，也没有"被拎起来"的质感。 */
const FLY_MS = 400;
const FLY_HOP = 4;      // 浮起来那一下往上抬几 px
const FLY_GROW = 1.04;  // 浮起来时放大到几倍
const NO_SHADOW = '0 0 0 rgba(0, 0, 0, 0)';

const cmpNow = () => SORTS.find((s) => s.id === sortId).cmp;

/* 改一行的开关状态，同时管住「最近开启」那个时刻：
 * 打开就记下现在，关掉就把时刻作废（关着的没有"最近开启"可言）。
 * 撤销要还原到"当时是什么样"，包括时刻，所以时刻得能指定，不能一律用 now。 */
function apply(it, on, onAt) {
  it.on = on;
  if (on && onAt) {
    it.onAt = onAt;
    recent[it.id] = onAt;
  } else {
    delete it.onAt;
    delete recent[it.id];
  }
  paint(it);
}
const setOn = (it, on) => apply(it, on, on ? Date.now() : undefined);
const saveRecent = () => chrome.storage.local.set({ [RECENT_KEY]: recent });

/* 按当前排序方式重排整个列表，并让移动过的行滑到新位置（FLIP）。
 *
 * 三段：改顺序**前**量一次每行的位置 → 改 DOM → 再量一次 → 用两次之差做位移动画。
 * 关键在第一段量的是"眼睛现在看到的位置"：行正在滑的时候 getBoundingClientRect()
 * 把 transform 一起算进去了，所以连点两下能接着滑，不会先跳回起点。
 *
 * liftId 是"用户刚点的那一行"：只有它被抬起来（轻微放大、加一层底色和淡影、放到最上层），
 * 其余的行只是平着滑过去让位，什么装饰都不加。试过全都抬起来——一片行同时变成长着投影的
 * 卡片、还互相盖来盖去，看着一团乱，反而分不清刚动的到底是哪一个。
 *
 * 用 Web Animations API 而不是挂一个 transition 类：动画自己会结束、不残留内联样式，
 * 也不会跟 CSS 打架。反过来它也躲得开 CSS——`prefers-reduced-motion` 那段
 * `animation: none` 拦不住它，所以这里必须自己判一次 matchMedia。 */
function resort(liftId) {
  const animate = !prefersReduced();
  const vis = items.filter((it) => !it.row.hidden);
  const before = new Map();
  if (animate) for (const it of vis) before.set(it.id, it.row.getBoundingClientRect().top);

  items.sort(cmpNow());
  // 隐藏的行也一起排进去：它们不显示，但清空搜索后要落在正确的相对位置上
  el.list.append(...items.map((it) => it.row));
  if (!animate) return;

  const shadow = getComputedStyle(el.list).getPropertyValue('--lift').trim();
  for (const it of vis) {
    const dy = before.get(it.id) - it.row.getBoundingClientRect().top;
    if (Math.abs(dy) < 0.5) continue;         // 位置没变就别做 0 位移的假动画
    const lift = it.id === liftId;

    const frames = lift
      ? [                                                   // 浮起来 → 飞过去 → 降下去
        { offset: 0, transform: `translateY(${dy}px)`, boxShadow: NO_SHADOW, easing: 'ease-out' },
        {
          offset: 0.22,
          transform: `translateY(${dy - FLY_HOP}px) scale(${FLY_GROW})`,
          boxShadow: `0 3px 10px ${shadow}`,
          easing: 'ease-in',
        },
        { offset: 0.7, transform: `translateY(${-FLY_HOP}px) scale(${FLY_GROW})`, boxShadow: `0 3px 10px ${shadow}`, easing: 'ease-out' },
        { offset: 1, transform: 'none', boxShadow: NO_SHADOW },
      ]
      : [                                                   // 让位的：按住不动，等它浮起来再一起滑
        { offset: 0, transform: `translateY(${dy}px)` },
        { offset: 0.22, transform: `translateY(${dy}px)`, easing: 'cubic-bezier(.4, 0, .2, 1)' },
        { offset: 1, transform: 'none' },
      ];

    const fly = it.row.animate(frames, { duration: FLY_MS });
    if (!lift) continue;
    it.row.classList.add('lifted');
    // 连点两下时旧动画会被顶掉（finished 直接 reject），所以收尾要看"这个行身上
    // 还有没有动画在跑"再决定摘不摘 —— 单看自己那一场会被下一场抢先摘掉。
    const done = () => { if (!it.row.getAnimations().length) it.row.classList.remove('lifted'); };
    fly.finished.then(done, done);
  }
}

// ── 动作 ───────────────────────────────────────────────────────────

/* 先动界面再发请求，失败了再翻回来。开关点下去要立刻有反应，
 * 等 setEnabled 回来才动的话手感是黏的。行往哪边滑也是同一拍发生的。 */
async function toggle(it) {
  const next = !it.on;
  setOn(it, next);
  resort(it.id);        // 把这一行拎起来送过去
  await saveRecent();
  try {
    await chrome.management.setEnabled(it.id, next);
  } catch {
    setOn(it, !next);
    resort(it.id);      // 飞回来，比只把开关拨回来更说明"没成"
    await saveRecent();
    toast(`无法${next ? '启用' : '停用'}「${it.name}」`, 'err');
  }
}

/* 批量之前先把「现在是什么样」整份存进 storage.session：
 * 面板一关内存就没了，而撤销恰恰经常发生在关掉再打开之后。
 * session 而不是 local —— 浏览器一重启这份快照就该过期。 */
async function bulk(target) {
  const changed = items.filter((x) => x.on !== target);
  if (!changed.length) {
    toast(target ? '已经全部开启' : '已经全部关闭');
    return;
  }

  await chrome.storage.session.set({
    [SNAPSHOT_KEY]: {
      at: Date.now(),
      // onAt 一起存：撤销要把「最近开启」的顺序也还原，不然撤完顺序是错的
      items: items.map((x) => ({ id: x.id, on: x.on, onAt: x.onAt })),
    },
  });
  el.undo.disabled = false;

  let failed = 0;
  for (const it of changed) {
    setOn(it, target);
    try {
      await chrome.management.setEnabled(it.id, target);
    } catch {
      setOn(it, !target);
      failed++;
    }
  }
  // 重排放在最后一次性做：一条一条排的话，中间那些状态会来回横跳
  resort();
  await saveRecent();
  const verb = target ? '开启' : '关闭';
  toast(failed ? `已${verb} ${changed.length - failed} 个，${failed} 个失败` : `已${verb} ${changed.length} 个`,
    failed ? 'err' : '');
}

async function undo() {
  const rec = (await chrome.storage.session.get(SNAPSHOT_KEY))[SNAPSHOT_KEY];
  if (!rec) return;
  let failed = 0;
  for (const s of rec.items) {
    const it = byId.get(s.id);
    if (!it) continue;                     // 已卸载的，跳过
    const was = { on: it.on, onAt: it.onAt };
    if (was.on === s.on && was.onAt === s.onAt) continue;   // 没动过的，跳过
    apply(it, s.on, s.onAt);
    try {
      await chrome.management.setEnabled(it.id, s.on);
    } catch {
      apply(it, was.on, was.onAt);
      failed++;
    }
  }
  resort();
  await saveRecent();
  // 撤完就清掉：撤销 = 「退掉上一次批量操作」，再点一次没有意义。
  await chrome.storage.session.remove(SNAPSHOT_KEY);
  el.undo.disabled = true;
  toast(failed ? `已撤销，${failed} 个失败` : '已撤销', failed ? 'err' : '');
}

/* 复制扩展 ID。写剪贴板不用额外申请权限（实测），但要求文档有焦点——面板开着的时候
 * 本来就有，所以这条只在"面板根本没在前台"这种不该发生的状态下会失败。 */
async function copyId(it) {
  try {
    await navigator.clipboard.writeText(it.id);
    toast(`已复制「${it.name}」的扩展 ID`);
  } catch (err) {
    toast('复制失败：' + err.message, 'err');
  }
}

/* 卸载。Chrome 卸「别的扩展」时一定会弹它自己的确认框——官方文档写明这种情形下
 * showConfirmDialog 参数被忽略（实测：传 false 也照样弹，探针就挂在那儿不动）。
 * 所以这里不再自己加一道确认，也不去设那个参数。
 * 用户点取消时 promise 会 reject：扩展还在、面板也什么都没改，就静静地不做声——
 * 他刚亲手点了取消，再弹一句"没卸载"是废话。 */
async function uninstall(it) {
  try {
    await chrome.management.uninstall(it.id);
  } catch {
    return;
  }
  it.row.remove();
  items.splice(items.indexOf(it), 1);
  byId.delete(it.id);
  delete recent[it.id];      // 「最近开启」那张表里也把它清掉，不然只涨不消
  await saveRecent();
  el.allOff.disabled = el.allOn.disabled = !items.length;
  filter();                  // 空面板文案、计数都归它管
  toast(`已卸载「${it.name}」`);
}

// ── 过滤 / 提示 ────────────────────────────────────────────────────

function filter() {
  const q = el.q.value.trim().toLowerCase();
  el.clear.hidden = !el.q.value;

  // 一个可开关的都没有：这是空面板，不是"搜索没命中"，两种话说得不一样
  if (!items.length) {
    el.list.hidden = true;
    el.empty.textContent = '没有可开关的扩展';
    el.empty.hidden = false;
    return;
  }

  let shown = 0;
  for (const it of items) {
    const hit = !q || it.name.toLowerCase().includes(q);
    it.row.hidden = !hit;
    if (hit) shown++;
  }
  el.list.hidden = shown === 0;
  el.empty.hidden = shown > 0;
  if (q && !shown) el.empty.textContent = `没有叫「${el.q.value.trim()}」的扩展`;
}

let toastTimer;
function toast(msg, kind = '') {
  el.toast.textContent = msg;
  el.toast.dataset.kind = kind;
  el.toast.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.toast.hidden = true; }, 2600);
}

// ── 菜单（底栏「排序」和右键的动作菜单共用）─────────────────────────

/* 两个菜单要做的是同一件事：同一时刻只开一个、点外面那一下要吃掉、方向键在项之间走。
 * 所以「现在哪个菜单开着」只有这一处状态，事件处理也只有这一份——不把排序菜单那套
 * 照抄一遍。 */
let openMenuEl = null;    // 现在开着的是哪个 <div class="menu">
let menuOwner = null;     // 开它的那个元素：底栏「排序」按钮，或者被右键的那一行

/* 最近一次用的是键盘还是鼠标，挂在根元素的 .kbd 上，CSS 拿它决定菜单项画不画焦点环
 * （见 popup.css 那段注释：光靠 :focus-visible 会把鼠标弹的菜单也画上蓝框）。
 * 右键一定先过 mousedown、Shift+F10 一定先过 keydown，所以这两个事件足够分辨。 */
document.addEventListener('keydown', () => document.documentElement.classList.add('kbd'), true);
document.addEventListener('mousedown', () => document.documentElement.classList.remove('kbd'), true);

function showMenu(node, owner, first) {
  // 已经开着、而且是冲着同一个元素弹的，就不用重来一遍
  if (openMenuEl === node && menuOwner === owner) return;
  hideMenu(false);       // 换一个开（另一个菜单，或者同一份菜单换一行）：焦点马上要给
  node.hidden = false;   // 新菜单，不必先还回去
  openMenuEl = node;
  menuOwner = owner;
  if (owner.hasAttribute('aria-expanded')) owner.setAttribute('aria-expanded', 'true');
  (first || node.querySelector('button')).focus();
}

function hideMenu(refocus = true) {
  if (!openMenuEl) return;
  const owner = menuOwner;
  const wasRowMenu = openMenuEl === el.rowMenu;
  openMenuEl.hidden = true;
  openMenuEl = null;
  menuOwner = null;
  if (owner.hasAttribute('aria-expanded')) owner.setAttribute('aria-expanded', 'false');
  if (wasRowMenu) el.list.querySelector('.row.acting')?.classList.remove('acting');
  // 焦点还给 owner 里的那个按钮：行要还给它右边的开关（行本身不可聚焦），排序按钮
  // 还给它自己（它里面没有别的按钮，querySelector 落空就退回它本身）。
  if (refocus) (owner.querySelector('button') || owner).focus();
}

// ── 底栏「排序」菜单 ───────────────────────────────────────────────

const sortItems = [...el.menu.querySelectorAll('[data-mode]')];

function paintSort() {
  for (const b of sortItems) b.setAttribute('aria-checked', String(b.dataset.mode === sortId));
}

async function pickSort(mode) {
  hideMenu();
  if (mode === sortId) return;
  sortId = mode;
  paintSort();
  await chrome.storage.local.set({ [SORT_KEY]: mode });
  resort();        // 换一种排法＝整个列表大搬家，滑动正好说明发生了什么
}

el.sort.addEventListener('click', () => {
  if (openMenuEl === el.menu) hideMenu();
  else showMenu(el.menu, el.sort, sortItems.find((b) => b.dataset.mode === sortId) || sortItems[0]);
});
for (const b of sortItems) b.addEventListener('click', () => pickSort(b.dataset.mode));

// ── 行的动作菜单（右键 / Shift+F10 / 菜单键）───────────────────────

const STORE = 'https://chromewebstore.google.com/detail/';

const openTab = (url) => chrome.tabs.create({ url });

/* 菜单项就这几条，列出来的顺序就是从上到下的顺序。when 不成立的那项不出现：宁可不显示，
 * 也不给一个点了没反应的项。 */
const ROW_ACTIONS = [
  { label: '打开详情页', run: (it) => openTab('chrome://extensions/?id=' + it.id) },
  { label: '打开选项页', when: (it) => it.optionsUrl, run: (it) => openTab(it.optionsUrl) },
  { label: '打开主页', when: (it) => it.homepageUrl, run: (it) => openTab(it.homepageUrl) },
  { label: '在应用商店中打开', when: (it) => it.fromStore, run: (it) => openTab(STORE + it.id) },
  { label: '复制扩展 ID', run: (it) => copyId(it) },
  { sep: true },
  { label: '卸载', run: (it) => uninstall(it) },
];

/* 项是每次右键现建的：哪几项在，要看那个扩展自己有没有选项页、主页，是不是商店装的。 */
function buildRowMenu(it) {
  const frag = document.createDocumentFragment();
  for (const a of ROW_ACTIONS) {
    if (a.when && !a.when(it)) continue;
    if (a.sep) {
      frag.append(Object.assign(document.createElement('div'), { className: 'sep' }));
      continue;
    }
    const b = document.createElement('button');
    b.type = 'button';
    b.setAttribute('role', 'menuitem');
    b.textContent = a.label;
    b.addEventListener('click', () => { hideMenu(); a.run(it); });
    frag.append(b);
  }
  el.rowMenu.replaceChildren(frag);
}

/* 贴光标摆。先试四个方向——右下、右上、左下、左上——挑第一个整块装得下的；实在都装不下
 * 才收边（菜单比面板还宽或还高，正常不会）。先定水平再定竖直，所以偏好顺序就是文案里
 * 那个：菜单一贯"先往右下弹，下面不够才翻上去"。
 *
 * 每个方向都跟光标留一道缝（GAP）。菜单盖在光标底下的话，下一次点——不管是想点某一项，
 * 还是想点空处把它收起来——落点就已经在菜单里了，很容易点错。先前是"贴边收拢"，右键
 * 行的右半边会撞到右边、被往左推，结果菜单正好压在光标上（实测：在 x=272 右键，菜单
 * 落在 174..294）。 */
function placeRowMenu(x, y) {
  const r = el.rowMenu.getBoundingClientRect();
  const pad = 6;         // 跟面板边缘留的缝
  const gap = 4;         // 跟光标留的缝
  const vw = document.documentElement.clientWidth;
  const vh = document.documentElement.clientHeight;

  const left = x + gap + r.width <= vw - pad ? x + gap : x - gap - r.width;
  const top = y + gap + r.height <= vh - pad ? y + gap : y - gap - r.height;

  // 两边都放不下才收边。真收上了光标可能落进菜单里——面板一共 300 宽，手段只有这些。
  el.rowMenu.style.left = Math.max(pad, Math.min(left, vw - r.width - pad)) + 'px';
  el.rowMenu.style.top = Math.max(pad, Math.min(top, vh - r.height - pad)) + 'px';
}

function openRowMenu(it, x, y) {
  buildRowMenu(it);
  // 先 showMenu 再加高亮：showMenu 会把上一份菜单收掉，收的时候要摘的是**上一行**的
  // 高亮。反过来的话它摘掉的会是刚加上的这一行的。
  showMenu(el.rowMenu, it.row);
  it.row.classList.add('acting');       // 标出这个菜单管的是哪一行
  placeRowMenu(x, y);
}

/* 右键某一行。Shift+F10 和菜单键在浏览器里触发的也是这个事件，所以键盘入口是白拿的
 * ——只是那种情况下事件坐标是 0,0，得改成贴着那一行弹。 */
el.list.addEventListener('contextmenu', (e) => {
  if (!(e.target instanceof Element)) return;
  const row = e.target.closest('.row');
  const it = row && byId.get(row.dataset.id);
  if (!it) return;
  e.preventDefault();                   // 不弹浏览器自己的那份菜单
  const box = row.getBoundingClientRect();
  openRowMenu(it, e.clientX || box.left + 14, e.clientY || box.top + 8);
});

/* 点菜单外面：只关菜单，并且把这一下吃掉——这一下不该再落到别的东西上去（翻开关、
 * 按底栏按钮、跳进搜索框都不行）。所以这个监听挂在捕获阶段：它比行和底栏那两处的
 * 点击处理先跑，stopPropagation() 之后事件就到不了它们。
 * 唯一的例外是菜单自己：那交给菜单项自己的处理（点完关掉、执行）。 */
document.addEventListener('click', (e) => {
  if (!openMenuEl || !(e.target instanceof Element)) return;
  if (e.target.closest('.menu')) return;
  hideMenu(false);
  e.stopPropagation();
}, true);

// ── 起 ─────────────────────────────────────────────────────────────

async function init() {
  const { mine, locked } = await readExtensions();

  // 偏好读一次。排序方式、「最近开启」的时刻都在 local —— 它们该跟着浏览器走，
  // 不是跟着面板走（撤销快照才是只活这一会儿的，所以那个在 session）。
  const saved = await chrome.storage.local.get([SORT_KEY, RECENT_KEY]);
  if (SORTS.some((s) => s.id === saved[SORT_KEY])) sortId = saved[SORT_KEY];
  paintSort();
  const stored = saved[RECENT_KEY] || {};

  items.length = 0;
  byId.clear();
  recent = {};
  for (const it of mine) {
    // 只留还开着的：在别处被关掉的，那个时刻就作废了；已经卸载掉的顺手清掉，
    // 不然这张表只涨不消。
    if (it.on && stored[it.id]) {
      it.onAt = stored[it.id];
      recent[it.id] = stored[it.id];
    }
    items.push(it);
    byId.set(it.id, it);
  }
  if (Object.keys(recent).length !== Object.keys(stored).length) await saveRecent();

  // 先排好再建行，DOM 顺序就是最终顺序。这儿不滑——面板刚开，没有"之前的位置"可言。
  items.sort(cmpNow());
  const frag = document.createDocumentFragment();
  for (const it of items) frag.append(buildRow(it));
  el.list.replaceChildren(frag);

  el.loading.remove();
  if (locked) {
    el.note.textContent = `已跳过 ${locked} 个浏览器内置扩展（无法停用）`;
    el.note.hidden = false;
  }
  el.allOff.disabled = el.allOn.disabled = !items.length;

  // 上次没撤销掉的快照还在，按钮就该是亮的
  const rec = (await chrome.storage.session.get(SNAPSHOT_KEY))[SNAPSHOT_KEY];
  if (rec) el.undo.disabled = false;

  filter();
  el.q.focus();
}

el.q.addEventListener('input', filter);
el.clear.addEventListener('click', () => {
  el.q.value = '';
  filter();
  el.q.focus();
});
el.allOff.addEventListener('click', () => bulk(false));
el.allOn.addEventListener('click', () => bulk(true));
el.undo.addEventListener('click', undo);

/* 别的地方（chrome://extensions、别的扩展管理器）改了状态就跟着对齐，
 * 免得面板里显示的跟真实的不一致。自己调 setEnabled 也会触发这两个事件，
 * 赋的是同一个值，无害。 */
function syncOne(id, on) {
  const it = byId.get(id);
  if (!it || it.on === on) return;
  // 不记时刻：面板没在跑，那次开启是什么时候无从知道（也就排不进"最近开启"）
  apply(it, on);
  resort();
  saveRecent();
}
chrome.management.onEnabled.addListener((info) => syncOne(info.id, true));
chrome.management.onDisabled.addListener((info) => syncOne(info.id, false));

/* 键盘：搜索框里按 ↓ 直接进列表，列表里上下走、空格/回车切换。
 * 开关本身是 <button role="switch">，回车和空格的切换是浏览器给的。
 * 菜单开着的时候方向键归菜单——不然一下会同时挪两处焦点。 */
document.addEventListener('keydown', (e) => {
  if (openMenuEl) {
    if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return;
    e.preventDefault();
    const btns = [...openMenuEl.querySelectorAll('button')];
    const i = btns.indexOf(document.activeElement);
    const step = e.key === 'ArrowDown' ? 1 : -1;
    const next = i < 0 ? (step > 0 ? 0 : btns.length - 1) : i + step;
    if (next >= 0 && next < btns.length) btns[next].focus();
    return;
  }

  const rows = items.filter((it) => !it.row.hidden);
  if (!rows.length) return;

  if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
    const i = rows.findIndex((it) => it.sw === document.activeElement);
    const step = e.key === 'ArrowDown' ? 1 : -1;
    // 不在列表里时：↓ 从头开始，↑ 从尾开始
    const next = i < 0 ? (step > 0 ? 0 : rows.length - 1) : i + step;
    if (next < 0 || next >= rows.length) return;
    e.preventDefault();
    rows[next].sw.focus();
    rows[next].sw.scrollIntoView({ block: 'nearest' });
    return;
  }

  if (e.key === '/' && document.activeElement !== el.q) {
    e.preventDefault();
    el.q.focus();
    el.q.select();
  }
});
/* 特意不给 Escape 绑"清空搜索"：Chrome 里 Escape 关掉 popup 是浏览器级行为，页面拦不住，
 * 两个动作会叠在一起。清空有搜索框右边那个 × 按钮，够用。 */

init().catch((err) => {
  el.loading.textContent = '读不到扩展列表：' + err.message;
});

/* 扩展开关的验收入口：把 test/popup-drive.mjs 当子进程跑一遍，断言它的 [dump] 输出。
 *
 *   node test/check.mjs
 *   node test/check.mjs --verbose     把每条场景的原始输出也打出来
 *
 * 每个场景都是一次独立的无头 Chrome（全新 profile），所以场景之间不会互相污染；
 * 同一个场景里要跑"全关 → 撤销"这种序列，就一次传多个 --click，驱动会每个点完 dump 一次。
 *
 * 最要紧的一条断言是 mismatched===0：界面上的开关状态跟 chrome.management 报的真实
 * 状态必须一致。只看界面会假通过——UI 翻了、扩展其实没被禁用，是最容易漏的失败。
 */
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const DRIVE = join(ROOT, 'test', 'popup-drive.mjs');
const VERBOSE = process.argv.includes('--verbose');
const DETAILS_PAGE = /msedge/i.test(process.env.CHROME_PATH || '')
  ? 'edge://extensions' : 'chrome://extensions';

const FIXTURES = ['网页深色模式与护眼滤镜自动切换工具', 'Alpha Notes', 'Gamma Block', 'β 阅读器']
  .sort((a, b) => a.localeCompare(b, 'zh-Hans-CN', { numeric: true, sensitivity: 'base' }));
const [LONG, ALPHA, GAMMA, BETA] = FIXTURES;   // 名称序：中文 → 拉丁 → 希腊

if (!existsSync(join(ROOT, 'test', 'fixtures', 'alpha-notes'))) {
  console.error('缺 fixtures，先跑：uv run --with pillow python test/make-fixtures.py');
  process.exit(1);
}

function runFull(args) {
  const stdout = execFileSync(process.execPath, [DRIVE, ...args],
    { encoding: 'utf8', cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'] });
  if (VERBOSE) console.log(stdout.trimEnd().split('\n').map((l) => '    | ' + l).join('\n'));
  const pick = (tag) => stdout.split('\n')
    .filter((l) => l.startsWith(tag))
    .map((l) => JSON.parse(l.slice(tag.length)));
  return {
    dumps: pick('[dump] '),
    probes: pick('[probe] '),
    targets: pick('[targets] '),     // 打开着的标签页（传了 --targets 才有）
    keyMenus: pick('[key-menu] '),   // 键盘唤醒菜单时行顶/菜单顶在哪（传了 --key-menu 才有）
    rightClicks: pick('[right-click] '),   // 每次右键点在哪（传了 --right-click 才有）
    evaluations: pick('[eval] '),
  };
}

/* 动画的判据不是"animate() 被调用过"，而是三条一起成立：
 *   1. 第一帧的位移 = 前后两次实测位置之差（跳过去也会画对顺序，这一条才能分开"滑"和"跳"）
 *   2. 起手那一刻的实际位置 = 用户眼睛看到的旧位置（被重排 DOM 掐掉的动画会从新位置起手）
 *   3. 那个动画真的跑完了（被 cancel 的动画 finished 是 reject，不会进 finished）
 * 只看第 1 条的话，"先瞬移、再原地做一次 0 位移动画"也能骗过去。
 *
 * 被点的那一行还多验一件事：它是"浮起来 → 飞过去 → 降下去"三段，不是直接滑过去。
 * 判据是过程中位置得先跑到起点**上方**（浮起来那一下），最后落回新位置。 */
function animProblems(pr) {
  const bad = [];
  for (const a of pr.anims) {
    if (!a.name) continue;
    const dy = pr.before[a.name] - pr.after[a.name];
    const m = /translateY\((-?[\d.]+)px\)/.exec(a.from || '');
    if (!m) { bad.push(`${a.name}: 第一帧不是 translateY（${a.from}）`); continue; }
    if (Math.abs(Number(m[1]) - dy) > 1.5) {
      bad.push(`${a.name}: 第一帧位移 ${m[1]}px，实测前后差 ${dy}px`);
    }
    if (Math.abs(a.startedAt - pr.before[a.name]) > 1.5) {
      bad.push(`${a.name}: 从 ${a.startedAt} 起手，旧位置本是 ${pr.before[a.name]}`);
    }
    if (!pr.finished.includes(a.name)) bad.push(`${a.name}: 动画没跑完（被取消了）`);

    if (!a.tops || !a.tops.length) continue;
    const high = Math.min(...a.tops);
    if (!(high < a.startedAt - 1)) {
      bad.push(`${a.name}: 没"先浮起来"（过程中最高只到 ${high}，起点 ${a.startedAt}）`);
    }
    const end = a.tops[a.tops.length - 1];
    if (Math.abs(end - pr.after[a.name]) > 1) {
      bad.push(`${a.name}: 最后没落到新位置（停在 ${end}，应为 ${pr.after[a.name]}）`);
    }
    if (!(a.ms >= 350)) {
      bad.push(`${a.name}: 动画只有 ${a.ms}ms，太快，看不出"浮起来飞过去再降下去"`);
    }
  }
  return bad;
}

/** 有几行被"拎起来"（第一帧带 scale）——按要求只该有用户点的那一个。 */
const lifted = (pr) => pr.anims.filter((a) => a.tops).length;

/* 那个点（右键的坐标，或者键盘那条路用的锚点）离菜单矩形最近的距离，落在矩形里面算 0。
 * 菜单必须**不盖住**它：盖住了的话，下一次点——不管是想点某一项还是想点空处把菜单收起来
 * ——落点就已经在菜单里了。 */
function distTo(rect, p) {
  const dx = Math.max(rect.left - p.x, 0, p.x - (rect.left + rect.w));
  const dy = Math.max(rect.top - p.y, 0, p.y - (rect.top + rect.h));
  return Math.round(Math.hypot(dx, dy));
}

const ok = (cond, msg) => (cond ? [] : [msg]);

/* 面板只在打开那一刻读一次列表，而 Chrome 会把注册表里声明的"外部扩展"（本机是 IDM）
 * 在新 profile 起来一两秒后装进来 —— 比那次读晚一点。于是同一次跑里，开头的 dump 是
 * 4 行、reload 之后可能变成 5 行：那是环境在变，不是面板的行为。（设计文档里记的
 * 那个"意外发现"就是它。想清掉它不行：management.uninstall 对 sideload 扩展会弹
 * 浏览器级确认框，无头下 await 直接挂死；CDP 的 Extensions.uninstall 又只认 unpacked。）
 * 所以下面这几个取行的方法一律只看我们自己那 4 个假扩展；"不列自己"和"界面与真实状态
 * 一致"两条仍然跑全表——多一行别人的扩展既不该影响它们，也遮不住它们。 */
const ours = (d) => d.rows.filter((r) => FIXTURES.includes(r.name));
const names = (d) => ours(d).map((r) => r.name);
const onState = (d) => ours(d).map((r) => r.ui);
const realState = (d) => ours(d).map((r) => r.real);

/** 每条场景返回"不一致的地方"，空数组就是通过。 */
const CASES = [
  {
    name: '英文浏览器：名称、按钮、菜单自动切换，批量关闭与撤销仍对齐真实状态',
    args: ['--lang', 'en-US', '--fixtures', '--dump', '--eval', `({
      language: chrome.i18n.getUILanguage(), name: chrome.runtime.getManifest().name,
      title: document.title, htmlLanguage: document.documentElement.lang,
      search: el.q.placeholder, searchLabel: el.q.getAttribute('aria-label'),
      buttons: [...document.querySelectorAll('.foot > button')].map(b => b.textContent),
      sortLabels: [...el.menu.querySelectorAll('button')].map(b => b.textContent),
      footerFits: [...document.querySelectorAll('.foot > button')].every(b => b.scrollWidth <= b.clientWidth)
    })`, '--click', '#all-off', '--click', '#undo', '--right-click', 'name=Alpha Notes'],
    check(dumps, probes, targets, keys, rcs, evaluations) {
      const [before, off, undone, menu] = dumps;
      const ui = evaluations[0];
      return [
        ...ok(ui.language === 'en-US' && ui.name === 'Extension Switch'
          && ui.title === ui.name && ui.htmlLanguage === 'en', `英文名称/语言不正确：${JSON.stringify(ui)}`),
        ...ok(ui.search === 'Search extensions' && ui.searchLabel === ui.search, '搜索提示及无障碍标签应为英文'),
        ...ok(JSON.stringify(ui.buttons) === JSON.stringify(['All off', 'All on', 'Undo', 'Sort']), '底栏应为英文'),
        ...ok(JSON.stringify(ui.sortLabels) === JSON.stringify(['Enabled first', 'Name', 'Recently enabled']), '排序菜单应为英文'),
        ...ok(ui.footerFits, '英文底栏按钮不应溢出'),
        ...ok(off.rows.every(r => !r.real) && off.toast === 'Disabled: 4', '全部关应成功并显示英文提示'),
        ...ok(JSON.stringify(onState(undone)) === JSON.stringify(onState(before))
          && undone.toast === 'Changes undone', '撤销应还原状态并显示英文提示'),
        ...ok(JSON.stringify(menu.rowMenu.items) === JSON.stringify([
          'Open details', 'Open options', 'Open homepage', 'Copy extension ID', 'Uninstall'
        ]), `右键菜单未完整翻译：${JSON.stringify(menu.rowMenu.items)}`),
        ...ok(dumps.every(d => d.mismatched === 0), '英文界面与真实扩展状态必须一致'),
      ];
    },
  },
  {
    name: '英文浏览器：搜索无结果时显示英文且保留原始查询',
    args: ['--lang', 'en-GB', '--fixtures', '--type', 'missing-example', '--dump'],
    check([after]) {
      return [
        ...ok(after.shown === 0 && after.emptyMsg === 'No extensions match “missing-example”',
          `空态提示不正确：${after.emptyMsg}`),
      ];
    },
  },
  {
    name: '未支持的浏览器语言：完整回退到英文',
    args: ['--lang', 'fr-FR', '--wait-for', '#empty', '--dump', '--eval', `({
      language: chrome.i18n.getUILanguage(), name: chrome.runtime.getManifest().name,
      htmlLanguage: document.documentElement.lang, search: el.q.placeholder
    })`],
    check([after], probes, targets, keys, rcs, evaluations) {
      const ui = evaluations[0];
      return [
        ...ok(/^fr(?:-|$)/.test(ui.language) && ui.name === 'Extension Switch'
          && ui.htmlLanguage === 'en' && ui.search === 'Search extensions',
          `回退语言不正确：${JSON.stringify(ui)}`),
        ...ok(after.emptyMsg === 'No extensions to manage', '空面板应回退到英文'),
      ];
    },
  },
  {
    name: '列表：只列别的扩展、顺序稳定、图标两条路都对',
    args: ['--fixtures', '--dump'],
    check([d]) {
      return [
        ...ok(ours(d).length === 4, `该列出 4 个假扩展，实际 ${ours(d).length}`),
        ...ok(JSON.stringify(names(d)) === JSON.stringify(FIXTURES),
          `顺序不对：${JSON.stringify(names(d))}`),
        ...ok(!d.rows.some((r) => r.name.includes('扩展开关')), '不该把自己列出来'),
        ...ok((d.rows.find((r) => r.name === 'Alpha Notes') || {}).icon === 'img-ok',
          '带图标的扩展应走 <img> 且真的解码出来'),
        ...ok(ours(d).filter((r) => r.icon === 'tile').length === 3,
          '没图标的三个应退回字符瓦片'),
        ...ok(d.undoEnabled === false, '没批量过，撤销该是灰的'),
      ];
    },
  },
  {
    name: '全部关：界面和真实状态一起翻，撤销点亮',
    args: ['--fixtures', '--dump', '--click', 'text=全部关'],
    check([before, after]) {
      return [
        ...ok(onState(before).every(Boolean), '初始应全开'),
        ...ok(onState(after).every((v) => !v), `全部关后界面应全关，实际 ${JSON.stringify(onState(after))}`),
        ...ok(realState(after).every((v) => !v), '全部关后真实状态也应全关（这里失败＝界面骗人）'),
        ...ok(after.mismatched === 0, `${after.mismatched} 行界面与真实状态不一致`),
        ...ok(after.undoEnabled, '批量之后撤销该点亮'),
        ...ok(after.toast === '已关闭 4 个', `提示该报出关了几个，实际 "${after.toast}"`),
      ];
    },
  },
  {
    name: '撤销：整份还原，撤销变灰',
    args: ['--fixtures', '--dump', '--click', 'text=全部关', '--click', 'text=撤销'],
    check([, , after]) {
      return [
        ...ok(realState(after).every(Boolean), `撤销后真实状态该全开，实际 ${JSON.stringify(realState(after))}`),
        ...ok(after.mismatched === 0, `${after.mismatched} 行界面与真实状态不一致`),
        ...ok(after.undoEnabled === false, '撤销过一次后该变灰'),
      ];
    },
  },
  {
    name: '撤销快照跨"关掉面板再打开"还在',
    args: ['--fixtures', '--dump', '--click', 'text=全部关', '--click', 'reload'],
    check([, , afterReload]) {
      return [
        ...ok(afterReload.undoEnabled, '重载后面板内存清空，但快照在 storage.session 里，撤销该还亮着'),
        ...ok(realState(afterReload).every((v) => !v), '重载后仍应是全关'),
        ...ok(afterReload.mismatched === 0, `${afterReload.mismatched} 行界面与真实状态不一致`),
      ];
    },
  },
  {
    name: '单点一行：点开关本身，只翻那一行，撤销不受影响',
    args: ['--fixtures', '--dump', '--click', 'row=Alpha Notes'],
    check([before, after]) {
      const off = after.rows.filter((r) => !r.ui).map((r) => r.name);
      return [
        ...ok(JSON.stringify(off) === JSON.stringify(['Alpha Notes']),
          `应只关掉 Alpha Notes，实际关掉了 ${JSON.stringify(off)}`),
        ...ok(after.rows.find((r) => r.name === 'Alpha Notes').real === false,
          'Alpha Notes 的真实状态也该是关的'),
        ...ok(after.mismatched === 0, `${after.mismatched} 行界面与真实状态不一致`),
        ...ok(after.undoEnabled === false, '逐条开关不进快照，撤销该保持灰的'),
        ...ok(after.toast === '', `逐条开关成功时不该弹提示，实际 "${after.toast}"`),
        ...ok(before.shown === after.shown, '开关不该让行数变化'),
      ];
    },
  },
  {
    // 整行是 288×38，开关只有 30×18。点名字（离开关很远的地方）也必须能开关，
    // 而且只能翻一次——点击挂在行上、开关的点击冒泡上来，冒泡那条容易写成翻两次。
    name: '点名字（行上任意位置）也能开关，且只翻一次',
    args: ['--fixtures', '--dump', '--click', 'name=Gamma Block'],
    check([, after]) {
      const off = after.rows.filter((r) => !r.ui).map((r) => r.name);
      return [
        ...ok(JSON.stringify(off) === JSON.stringify(['Gamma Block']),
          `应只关掉 Gamma Block（翻两次的话它会原样亮着），实际关掉了 ${JSON.stringify(off)}`),
        ...ok(after.rows.find((r) => r.name === 'Gamma Block').real === false,
          '真实状态也该是关的'),
        ...ok(after.mismatched === 0, `${after.mismatched} 行界面与真实状态不一致`),
      ];
    },
  },
  {
    name: '已经全关时再点全部关：不建快照、不假装做了事，如实说"已经全部关闭"',
    args: ['--fixtures', '--dump', '--click', 'text=全部关', '--click', 'text=撤销',
      '--click', 'text=全部关', '--click', 'text=全部关', '--click', 'text=撤销'],
    check(dumps) {
      const beforeLastUndo = dumps[dumps.length - 2];
      const last = dumps[dumps.length - 1];
      return [
        ...ok(beforeLastUndo.toast === '已经全部关闭',
          `重复点该如实说，实际 "${beforeLastUndo.toast}"`),
        ...ok(beforeLastUndo.undoEnabled, '关过之后撤销该亮着'),
        ...ok(realState(beforeLastUndo).every((v) => !v), '仍是全关'),
        // 关键：那次空点没有覆盖快照，撤销仍然还原到"全开"，而不是停在"全关"
        ...ok(realState(last).every(Boolean),
          `撤销该还原到全开，实际 ${JSON.stringify(realState(last))}`),
        ...ok(last.mismatched === 0, `${last.mismatched} 行不一致`),
      ];
    },
  },
  {
    name: '搜索：打字过滤，大小写不敏感',
    args: ['--fixtures', '--type', 'gam', '--dump'],
    check([d]) {
      return [
        ...ok(ours(d).length === 1 && names(d)[0] === 'Gamma Block',
          `打 gam 该只剩 Gamma Block，实际 ${JSON.stringify(names(d))}`),
      ];
    },
  },
  {
    name: '搜索：没命中给的是"没有叫…的扩展"，不是空面板',
    args: ['--fixtures', '--type', 'zzz', '--dump'],
    check([d]) {
      return [
        ...ok(ours(d).length === 0, `该 0 行，实际 ${ours(d).length}`),
        ...ok(d.emptyMsg.includes('zzz'), `提示该带上关键词，实际 "${d.emptyMsg}"`),
      ];
    },
  },
  {
    // 这条只能看全表：一个假扩展都没装，按名字筛等于没筛。它成立的前提是"面板打开时
    // 外界那个扩展还没装进来"——实测面板页面 150ms 左右读列表、它 700ms 上下才落地。
    // 哪天真挂在这儿，先看是不是这个时序变了，再怀疑面板。
    name: '一个可开关的扩展都没有时，说的是"没有可开关的扩展"',
    args: ['--dump'],
    check([d]) {
      return [
        ...ok(d.shown === 0, `该 0 行，实际 ${d.shown}`),
        ...ok(d.emptyMsg === '没有可开关的扩展', `实际 "${d.emptyMsg}"`),
      ];
    },
  },

  // ── 排序：默认把开着的排前面，方式可配、记得住 ──────────────────────

  {
    name: '默认「开着的排前面」：全开时是纯名称序，关掉中间那个它落到末尾',
    args: ['--fixtures', '--dump', '--click', 'row=Alpha Notes'],
    check([before, after]) {
      return [
        ...ok(JSON.stringify(names(before)) === JSON.stringify(FIXTURES),
          `全开时该跟纯名称序一致，实际 ${JSON.stringify(names(before))}`),
        ...ok(JSON.stringify(names(after)) === JSON.stringify([LONG, GAMMA, BETA, ALPHA]),
          `关掉 Alpha 后它该排到末尾，实际 ${JSON.stringify(names(after))}`),
        ...ok(after.mismatched === 0, `${after.mismatched} 行界面与真实状态不一致`),
      ];
    },
  },
  {
    name: '全部关之后：组内顺序不乱，仍是纯名称序',
    args: ['--fixtures', '--dump', '--click', 'text=全部关'],
    check([, after]) {
      return [
        ...ok(JSON.stringify(names(after)) === JSON.stringify(FIXTURES),
          `全关时该是纯名称序，实际 ${JSON.stringify(names(after))}`),
      ];
    },
  },
  {
    name: '排序方式可配：菜单里选「按名称」，关掉面板再打开依然是它',
    args: ['--fixtures', '--dump', '--click', 'row=Alpha Notes', '--click', 'text=排序',
      '--click', 'text=按名称', '--click', 'reload'],
    check(dumps) {
      const [, afterToggle, opened, afterPick, afterReload] = dumps;
      const alpha = afterReload.rows.find((r) => r.name === ALPHA) || {};
      return [
        ...ok(afterToggle.sort === 'on-first', `默认该是 on-first，实际 "${afterToggle.sort}"`),
        ...ok(opened.menuOpen === true, '点「排序」后菜单该是开着的'),
        ...ok(opened.sort === 'on-first', '只是打开菜单不该改变排序方式'),
        ...ok(afterPick.sort === 'name', `选完该是 name，实际 "${afterPick.sort}"`),
        ...ok(afterPick.menuOpen === false, '选完一项菜单该自己关掉'),
        ...ok(JSON.stringify(names(afterPick)) === JSON.stringify(FIXTURES),
          `换成按名称该回到纯名称序，实际 ${JSON.stringify(names(afterPick))}`),
        ...ok(afterReload.sort === 'name', '排序方式存在 storage.local，重载面板后该还在'),
        ...ok(JSON.stringify(names(afterReload)) === JSON.stringify(FIXTURES),
          `重载后仍该按名称排，实际 ${JSON.stringify(names(afterReload))}`),
        ...ok(alpha.ui === false, '重载后 Alpha 该还是关着的（排序方式不该把它打开）'),
        ...ok(afterReload.mismatched === 0, `${afterReload.mismatched} 行不一致`),
      ];
    },
  },
  {
    name: '「最近开启的排前面」：后开的排前，撤销把顺序一并还原',
    args: ['--fixtures', '--dump', '--click', 'text=全部关', '--click', 'row=Alpha Notes',
      '--click', 'row=Gamma Block', '--click', 'text=排序', '--click', 'text=最近开启的排前面',
      '--click', 'text=撤销'],
    check(dumps) {
      const [, , afterAlpha, afterGamma, , afterRecent, afterUndo] = dumps;
      return [
        ...ok(JSON.stringify(names(afterAlpha)) === JSON.stringify([ALPHA, LONG, GAMMA, BETA]),
          `单独开 Alpha 后它该在最前，实际 ${JSON.stringify(names(afterAlpha))}`),
        ...ok(JSON.stringify(names(afterGamma)) === JSON.stringify([ALPHA, GAMMA, LONG, BETA]),
          `开着的两个该按名称排（此时还是"开着的排前面"），实际 ${JSON.stringify(names(afterGamma))}`),
        ...ok(JSON.stringify(names(afterRecent)) === JSON.stringify([GAMMA, ALPHA, LONG, BETA]),
          `最近开启优先下 Gamma 该在 Alpha 前面，实际 ${JSON.stringify(names(afterRecent))}`),
        ...ok(JSON.stringify(names(afterUndo)) === JSON.stringify(FIXTURES),
          `撤销后该回到全开的名称序，实际 ${JSON.stringify(names(afterUndo))}`),
        ...ok(realState(afterUndo).every(Boolean), '撤销后该全开'),
        ...ok(afterUndo.mismatched === 0, `${afterUndo.mismatched} 行不一致`),
        ...ok(afterUndo.undoEnabled === false, '撤销过一次后该变灰'),
      ];
    },
  },

  // ── 重排动画 ──────────────────────────────────────────────────────

  {
    name: '重排动画：点的那行浮起来→飞过去→降下去，让位的行只平着滑',
    args: ['--fixtures', '--dump', '--click', 'row=Alpha Notes', '--probe-anim'],
    check([, after], [, pr]) {
      return [
        ...ok(pr.anims.length === 3,
          `关掉 Alpha 该有 3 行动（Alpha 往下、它上面两行各上移一格），实际 ${pr.anims.length}`),
        ...ok(lifted(pr) === 1, `被拎起来的该只有点的那一行，实际 ${lifted(pr)} 行`),
        ...ok(names(after).length === 4 && names(after)[3] === ALPHA,
          `顺序不对：${JSON.stringify(names(after))}`),
        ...animProblems(pr),
      ];
    },
  },
  {
    name: '批量操作也滑：全部关时每行各滑各的，但谁也不"浮起来"',
    args: ['--fixtures', '--dump', '--click', 'row=Alpha Notes', '--click', 'text=全部关',
      '--probe-anim'],
    check(dumps, probes) {
      return [
        ...ok(probes[2].anims.length === 3, `该有 3 行动，实际 ${probes[2].anims.length}`),
        ...ok(lifted(probes[2]) === 0,
          '批量是"点了一个按钮"，没有"点的哪一行"可言，不该有行浮起来'),
        ...animProblems(probes[2]),
        ...ok(JSON.stringify(names(dumps[2])) === JSON.stringify(FIXTURES),
          `全部关后该是纯名称序，实际 ${JSON.stringify(names(dumps[2]))}`),
      ];
    },
  },
  {
    name: '系统开了「减少动态效果」：一个动画都不产生，但顺序照样立刻到位',
    args: ['--fixtures', '--dump', '--click', 'row=Alpha Notes', '--probe-anim',
      '--reduce-motion'],
    check([, after], [, pr]) {
      return [
        ...ok(pr.anims.length === 0, `减少动态效果时不该有动画，实际 ${pr.anims.length} 个`),
        ...ok(JSON.stringify(names(after)) === JSON.stringify([LONG, GAMMA, BETA, ALPHA]),
          `顺序该照样变，实际 ${JSON.stringify(names(after))}`),
        ...ok(after.mismatched === 0, `${after.mismatched} 行不一致`),
      ];
    },
  },
  {
    // 点最上面那行：菜单挂在底栏上方，行数少时它盖住的是靠下的几行，最上面那行
    // 永远露在外面——也正是用户会去点的地方。点被盖住的那几行是没用的：那一下落在
    // 菜单自己的底色上，本来就该算"点菜单内部"。
    name: '菜单开着时点别处：只关菜单，不顺手把底下那一行的开关翻掉',
    args: ['--fixtures', '--dump', '--click', 'text=排序', '--click', `name=${LONG}`],
    check(dumps) {
      const [, opened, after] = dumps;
      const top = after.rows.find((r) => r.name === LONG) || {};
      return [
        ...ok(opened.menuOpen === true, '点「排序」后菜单该开着'),
        ...ok(after.menuOpen === false, '点别处菜单该关掉'),
        ...ok(top.ui === true && top.real === true,
          `这一下只该关菜单，最上面那行不该被翻掉（界面 ${top.ui}／真实 ${top.real}）`),
        ...ok(after.mismatched === 0, `${after.mismatched} 行不一致`),
        ...ok(JSON.stringify(names(after)) === JSON.stringify(names(opened)),
          '这一下不该让任何一行换位置'),
      ];
    },
  },

  // ── 右键的动作菜单 ────────────────────────────────────────────────

  {
    // 菜单项是"按这个扩展自身的情况"定的：alpha 有选项页也有主页，所以五项都在，
    // 唯独没有「在应用商店中打开」——它是开发方式装的，那条链接对它是个 404 页面。
    // 面板的视口就是 300×560（驱动的默认），菜单整块得落在里面。
    name: '右键某一行：菜单按这个扩展自己的情况列项，且不碰开关',
    args: ['--fixtures', '--dump', '--right-click', `name=${ALPHA}`],
    check([before, after], probes, targets, keys, rcs) {
      const rm = after.rowMenu;
      return [
        ...ok(rm.open === true, '右键之后菜单该是开着的'),
        ...ok(JSON.stringify(rm.items) === JSON.stringify(
          ['打开详情页', '打开选项页', '打开主页', '复制扩展 ID', '卸载']),
          `菜单项不对：${JSON.stringify(rm.items)}`),
        ...ok(rm.acting === ALPHA, `菜单该冲着 Alpha 那一行，实际 "${rm.acting}"`),
        ...ok(!!rm.rect && rm.rect.left >= 0 && rm.rect.top >= 0
          && rm.rect.left + rm.rect.w <= after.viewport.w
          && rm.rect.top + rm.rect.h <= after.viewport.h,
          `菜单该整块落在面板里（面板 ${after.viewport.w}×${after.viewport.h}），实际 ${JSON.stringify(rm.rect)}`),
        // 菜单跟光标留一道缝：既不许盖住它（盖住了下一次点就点在菜单上），也不许跑太远
        // ——右半边那两处靠的是"往另一侧弹"，不是"整块缩到面板里"（见下面两条场景）
        ...ok(!!rm.rect && distTo(rm.rect, rcs[0]) > 0,
          `菜单不该盖住光标（右键在 ${rcs[0].x},${rcs[0].y}，菜单 ${JSON.stringify(rm.rect)}）`),
        ...ok(!!rm.rect && distTo(rm.rect, rcs[0]) <= 8,
          `菜单该紧挨着光标，实际隔了 ${rm.rect ? distTo(rm.rect, rcs[0]) : '?'}px`),
        // 鼠标右键弹出来的菜单不该顶着焦点环（虽然焦点确实挪进了菜单，方向键要用）
        ...ok(after.activeOutline === 'none',
          `鼠标右键弹的菜单不该有焦点环，实际 "${after.activeOutline}"`),
        ...ok(JSON.stringify(onState(after)) === JSON.stringify(onState(before)),
          '右键不该翻任何一行的开关'),
        ...ok(after.mismatched === 0, `${after.mismatched} 行不一致`),
      ];
    },
  },
  {
    name: '没有选项页也没有主页的扩展：那两项根本不出现',
    args: ['--fixtures', '--dump', '--right-click', `name=${GAMMA}`],
    check([, after]) {
      return [
        ...ok(JSON.stringify(after.rowMenu.items) === JSON.stringify(
          ['打开详情页', '复制扩展 ID', '卸载']),
          `菜单项不对：${JSON.stringify(after.rowMenu.items)}`),
      ];
    },
  },
  {
    // 菜单开着的时候直接右键另一行：菜单该跟着换行，高亮也只该留一处。
    // 这条守的是一个具体写法：showMenu 只比"要开的那个菜单是不是同一个"就提前返回的话，
    // 第二行看着弹了菜单，其实菜单还挂在第一行名下。
    name: '右键换一行：菜单跟着换行，高亮只留一处',
    args: ['--fixtures', '--dump', '--right-click', `name=${ALPHA}`,
      '--right-click', `name=${GAMMA}`],
    check(dumps) {
      const after = dumps[2];
      return [
        ...ok(after.rowMenu.acting === GAMMA, `该换成 Gamma 那一行，实际 "${after.rowMenu.acting}"`),
        ...ok(after.rowMenu.items.length === 3, '菜单内容也该换成 Gamma 的（三项）'),
        ...ok(after.mismatched === 0, `${after.mismatched} 行不一致`),
      ];
    },
  },
  {
    name: '复制扩展 ID：写进剪贴板的是那个 id，菜单自己收起来',
    args: ['--fixtures', '--dump', '--probe-clipboard', '--right-click', `name=${ALPHA}`,
      '--click', 'text=复制扩展 ID'],
    // 三次 dump：开菜单之前、右键之后、点完菜单项之后。要的是最后那一份。
    check([before, , after]) {
      const alpha = before.rows.find((r) => r.name === ALPHA) || {};
      return [
        ...ok(JSON.stringify(after.copied) === JSON.stringify([alpha.id]),
          `该把 Alpha 的 id 写进剪贴板，实际 ${JSON.stringify(after.copied)}`),
        ...ok(after.rowMenu.open === false, '做完菜单该自己收起来'),
        ...ok(after.toast.includes('已复制'), `该给一句提示，实际 "${after.toast}"`),
        ...ok(JSON.stringify(onState(after)) === JSON.stringify(onState(before)),
          '复制不该碰开关'),
        ...ok(after.mismatched === 0, `${after.mismatched} 行不一致`),
      ];
    },
  },
  {
    // 三项「打开」各自开到对的地方。判据在浏览器那一侧：真的多出来那几个标签页
    // ——面板自己没申请 tabs 权限，读不到 tab 的 url，所以是驱动从浏览器那侧读的。
    name: '打开详情页 / 选项页 / 主页：各自开出对应的标签页',
    args: ['--fixtures', '--dump', '--targets',
      '--right-click', `name=${ALPHA}`, '--click', 'text=打开详情页',
      '--right-click', `name=${ALPHA}`, '--click', 'text=打开选项页',
      '--right-click', `name=${ALPHA}`, '--click', 'text=打开主页'],
    check(dumps, probes, targets) {
      const id = (dumps[1].rows.find((r) => r.name === ALPHA) || {}).id;
      const has = (t, s) => t.some((u) => u.includes(s));
      return [
        ...ok(!has(targets[0], DETAILS_PAGE) && !has(targets[0], 'options.html')
          && !has(targets[0], 'example.com'), '一开始不该开着这些标签页'),
        ...ok(has(targets[2], DETAILS_PAGE + '/?id=' + id),
          `详情页没开出来：${JSON.stringify(targets[2])}`),
        ...ok(has(targets[4], 'chrome-extension://' + id + '/options.html'),
          `选项页没开出来：${JSON.stringify(targets[4])}`),
        ...ok(has(targets[6], 'https://example.com/alpha-notes'),
          `主页没开出来：${JSON.stringify(targets[6])}`),
        ...ok(dumps[6].mismatched === 0, `${dumps[6].mismatched} 行不一致`),
      ];
    },
  },
  {
    name: '动作菜单开着时点别处：只关菜单，不顺手把底下那一行的开关翻掉',
    args: ['--fixtures', '--dump', '--right-click', `name=${ALPHA}`, '--click', `name=${LONG}`],
    check(dumps) {
      const [before, opened, after] = dumps;
      return [
        ...ok(opened.rowMenu.open === true, '右键后菜单该开着'),
        ...ok(after.rowMenu.open === false, '点别处菜单该关掉'),
        ...ok(JSON.stringify(onState(after)) === JSON.stringify(onState(before)),
          '这一下只该关菜单，不该翻任何一行'),
        ...ok(after.mismatched === 0, `${after.mismatched} 行不一致`),
      ];
    },
  },
  {
    // 菜单开着的时候，点哪儿都只该关掉菜单：底栏按钮不该被按到、搜索框不该跳进去、
    // 连**被右键的那一行自己**也不该顺手开关（这一条是实测后改的：原来把"开菜单的那个
    // 元素"当例外放行了，结果右键盘完想点一下收起来，反倒把开关翻了）。
    name: '动作菜单开着时，点哪儿都只关菜单：底栏按钮、搜索框、被右键的那一行都不触发',
    args: ['--fixtures', '--dump',
      '--right-click', `name=${ALPHA}`, '--click', '#q',
      '--right-click', `name=${ALPHA}`, '--click', 'text=全部开',
      '--right-click', `name=${ALPHA}`, '--click', `row=${ALPHA}`],
    check(dumps) {
      const before = dumps[0];
      const what = ['搜索框', '底栏「全部开」', '被右键的那一行（它自己的开关）'];
      const bad = [];
      [2, 4, 6].forEach((i, k) => {
        const d = dumps[i];
        bad.push(...ok(d.rowMenu.open === false, `点${what[k]}之后菜单该关掉`));
        bad.push(...ok(JSON.stringify(onState(d)) === JSON.stringify(onState(before)),
          `点${what[k]}只该关菜单，不该翻任何一行`));
        bad.push(...ok(d.toast === '', `点${what[k]}不该触发任何动作，实际弹了 "${d.toast}"`));
        bad.push(...ok(d.mismatched === 0, `${d.mismatched} 行不一致`));
      });
      return bad;
    },
  },
  {
    // 卸载在这一档是**打桩**的：真调用一定会弹 Chrome 自己的确认框（官方文档写明
    // "扩展卸别的扩展时 showConfirmDialog 参数被忽略"），无头下没人点它、await 直接挂死。
    // 所以这条验的是面板那笔账——行消失、计数对齐、提示如实——不是 Chrome 真把扩展卸掉了。
    name: '卸载：那一行从列表里消失，别的行不动，提示如实',
    args: ['--fixtures', '--dump', '--probe-uninstall', 'resolve',
      '--right-click', `name=${GAMMA}`, '--click', 'text=卸载'],
    // 三次 dump：开菜单之前、右键之后、点「卸载」之后。看最后那一份。
    check([before, , after]) {
      const gamma = before.rows.find((r) => r.name === GAMMA) || {};
      return [
        ...ok(JSON.stringify(after.uninstalled) === JSON.stringify([gamma.id]),
          `该把 Gamma 的 id 交给 management.uninstall，实际 ${JSON.stringify(after.uninstalled)}`),
        ...ok(after.shown === 3, `该剩 3 行，实际 ${after.shown}`),
        ...ok(!names(after).includes(GAMMA), 'Gamma 该从列表里消失'),
        ...ok(after.toast === `已卸载「${GAMMA}」`, `提示不对：${JSON.stringify(after.toast)}`),
        ...ok(after.mismatched === 0, `${after.mismatched} 行不一致`),
      ];
    },
  },
  {
    // 用户在 Chrome 那个确认框里点了取消（promise reject）：什么都没变，就什么都不说。
    // 他刚亲手点了取消，再弹一句"没卸载"是废话——这条守着的就是"别多嘴"。
    name: '卸载被取消：列表和状态一点不动，也不弹提示',
    args: ['--fixtures', '--dump', '--probe-uninstall', 'reject',
      '--right-click', `name=${GAMMA}`, '--click', 'text=卸载'],
    check([before, , after]) {
      return [
        ...ok(after.uninstalled.length === 1, '确实该调过 management.uninstall'),
        ...ok(after.shown === before.shown, '取消之后行数不该变'),
        ...ok(after.toast === '', `取消不该弹提示，实际 "${after.toast}"`),
        ...ok(JSON.stringify(onState(after)) === JSON.stringify(onState(before)), '状态不该变'),
        ...ok(after.mismatched === 0, `${after.mismatched} 行不一致`),
      ];
    },
  },
  {
    // Shift+F10 / 菜单键在浏览器里触发的也是 contextmenu 事件，键盘入口是白拿的。
    // 实测：headless 上真按 Shift+F10 会由浏览器自己产生那个事件（how==='real'），
    // 而且**坐标是真的**（落在那一行上），所以那句"坐标为零就贴行弹"的兜底平时踩不到
    // ——第二条专门用没有坐标的事件把它踩出来：那种情况下不能缩到面板左上角去。
    name: '键盘也能开菜单：真 Shift+F10，以及事件没有坐标时贴着那一行弹',
    args: ['--fixtures', '--dump', '--key-menu', `name=${ALPHA}`,
      '--key-menu-zero', `name=${GAMMA}`],
    check(dumps, probes, targets, keys) {
      const [real, zero] = keys;
      return [
        ...ok(real.how === 'real', `真按 Shift+F10 该由浏览器产生 contextmenu，实际 ${real.how}`),
        ...ok(real.menuTop !== null, 'Shift+F10 之后菜单该开着'),
        ...ok(real.menuTop >= real.rowTop && real.menuTop <= real.rowTop + 38,
          `菜单该落在那一行上（行顶 ${real.rowTop}，菜单顶 ${real.menuTop}）`),
        // 反过来的那一半：键盘唤起的菜单必须看得见焦点在哪（鼠标弹的才不画，见上一条场景）
        ...ok(dumps[1].activeOutline !== 'none',
          `键盘唤起的菜单该画出焦点环，实际 "${dumps[1].activeOutline}"`),
        ...ok(zero.menuTop !== null, '没有坐标的那次也该开出菜单'),
        // 锚点是"行顶 + 8"，菜单再隔一道缝落到它下面（缝见 popup.js 里的 gap）
        ...ok(zero.menuTop > zero.rowTop + 8 && zero.menuTop <= zero.rowTop + 16,
          `没有坐标时该贴着那一行弹、又不压住锚点（行顶 ${zero.rowTop}，菜单顶 ${zero.menuTop}）`),
        ...ok(zero.menuLeft > 0, `没有坐标时不该缩到面板左上角（菜单左侧 ${zero.menuLeft}）`),
        ...ok(dumps[2].mismatched === 0, `${dumps[2].mismatched} 行不一致`),
      ];
    },
  },
  {
    // 面板只有 300 宽、几行高（4 个扩展时整块约 235 高）。把视口设成 250 高（贴着真面板
    // 的尺寸），右键最下面那一行：下面装不下，菜单该整个翻到光标**上面**去——而不是留在
    // 下面往面板里收。旧写法就是收边，实测菜单顶 141、光标 y=178，菜单正好把光标罩住。
    name: '右键靠底那一行：菜单翻到光标上面，不压住光标也不伸到面板外面',
    args: ['--fixtures', '--dump', '--height', '250', '--right-click', `name=${BETA}`],
    check([, after], probes, targets, keys, rcs) {
      const r = after.rowMenu.rect;
      const vp = after.viewport;
      return [
        ...ok(after.rowMenu.open === true, '菜单该开着'),
        ...ok(!!r && r.top >= 0 && r.left >= 0 && r.left + r.w <= vp.w && r.top + r.h <= vp.h,
          `菜单该整块落在面板里（面板 ${vp.w}×${vp.h}），实际 ${JSON.stringify(r)}`),
        ...ok(!!r && r.top + r.h < rcs[0].y,
          `下面装不下就该整个翻到光标上面（光标 y=${rcs[0].y}，菜单 ${JSON.stringify(r)}）`),
        ...ok(!!r && distTo(r, rcs[0]) > 0,
          `菜单不该盖住光标（右键在 ${rcs[0].x},${rcs[0].y}，菜单 ${JSON.stringify(r)}）`),
      ];
    },
  },
  {
    // 行的右半边（开关那儿，x≈272）右键：右边放不下，菜单该整个翻到光标**左边**去。
    // 旧写法是往左挪一截、贴着右边缘停下（实测菜单落在 174..294），于是光标正好压在
    // 菜单里——右键之后鼠标就站在菜单上了。
    name: '右键行的右半边：菜单翻到光标左边，不压住光标',
    args: ['--fixtures', '--dump', '--right-click', `row=${ALPHA}`],
    check([, after], probes, targets, keys, rcs) {
      const r = after.rowMenu.rect;
      const vp = after.viewport;
      return [
        ...ok(after.rowMenu.open === true, '菜单该开着'),
        ...ok(!!r && r.left >= 0 && r.top >= 0 && r.left + r.w <= vp.w && r.top + r.h <= vp.h,
          `菜单该整块落在面板里（面板 ${vp.w}×${vp.h}），实际 ${JSON.stringify(r)}`),
        ...ok(!!r && r.left + r.w < rcs[0].x,
          `右边装不下就该整个翻到光标左边（光标 x=${rcs[0].x}，菜单 ${JSON.stringify(r)}）`),
        ...ok(!!r && distTo(r, rcs[0]) > 0,
          `菜单不该盖住光标（右键在 ${rcs[0].x},${rcs[0].y}，菜单 ${JSON.stringify(r)}）`),
        ...ok(JSON.stringify(after.rowMenu.items) === JSON.stringify(
          ['打开详情页', '打开选项页', '打开主页', '复制扩展 ID', '卸载']),
          `在开关上右键也该是这一行的菜单：${JSON.stringify(after.rowMenu.items)}`),
        ...ok(after.mismatched === 0, `${after.mismatched} 行不一致`),
      ];
    },
  },
  {
    // 极端的那个方向：面板比菜单还矮（这里 145 高，五项菜单 159 高），四个方向都装不下。
    // 这时只剩"收边"一条路，菜单会被窗口下沿切掉一截——**这条代价认了**：右键之后鼠标
    // 不能站在菜单上，比"菜单完整"更要紧（鼠标在菜单里，下一次点就先点在菜单上了）。
    // 所以这条只断言"不压住光标"，菜单是不是整块可见不管——将来真给它加滚动条也不会
    // 把这条断言弄红。
    name: '面板比菜单还矮时：宁可被窗口切掉一截，也不让菜单压住光标',
    args: ['--fixtures', '--dump', '--height', '160', '--right-click', `name=${ALPHA}`],
    check([, after], probes, targets, keys, rcs) {
      const r = after.rowMenu.rect;
      return [
        ...ok(after.rowMenu.open === true, '菜单该开着'),
        ...ok(!!r && r.left >= 0 && r.top >= 0,
          `菜单该从面板里开始画，实际 ${JSON.stringify(r)}`),
        ...ok(!!r && distTo(r, rcs[0]) > 0,
          `菜单不该盖住光标（右键在 ${rcs[0].x},${rcs[0].y}，菜单 ${JSON.stringify(r)}）`),
      ];
    },
  },
  {
    name: '混装商店来源：Edge 和 Chrome 链接各自正确，未知来源和开发扩展不显示商店项',
    args: ['--fixtures', '--dump', '--eval', `(async () => {
      const originalCreate = chrome.tabs.create;
      const opened = [];
      chrome.tabs.create = async ({ url }) => { opened.push(url); };
      const sources = [
        ['normal', 'https://edge.microsoft.com/extensionwebstorebase/v1/crx'],
        ['normal', 'https://clients2.google.com/service/update2/crx?x=id'],
        ['normal', 'https://example.com/update'],
        ['normal', 'https://edge.microsoft.com.example.com/extensionwebstorebase/v1/crx'],
        ['normal', ''],
        ['development', 'https://edge.microsoft.com/extensionwebstorebase/v1/crx'],
      ];
      const storeAction = ROW_ACTIONS.find(a => a.label === '在应用商店中打开');
      const visible = [];
      try {
        for (const [installType, updateUrl] of sources) {
          const it = { ...items[0], storeUrl: getStoreUrl({ id: 'demo-id', installType, updateUrl }) };
          buildRowMenu(it);
          visible.push([...el.rowMenu.querySelectorAll('button')].some(b => b.textContent === storeAction.label));
          if (storeAction.when(it)) await storeAction.run(it);
        }
        return { opened, visible };
      } finally { chrome.tabs.create = originalCreate; }
    })()`],
    check(dumps, probes, targets, keys, rcs, evaluations) {
      const result = evaluations[0];
      return [
        ...ok(JSON.stringify(result.opened) === JSON.stringify([
          'https://microsoftedge.microsoft.com/addons/detail/demo-id',
          'https://chromewebstore.google.com/detail/demo-id',
        ]), `商店链接不正确：${JSON.stringify(result.opened)}`),
        ...ok(JSON.stringify(result.visible) === JSON.stringify([true, true, false, false, false, false]),
          `商店项可见性不正确：${JSON.stringify(result.visible)}`),
        ...ok(dumps[0].mismatched === 0, `${dumps[0].mismatched} 行不一致`),
      ];
    },
  },
];

let failed = 0;
for (const c of CASES) {
  let bad;
  try {
    const res = runFull(c.args);
    bad = c.check(res.dumps, res.probes, res.targets, res.keyMenus, res.rightClicks, res.evaluations);
  } catch (e) {
    // 驱动挂了的话，真正的死因通常在 stdout（它自己的 [fatal] / [warn] 都打在那儿），
    // 只报 stderr 会漏掉——之前就是这么把一条 exit 1 查成了"内容不对"。
    const tail = (s) => (s || '').toString().trim().split('\n').slice(-4).join(' | ');
    bad = [`跑不起来（exit ${e.status}）`];
    if (tail(e.stdout)) bad.push('stdout 尾部: ' + tail(e.stdout));
    if (tail(e.stderr)) bad.push('stderr: ' + tail(e.stderr));
  }
  if (bad.length) {
    failed++;
    console.log(`FAIL  ${c.name}`);
    for (const b of bad) console.log(`        ${b}`);
  } else {
    console.log(`ok    ${c.name}`);
  }
}

console.log(`\n${CASES.length - failed}/${CASES.length} 通过`);
process.exit(failed ? 1 : 0);

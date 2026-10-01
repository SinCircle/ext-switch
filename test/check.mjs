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
  return { dumps: pick('[dump] '), probes: pick('[probe] ') };
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
];

let failed = 0;
for (const c of CASES) {
  let bad;
  try {
    const res = runFull(c.args);
    bad = c.check(res.dumps, res.probes);
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

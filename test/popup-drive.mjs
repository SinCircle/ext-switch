/* 无头加载本扩展、打开 popup.html、求值/点击/截图。
 *
 * 用法：
 *   node test/popup-drive.mjs --fixtures                  装 4 个假扩展当数据，然后 dump
 *   node test/popup-drive.mjs --fixtures --dump           打印每行的 界面状态/真实状态/图标
 *   node test/popup-drive.mjs --eval "..."                在 popup 页里求值，打印 [eval]
 *   node test/popup-drive.mjs --type "gam"                真打字进搜索框
 *   node test/popup-drive.mjs --click "#all-off"          真点一下（走 CDP 输入，带用户激活）
 *   node test/popup-drive.mjs --click "text=全部关"        按文字点按钮
 *   node test/popup-drive.mjs --click "row=Alpha Notes"   点某个扩展的那一行开关
 *     可以给多个 --click，每个点完各 dump 一次，用来跑"全关 → 撤销 → 单点"这种序列。
 *   node test/popup-drive.mjs --shot out.png              截图（视口就是 popup 的 300 宽）
 *   node test/popup-drive.mjs --dark                      按深色配色渲染
 *   node test/popup-drive.mjs --reduce-motion             模拟系统开了「减少动态效果」
 *   node test/popup-drive.mjs --probe-anim --click ...    量重排动画，额外打一行 [probe]：
 *                                                         每行动画第一帧的位移/起手位置/是否跑完
 *   node test/popup-drive.mjs --headful                   不用无头（肉眼看的时候用）
 *   node test/popup-drive.mjs --wait-for "<选择器>"        换个"等到出现"的选择器
 *
 * 假扩展由 test/make-fixtures.py 生成（无头跑的是全新临时 profile，里面没有别的扩展，
 * 不装假的数据列表永远是空的）。
 *
 * 为什么不用 --load-extension：Chrome 137 起该开关被停用，本机 Chrome 153 上它不会真的
 * 加载扩展，chrome-extension:// 页面直接 ERR_BLOCKED。改用 CDP 的 Extensions.loadUnpacked。
 *
 * 为什么端口要问系统要，不是自己算：早先按 pid 派生（`9310 + pid % 380`）避免过固定端口
 * 的坑——上一条命令的 Chrome 没退干净时会抢端口，读到的还是上一次的旧页面，看着像插件坏了。
 * 但连续跑（test/check.mjs 一条接一条起 Chrome）时 pid 会被复用，算出来的端口照样撞上
 * 上一个还没退干净的实例，症状是 CDP 端口压根起不来。改成向系统要一个当前空闲的端口，
 * 这类碰撞就不存在了。
 */
import { spawn } from 'node:child_process';
import { mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const flag = (n) => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : undefined; };
const has = (n) => args.includes(n);

const EXT = resolve(flag('--ext') || ROOT);
const WAIT_FOR = flag('--wait-for') || '#list .row';
const SHOT = flag('--shot');
const EVALS = [];
const CLICKS = [];
for (let i = 0; i < args.length; i++) {
  if (args[i] === '--eval') EVALS.push(args[i + 1]);
  if (args[i] === '--click') CLICKS.push(args[i + 1]);
}
const VIEW_W = Number(flag('--width') || 300);
const VIEW_H = Number(flag('--height') || 560);

const CHROME = process.env.CHROME_PATH ||
  'C:/Program Files/Google/Chrome/Application/chrome.exe';

/* 让系统分配一个空闲端口：绑 0 号端口拿到实际端口号再放掉。
 * 比 pid 派生可靠——放掉到 Chrome 绑上之间被别的进程抢走的窗口极小。 */
const freePort = () => new Promise((res, rej) => {
  const s = createServer();
  s.on('error', rej);
  s.listen(0, '127.0.0.1', () => {
    const { port } = s.address();
    s.close(() => res(port));
  });
});
const PORT = await freePort();

const profile = mkdtempSync(join(tmpdir(), 'extswitch-cdp-'));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const lines = [];
const out = (s) => { lines.push(s); console.log(s); };

const chrome = spawn(CHROME, [
  `--remote-debugging-port=${PORT}`,
  `--user-data-dir=${profile}`,
  '--no-first-run',
  '--no-default-browser-check',
  '--disable-gpu',
  '--disable-features=Translate,MediaRouter',
  ...(has('--headful') ? [] : ['--headless=new']),
  'about:blank',
], { stdio: 'ignore' });

let done = false;
function cleanup(code) {
  if (done) return;      // 收尾只做一次：重复 exit 会把 0 盖成 1
  done = true;
  try { chrome.kill(); } catch {}
  setTimeout(() => {
    try { rmSync(profile, { recursive: true, force: true }); } catch {}
    process.exit(code);
  }, 250);
}
process.on('uncaughtException', (e) => { console.log('[fatal] ' + e.message); cleanup(1); });
process.on('unhandledRejection', (e) => {
  console.log('[fatal] ' + ((e && e.message) || e));
  cleanup(1);
});

const json = async (path) => (await fetch(`http://127.0.0.1:${PORT}${path}`)).json();

/* 打开一条到指定 WebSocket 的连接，带 CDP 的 id/call 复用。 */
async function connect(url) {
  const ws = new WebSocket(url);
  await new Promise((res, rej) => {
    ws.addEventListener('open', res, { once: true });
    ws.addEventListener('error', () => rej(new Error('WS 连不上 ' + url)), { once: true });
  });
  let nextId = 1;
  const pending = new Map();
  ws.addEventListener('message', (ev) => {
    let m; try { m = JSON.parse(ev.data); } catch { return; }
    if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); return; }
    // popup 页里的报错一定要能看见，否则"列表空的"会被当成选择器写错
    if (m.method === 'Runtime.consoleAPICalled') {
      out('[console.' + m.params.type + '] ' + (m.params.args || [])
        .map((a) => a.value !== undefined ? String(a.value) : a.description || a.type).join(' '));
    } else if (m.method === 'Runtime.exceptionThrown') {
      const d = m.params.exceptionDetails || {};
      out('[exception] ' + (d.text || '') + ' ' +
        ((d.exception && d.exception.description) || ''));
    } else if (m.method === 'Log.entryAdded') {
      out('[log:' + m.params.entry.level + '] ' + m.params.entry.text);
    }
  });
  const call = (method, params) => new Promise((res, rej) => {
    const id = nextId++;
    pending.set(id, (m) => (m.error ? rej(new Error(method + ': ' + m.error.message)) : res(m.result)));
    ws.send(JSON.stringify({ id, method, params }));
  });
  return { call, close: () => { try { ws.close(); } catch {} } };
}

async function waitPort() {
  for (let i = 0; i < 80; i++) {
    try { return await json('/json/version'); } catch {}
    await sleep(200);
  }
  throw new Error(`CDP 端口 ${PORT} 16 秒内没起来（Chrome 没启动？路径 ${CHROME}）`);
}

const ver = await waitPort();
const browser = await connect(ver.webSocketDebuggerUrl);

const loaded = await browser.call('Extensions.loadUnpacked', { path: EXT });
const extId = loaded.id;
out('[loaded] id=' + extId + ' path=' + EXT);
if (!extId) throw new Error('loadUnpacked 没返回 id');

/* 无头跑的是全新临时 profile，里面只有我们自己，列表必空。
 * --fixtures / --fixtures-many 把 test/ 下那两批假扩展装进来，列表才有内容。 */
for (const [argName, sub] of [['--fixtures', 'fixtures'], ['--fixtures-many', 'fixtures-many']]) {
  if (!has(argName)) continue;
  const dir = join(ROOT, 'test', sub);
  let names = [];
  try {
    names = readdirSync(dir, { withFileTypes: true })
      .filter((e) => e.isDirectory()).map((e) => e.name);
  } catch {}
  if (!names.length) {
    throw new Error(`${sub} 是空的，先跑：uv run --with pillow python test/make-fixtures.py --many 10`);
  }
  for (const n of names) await browser.call('Extensions.loadUnpacked', { path: join(dir, n) });
  out(`[loaded] ${sub}: ${names.length} 个`);
}

const { targetId } = await browser.call('Target.createTarget',
  { url: `chrome-extension://${extId}/popup.html` });
await sleep(400);

let target;
for (let i = 0; i < 40; i++) {
  target = (await json('/json/list')).find((t) => t.id === targetId);
  if (target && target.webSocketDebuggerUrl) break;
  await sleep(150);
}
if (!target) throw new Error('popup 目标没出现');

const page = await connect(target.webSocketDebuggerUrl);
await page.call('Runtime.enable');
await page.call('Log.enable');
await page.call('Page.enable');
/* 视口就设成 popup 的真宽度：截图才跟用户看到的一致，量尺寸也才是真的。 */
await page.call('Emulation.setDeviceMetricsOverride',
  { width: VIEW_W, height: VIEW_H, deviceScaleFactor: 2, mobile: false });
const media = [];
if (has('--dark')) media.push({ name: 'prefers-color-scheme', value: 'dark' });
// 减少动态效果：面板里的动画要靠 matchMedia 判断（CSS 里那句 animation:none 拦不住
// Web Animations API），所以必须真的把这条媒体特性模拟出来，不能只改代码里的开关。
if (has('--reduce-motion')) media.push({ name: 'prefers-reduced-motion', value: 'reduce' });
if (media.length) await page.call('Emulation.setEmulatedMedia', { features: media });

const evaluate = async (expr) => {
  const r = await page.call('Runtime.evaluate',
    { expression: expr, returnByValue: true, awaitPromise: true });
  if (r.exceptionDetails) {
    throw new Error('求值抛错: ' + (r.exceptionDetails.exception?.description ||
      r.exceptionDetails.text));
  }
  return r.result.value;
};

/* 等元素出现。等不到就把当时的 DOM 情况报出来，别只说"超时"。 */
async function waitFor(sel, ms = 6000) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (await evaluate(`!!document.querySelector(${JSON.stringify(sel)})`)) return true;
    await sleep(100);
  }
  out(`[warn] 等不到 ${sel}；body 里现有: ` +
    JSON.stringify(await evaluate(
      `[...document.body.children].map(e => e.tagName + (e.id ? '#' + e.id : '')).join(', ')`)));
  return false;
}

await waitFor(WAIT_FOR);
await sleep(250);

/* 量重排动画。装钩子的时机必须在点击之前：把 Element.prototype.animate 包一层，
 * 于是每一次滑动都被记下来——用的是第一帧的位移、起手那一刻的实际位置、以及那个
 * 动画最终有没有正常跑完（被 cancel 的动画 finished 是 reject，不会进数组）。
 *
 * 记「起手位置」是为了抓一种假通过：只看 animate() 被调过，不能说明它没被
 * 重排 DOM 那一步掐掉。真被掐掉的话，起手位置会等于重排后的新位置，而不是
 * 用户眼睛看到的旧位置。 */
if (has('--probe-anim')) {
  const n = await evaluate(`(() => {
    const track = new Map();
    for (const r of document.querySelectorAll('#list .row')) {
      track.set(r, r.querySelector('.name').textContent);
    }
    window.__probe = { before: {}, anims: [], finished: [] };
    for (const [r, name] of track) window.__probe.before[name] = r.getBoundingClientRect().top;
    const orig = Element.prototype.animate;
    Element.prototype.animate = function (kf, opt) {
      const a = orig.call(this, kf, opt);
      const frames = Array.isArray(kf) ? kf : [kf];
      const first = frames[0] || {};
      const name = track.get(this) ?? '';
      const rec = {
        name,
        from: first.transform || '',
        startedAt: this.getBoundingClientRect().top,
        ms: opt && opt.duration,
      };
      /* 被拎起来那一行（关键帧里带 scale 的）逐帧采一遍位置。光验"动画跑完了"不够——
       * 看清"先浮起来（位置得跑到起点上方去）→ 飞过去 → 最后落回新位置"才是要验的。
       * 注意别只看第一帧：第一帧是原地（scale 1），放大在第二帧才出现。 */
      if (frames.some((f) => String(f.transform || '').includes('scale'))) {
        const tops = [];
        const t0 = performance.now();
        const el = this;
        const tick = () => {
          tops.push(Math.round(el.getBoundingClientRect().top * 10) / 10);
          if (performance.now() - t0 < 900) requestAnimationFrame(tick);
        };
        requestAnimationFrame(tick);
        rec.tops = tops;
      }
      window.__probe.anims.push(rec);
      a.finished.then(() => window.__probe.finished.push(name), () => {});
      return a;
    };
    return track.size;
  })()`);
  out(`[probe-setup] 盯着 ${n} 行`);
}

for (const expr of EVALS) out('[eval] ' + JSON.stringify(await evaluate(expr)));

/* 真打字进搜索框：走 CDP 的 Input.insertText，不是直接改 value ——
 * 要验的是"打开面板就能直接敲字过滤"这条主路径，改 value 会绕过焦点。 */
if (flag('--type')) {
  await evaluate(`document.getElementById('q').focus()`);
  await page.call('Input.insertText', { text: flag('--type') });
  await sleep(250);
  out(`[type] ${flag('--type')} → 命中 ` + await evaluate(
    `[...document.querySelectorAll('#list .row')].filter(r => !r.hidden).length`) + ' 行');
}

/* 元素中心点（视口坐标）。点不到就返回 null，别只说"超时"。 */
function centerOf(expr) {
  return evaluate(`(() => {
    const e = (${expr});
    if (!e) return null;
    const r = e.getBoundingClientRect();
    return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
  })()`);
}

/* 真点击：走 CDP 输入事件而不是 el.click()，这样页面拿到用户激活——
 * 受激活限制的扩展 API 用合成 click() 会被拒。 */
async function dispatchClick(box) {
  for (const type of ['mousePressed', 'mouseReleased']) {
    await page.call('Input.dispatchMouseEvent',
      { type, x: box.x, y: box.y, button: 'left', clickCount: 1 });
  }
}

/* --click 的四种写法：
 *   #all-off            普通 CSS 选择器
 *   text=全部关          文字完全相等的那个按钮
 *   row=Alpha Notes     这一行的开关（按扩展名找，不依赖它排在第几）
 *   name=Alpha Notes    这一行的名字（用来验"点整行也能开关"）
 *   reload              重载面板（模拟"关掉再打开"：内存里的东西全没了，
 *                       只剩 storage.session 还在——撤销快照存那儿就是为了这条路径）
 * 统一解析成"要点的那个元素"；找不到就把列表现有的名字打出来，别只说点不到。 */
function resolveSel(sel) {
  for (const [prefix, inner] of [['row=', '.sw'], ['name=', '.name']]) {
    if (!sel.startsWith(prefix)) continue;
    const n = JSON.stringify(sel.slice(prefix.length));
    return `(() => {
      const row = [...document.querySelectorAll('#list .row')]
        .find(r => r.querySelector('.name').textContent === ${n});
      return row ? row.querySelector(${JSON.stringify(inner)}) : null;
    })()`;
  }
  if (sel.startsWith('text=')) {
    const t = JSON.stringify(sel.slice(5));
    return `([...document.querySelectorAll('button')]
      .find(e => e.textContent.trim() === ${t}) || null)`;
  }
  return `document.querySelector(${JSON.stringify(sel)})`;
}

async function clickSel(sel) {
  if (sel === 'reload') {
    await page.call('Page.reload', { ignoreCache: false });
    await sleep(700);
    await waitFor(WAIT_FOR);
    await sleep(250);
    out('[reload] 面板已重载');
    return;
  }
  const box = await centerOf(resolveSel(sel));
  if (!box) {
    out(`[warn] 点不到 ${sel}；列表里现有: ` +
      JSON.stringify(await evaluate(
        `[...document.querySelectorAll('#list .name')].map(e => e.textContent)`)));
    return;
  }
  await dispatchClick(box);
  out(`[click] ${sel} @ ${Math.round(box.x)},${Math.round(box.y)}`);
  await sleep(800);
}

/* dump 的关键一项是 mismatched：界面上的开关状态跟 chrome.management 报的真实状态
 * 不一致的行数。只看界面会假通过——UI 翻了、扩展其实没被禁用，是最容易漏的失败。 */
const DUMP = `(async () => {
  const real = new Map((await chrome.management.getAll()).map(e => [e.id, e.enabled]));
  const rows = [...document.querySelectorAll('#list .row')].filter(r => !r.hidden);
  return {
    shown: rows.length,
    skipped: (document.getElementById('hidden-note') || {}).textContent || '',
    emptyMsg: document.getElementById('empty').hidden
      ? '' : document.getElementById('empty').textContent,
    undoEnabled: !document.getElementById('undo').disabled,
    menuOpen: !document.getElementById('sort-menu').hidden,
    sort: (document.querySelector('#sort-menu [aria-checked="true"]') || {}).dataset?.mode || '',
    toast: document.getElementById('toast').hidden
      ? '' : document.getElementById('toast').textContent,
    mismatched: rows.filter(r => (r.dataset.on === '1') !== real.get(r.dataset.id)).length,
    list: (() => {
      const l = document.getElementById('list');
      // 开关右边缘离列表"内容区"右边缘还剩多少：小于 0 就是滚动条压到开关上了。
      // 必须把滚动条自己占的宽减掉——它在边框盒里面，不减的话量出来的缝偏大 8px，
      // 真压上了也看不出来。
      const edges = rows.length ? rows.map(r => r.querySelector('.sw').getBoundingClientRect().right) : [0];
      const scrollbar = l.offsetWidth - l.clientWidth;
      return {
        overflow: l.scrollHeight > l.clientHeight,
        scrollH: l.scrollHeight, clientH: l.clientHeight,
        switchRightGap: Math.round(l.getBoundingClientRect().right - scrollbar
          - parseFloat(getComputedStyle(l).paddingRight) - Math.max(...edges)),
      };
    })(),
    rows: rows.map(r => {
      const img = r.querySelector('img');
      return {
        name: r.querySelector('.name').textContent,
        ui: r.dataset.on === '1',
        real: real.get(r.dataset.id) ?? null,
        icon: img ? (img.naturalWidth > 0 ? 'img-ok' : 'img-broken') : 'tile',
      };
    }),
  };
})()`;

/* 每次读都是"消费式"的：读完把 before 换成当前的位置、把攒下的动画清空。
 * 于是一次点击对应一条 [probe]，里面就是这次点击造成的位移，跟 [dump] 一一对应。 */
const probeRead = () => evaluate(`(() => {
  const after = {};
  for (const r of document.querySelectorAll('#list .row')) {
    after[r.querySelector('.name').textContent] = r.getBoundingClientRect().top;
  }
  const p = window.__probe;
  const snap = { before: p.before, after, anims: p.anims, finished: p.finished };
  p.before = after;
  p.anims = [];
  p.finished = [];
  return snap;
})()`);

/* --dump 有几次点击就打印 1 + N 次：第一次是"操作开始之前"的基线，
 * 之后每个 --click 各打一次。没有基线的话，"点完变了吗"根本没有可比的参照。 */
if (has('--dump')) out('[dump] ' + JSON.stringify(await evaluate(DUMP)));
if (has('--probe-anim')) out('[probe] ' + JSON.stringify(await probeRead()));
for (const sel of CLICKS) {
  await clickSel(sel);
  if (has('--dump')) out('[dump] ' + JSON.stringify(await evaluate(DUMP)));
  if (has('--probe-anim')) out('[probe] ' + JSON.stringify(await probeRead()));
}

if (SHOT) {
  await sleep(150);
  const r = await page.call('Page.captureScreenshot',
    { format: 'png', captureBeyondViewport: true });
  if (r && r.data) { writeFileSync(SHOT, Buffer.from(r.data, 'base64')); out('[shot] ' + SHOT); }
  else out('[shot] 失败');
}

cleanup(0);

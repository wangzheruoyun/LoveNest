const test = require('node:test');
const assert = require('node:assert');
const vm = require('node:vm');
const fs = require('node:fs');
const { createHost } = require('./host-native');

const GAME_ROOT = '/storage/emulated/0/Download/爱之巢DemoV1.52';

function loadBridge(host) {
  const sandbox = { window: {}, console, __GCNative: host, setTimeout, clearTimeout, Date, JSON, Math };
  sandbox.window.window = sandbox.window;
  sandbox.globalThis = sandbox.window;
  vm.createContext(sandbox);
  vm.runInContext(fs.readFileSync('../../android-app/app/src/main/assets/gc-bridge.js', 'utf8'), sandbox);
  return sandbox.window;
}

test('path.join 在中文与空格路径下拼接正确', () => {
  const w = loadBridge(createHost({ gameRoot: GAME_ROOT, docsRoot: '/tmp/d' }));
  const path = w.require('path');
  assert.strictEqual(path.join(GAME_ROOT, 'asset/json', 'startup.json'),
    GAME_ROOT + '/asset/json/startup.json');
});

test('process.cwd() 返回游戏根目录，供引擎推导 FileUtils.nativePath', () => {
  const w = loadBridge(createHost({ gameRoot: GAME_ROOT, docsRoot: '/tmp/d' }));
  assert.strictEqual(w.process.cwd(), GAME_ROOT);
});

test('process.memoryUsage() 返回对象形状', () => {
  const w = loadBridge(createHost({ gameRoot: GAME_ROOT, docsRoot: '/tmp/d' }));
  const m = w.process.memoryUsage();
  assert.strictEqual(typeof m.rss, 'number');
  assert.strictEqual(typeof m.heapTotal, 'number');
  assert.strictEqual(typeof m.heapUsed, 'number');
});

test('未知模块返回惰性 no-op 代理而非 undefined', () => {
  const w = loadBridge(createHost({ gameRoot: GAME_ROOT, docsRoot: '/tmp/d' }));
  const mod = w.require('some-unknown-module');
  assert.notStrictEqual(mod, undefined);
  assert.strictEqual(typeof mod.anything, 'function');
  assert.strictEqual(typeof mod.a.b.c, 'function');
});

test('os.homedir() 指向手机 Documents 根', () => {
  const w = loadBridge(createHost({ gameRoot: GAME_ROOT, docsRoot: '/tmp/d' }));
  assert.strictEqual(w.require('os').homedir(), '/tmp/d');
});

test('os.totalmem()/freemem() 返回稳定非零字节数', () => {
  const w = loadBridge(createHost({ gameRoot: GAME_ROOT, docsRoot: '/tmp/d' }));
  const os = w.require('os');
  assert.strictEqual(typeof os.totalmem, 'function');
  assert.strictEqual(typeof os.freemem, 'function');
  assert.ok(os.totalmem() > 0);
  assert.ok(os.freemem() > 0);
});

test('未知模块的 no-op 代理可安全链式调用与 new', () => {
  const w = loadBridge(createHost({ gameRoot: GAME_ROOT, docsRoot: '/tmp/d' }));
  const mod = w.require('some-unknown-module');
  assert.strictEqual(typeof mod.a().b, 'function');
  assert.strictEqual(typeof mod.fn().deeper().x, 'function');
  assert.strictEqual(typeof new mod.Thing().other, 'function');
  assert.strictEqual(typeof mod.a.b.c(), 'function', '调用链末端调用仍返回 no-op，绝不抛异常');
});

test('未知模块的 no-op 代理参与原始值强制转换时不抛异常', () => {
  const w = loadBridge(createHost({ gameRoot: GAME_ROOT, docsRoot: '/tmp/d' }));
  const mod = w.require('some-unknown-module');
  // String() / 模板拼接 / 宽松相等三条强制转换路径都必须产出原始值。
  assert.strictEqual(String(mod), '');
  assert.strictEqual('' + mod, '');
  assert.doesNotThrow(() => { void (mod == 1); });
  assert.strictEqual(mod == 1, false);
  assert.doesNotThrow(() => { void (mod < 1); });
  // 强制转换特例不得破坏调用/new/链式访问的形状。
  assert.strictEqual(typeof mod.a()(), 'function');
  assert.strictEqual(typeof new mod.X(), 'function');
  assert.strictEqual(typeof mod.a.b.c(), 'function');
});

test('window.__gcBridge 不可枚举且不可写', () => {
  const w = loadBridge(createHost({ gameRoot: GAME_ROOT, docsRoot: '/tmp/d' }));
  assert.strictEqual(Object.keys(w).indexOf('__gcBridge'), -1, '不得出现在 Object.keys 中');
  const desc = Object.getOwnPropertyDescriptor(w, '__gcBridge');
  assert.ok(desc, '__gcBridge 必须已定义');
  assert.strictEqual(desc.enumerable, false);
  assert.strictEqual(desc.writable, false);
  const before = w.__gcBridge;
  w.__gcBridge = 1; // 宽松模式下静默失败，不得覆盖
  assert.strictEqual(w.__gcBridge, before);
  assert.strictEqual(typeof w.__gcBridge.resolvePath, 'function');
});

test('resolvePath() 仅做词法拼接，不对爬升路径做逃逸拒绝（Ruling 1）', () => {
  const w = loadBridge(createHost({ gameRoot: '/srv/game', docsRoot: '/tmp/d' }));
  const rp = w.__gcBridge.resolvePath;
  assert.strictEqual(typeof rp, 'function');
  assert.strictEqual(rp('asset/json/startup.json'), '/srv/game/asset/json/startup.json');
  assert.strictEqual(rp('/srv/game/index.html'), '/srv/game/index.html');
  // 相对爬升路径只做词法归一化，绝不在此处拒绝（逃逸判定归宿主）
  assert.strictEqual(rp('../..'), '/');
  assert.strictEqual(rp('../../etc/passwd'), '/etc/passwd');
});

/* ------------------------------------------------------------------ *
 * Task 3 — `fs` shim
 * ------------------------------------------------------------------ */

test('fs.existsSync / readFileSync 能读到游戏目录内的文件', () => {
  const w = loadBridge(createHost({ gameRoot: GAME_ROOT, docsRoot: '/tmp/lovenest-docs' }));
  const fsShim = w.require('fs');
  assert.strictEqual(fsShim.existsSync(GAME_ROOT + '/index.html'), true);
  const buf = fsShim.readFileSync(GAME_ROOT + '/index.html');
  assert.ok(buf && buf.length > 0);
});

test('fs.writeFileSync 写入存档路径后 readFileSync 能读回（含中文内容）', () => {
  const docsRoot = '/tmp/lovenest-docs-test';
  const w = loadBridge(createHost({ gameRoot: GAME_ROOT, docsRoot }));
  const fsShim = w.require('fs');
  const p = docsRoot + '/save1.json';
  fsShim.writeFileSync(p, '{"名字":"爱之巢"}');
  assert.strictEqual(fsShim.readFileSync(p, { encoding: 'utf8' }), '{"名字":"爱之巢"}');
});

test('fs.existsSync 指向不存在的路径返回 false 而非抛异常', () => {
  const w = loadBridge(createHost({ gameRoot: GAME_ROOT, docsRoot: '/tmp/d' }));
  assert.strictEqual(w.require('fs').existsSync('/nope/definitely/missing'), false);
});

test('fs.readdirSync 返回目录内文件名数组', () => {
  const w = loadBridge(createHost({ gameRoot: GAME_ROOT, docsRoot: '/tmp/d' }));
  const names = w.require('fs').readdirSync(GAME_ROOT);
  assert.ok(names.indexOf('index.html') >= 0);
});

/* ------------------------------------------------------------------ *
 * Task 3 — extra coverage. These pin behaviours the brief leaves to the
 * prose: the Node-shaped Stats object, the error-code contract of Ruling 6
 * (the four brief tests never assert a `code`), the exact `readFileSync`
 * call shapes the engine is observed to use, and the async callback forms.
 * The brief's own `readdirSync` test would also pass vacuously against the
 * no-op proxy, so membership and `Array.isArray` are asserted explicitly.
 * ------------------------------------------------------------------ */

test('fs.readdirSync 返回真实数组（而非 no-op 代理）且包含 index.html', () => {
  const w = loadBridge(createHost({ gameRoot: GAME_ROOT, docsRoot: '/tmp/d' }));
  const names = w.require('fs').readdirSync(GAME_ROOT);
  assert.ok(Array.isArray(names), '必须是真数组');
  assert.ok(names.indexOf('index.html') >= 0);
});

test('fs.statSync 返回 Node 形状的 Stats 对象', () => {
  const w = loadBridge(createHost({ gameRoot: GAME_ROOT, docsRoot: '/tmp/d' }));
  const fsShim = w.require('fs');
  const dir = fsShim.statSync(GAME_ROOT);
  assert.strictEqual(dir.isDirectory(), true);
  assert.strictEqual(dir.isFile(), false);
  const file = fsShim.statSync(GAME_ROOT + '/index.html');
  assert.strictEqual(file.isDirectory(), false);
  assert.strictEqual(file.isFile(), true);
  assert.ok(file.size > 0, 'size 应为正数');
  assert.ok(file.mtimeMs > 0, 'mtimeMs 应为可信数字');
  assert.ok(file.mtime instanceof Date, 'mtime 应为 Date（引擎可能调用 getTime）');
  assert.strictEqual(typeof file.mtime.getTime(), 'number');
});

test('越界路径：existsSync 返回 false，读取/写入抛 EACCES 且不落盘', () => {
  const nodeFs = require('node:fs');
  const w = loadBridge(createHost({ gameRoot: GAME_ROOT, docsRoot: '/tmp/lovenest-docs-escape' }));
  const fsShim = w.require('fs');
  assert.strictEqual(fsShim.existsSync('/etc/passwd'), false, '越界路径 existsSync 必须为 false');
  assert.strictEqual(fsShim.existsSync('/tmp/lovenest-escape.txt'), false);
  const cases = [
    () => fsShim.readFileSync('/etc/passwd'),
    () => fsShim.statSync('/etc/passwd'),
    () => fsShim.readdirSync('/etc'),
    () => fsShim.writeFileSync('/tmp/lovenest-escape.txt', 'x'),
    () => fsShim.mkdirSync('/tmp/lovenest-escape-dir')
  ];
  cases.forEach((fn) => {
    assert.throws(fn, (err) => err.code === 'EACCES', '越界访问必须抛 EACCES');
  });
  assert.strictEqual(nodeFs.existsSync('/tmp/lovenest-escape.txt'), false, '越界写入不得落盘');
  assert.strictEqual(nodeFs.existsSync('/tmp/lovenest-escape-dir'), false, '越界建目录不得落盘');
});

test('读取缺失路径抛 ENOENT（含 code/syscall/path），对文件 readdirSync 抛 ENOTDIR', () => {
  const docsRoot = '/tmp/lovenest-docs-missing';
  const w = loadBridge(createHost({ gameRoot: GAME_ROOT, docsRoot }));
  const fsShim = w.require('fs');
  const gone = docsRoot + '/nope.json';
  assert.throws(() => fsShim.readFileSync(gone), (err) => {
    // 注意：错误对象诞生于 vm 沙箱 realm，外层 `instanceof Error` 不成立，
    // 故以形状而非原型断言（真机上桩层与引擎同 realm，原型亦成立）。
    return err.code === 'ENOENT' && err.syscall === 'open' && err.path === gone &&
      typeof err.errno === 'number' && typeof err.message === 'string' &&
      err.message.indexOf('ENOENT') === 0;
  });
  assert.throws(() => fsShim.statSync(gone), (err) => err.code === 'ENOENT');
  assert.throws(() => fsShim.unlinkSync(gone), (err) => err.code === 'ENOENT');
  assert.throws(() => fsShim.readdirSync(GAME_ROOT + '/index.html'), (err) => err.code === 'ENOTDIR');
});

test('readFileSync 支持裸字符串编码与 {encoding:null}（引擎的实际调用形态）', () => {
  const w = loadBridge(createHost({ gameRoot: GAME_ROOT, docsRoot: '/tmp/d' }));
  const fsShim = w.require('fs');
  const p = GAME_ROOT + '/index.html';
  const asText = fsShim.readFileSync(p, 'utf8'); // readFileSync(a, c ? null : "utf8")
  assert.strictEqual(typeof asText, 'string');
  assert.ok(asText.indexOf('<') === 0, 'index.html 应是文本');
  const asBytes = fsShim.readFileSync(p, { encoding: null }); // readFileSync(path, {encoding:null})
  assert.notStrictEqual(typeof asBytes, 'string');
  assert.strictEqual(typeof asBytes.length, 'number');
  assert.ok(asBytes.length > 0);
  // utf8 解码必须与字节 → 文本路径一致
  assert.strictEqual(fsShim.readFileSync(p, 'utf-8'), asText);
  // 中文文件名 + 中文内容的 JSON 资产：解码后必须能 JSON.parse 回来
  const cn = fsShim.readFileSync(GAME_ROOT + '/asset/language/繁体中文.json', 'utf8');
  assert.strictEqual(JSON.parse(cn)['图像层深度坐标系代码实现'], '圖像層深度坐標系代碼實現');
});

test('fs.writeFileSync 接受 Uint8Array，unlinkSync 删除后 existsSync 为 false', () => {
  const docsRoot = '/tmp/lovenest-docs-bytes';
  const w = loadBridge(createHost({ gameRoot: GAME_ROOT, docsRoot }));
  const fsShim = w.require('fs');
  const p = docsRoot + '/blob.bin';
  fsShim.writeFileSync(p, new Uint8Array([0x00, 0xff, 0x41, 0x42]));
  assert.deepStrictEqual(Array.prototype.slice.call(fsShim.readFileSync(p)), [0, 255, 65, 66]);
  assert.strictEqual(fsShim.existsSync(p), true);
  fsShim.unlinkSync(p);
  assert.strictEqual(fsShim.existsSync(p), false);
});

test('fs.mkdirSync 递归建父目录；非递归时 EEXIST / ENOENT / ENOTDIR', () => {
  const docsRoot = '/tmp/lovenest-docs-mkdir';
  fs.rmSync(docsRoot, { recursive: true, force: true }); // 上次运行残留会使 EEXIST 分支误判
  const w = loadBridge(createHost({ gameRoot: GAME_ROOT, docsRoot }));
  const fsShim = w.require('fs');
  const dir = docsRoot + '/a';
  fsShim.mkdirSync(dir, { recursive: true });
  assert.strictEqual(fsShim.statSync(dir).isDirectory(), true);
  assert.throws(() => fsShim.mkdirSync(dir), (err) => err.code === 'EEXIST');
  assert.throws(() => fsShim.mkdirSync(dir + '/x/y'), (err) => err.code === 'ENOENT',
    '父目录缺失时非递归 mkdir 应为 ENOENT');
  fsShim.writeFileSync(dir + '/note', 'x');
  assert.throws(() => fsShim.mkdirSync(dir + '/note/save'), (err) => err.code === 'ENOTDIR');
  fsShim.mkdirSync(dir + '/child');
  assert.strictEqual(fsShim.statSync(dir + '/child').isDirectory(), true);
});

test('fs 异步回调形态：readFile/writeFile/readdir/stat/mkdir，错误走回调不抛出', async () => {
  const docsRoot = '/tmp/lovenest-docs-async';
  const w = loadBridge(createHost({ gameRoot: GAME_ROOT, docsRoot }));
  const fsShim = w.require('fs');
  const call = (register) => new Promise((resolve, reject) => {
    register((err, value) => (err ? reject(err) : resolve(value)));
  });
  const p = docsRoot + '/async.json';
  await call((cb) => fsShim.writeFile(p, '{"异步":"好"}', cb));
  assert.strictEqual(await call((cb) => fsShim.readFile(p, { encoding: 'utf8' }, cb)), '{"异步":"好"}');
  assert.strictEqual(await call((cb) => fsShim.readFile(p, 'utf8', cb)), '{"异步":"好"}');
  const names = await call((cb) => fsShim.readdir(docsRoot, cb));
  assert.ok(names.indexOf('async.json') >= 0);
  const st = await call((cb) => fsShim.stat(p, cb));
  assert.strictEqual(st.isFile(), true);
  const nested = docsRoot + '/nested/deep';
  await call((cb) => fsShim.mkdir(nested, { recursive: true }, cb));
  assert.strictEqual((await call((cb) => fsShim.stat(nested, cb))).isDirectory(), true);
  // 失败必须以 cb(err) 抵达，而不是同步抛出（Review Focus #1/#2）
  const err = await new Promise((resolve) => {
    assert.doesNotThrow(() => fsShim.readFile(docsRoot + '/gone.json', (e) => resolve(e)));
  });
  assert.strictEqual(err.code, 'ENOENT');
});

/* ------------------------------------------------------------------ *
 * Fix round 1 — two Minor review findings
 * ------------------------------------------------------------------ */

test('宿主返回带尾斜杠的 gameRoot/docsRoot 时，根边界判定仍然正确', () => {
  const nodeFs = require('node:fs');
  // Task 7 的 Kotlin 只承诺 `-> String`；尾斜杠是合理的手误，桩层必须自愈。
  const rawGameRoot = GAME_ROOT + '/';
  const rawDocsRoot = '/tmp/lovenest-docs-trailing/';
  const host = Object.assign({}, createHost({ gameRoot: GAME_ROOT, docsRoot: rawDocsRoot }), {
    gameRoot: () => rawGameRoot,
    docsRoot: () => rawDocsRoot
  });
  const w = loadBridge(host);
  const fsShim = w.require('fs');
  assert.strictEqual(w.process.cwd(), GAME_ROOT, 'cwd 不得带尾斜杠');
  // 根内读取必须可用，而不是被误判为越界（EACCES）
  assert.strictEqual(fsShim.existsSync(GAME_ROOT + '/index.html'), true);
  const p = rawDocsRoot + 'save-trailing.json';
  fsShim.writeFileSync(p, 'ok');
  assert.strictEqual(fsShim.readFileSync(p, 'utf8'), 'ok');
  // 根内缺失路径应为 ENOENT，而不是 EACCES
  assert.throws(() => fsShim.readFileSync(rawDocsRoot + 'missing.json'), (err) => err.code === 'ENOENT');
  // 爬升出根的路径仍必须被拒绝，且不得落盘
  assert.throws(() => fsShim.writeFileSync(rawDocsRoot + '../lovenest-escape-trailing.txt', 'x'),
    (err) => err.code === 'EACCES');
  assert.strictEqual(nodeFs.existsSync('/tmp/lovenest-escape-trailing.txt'), false);
});

test('fs.stat 异步支持 (path, options, cb) 形态，回调不得被吞掉', async () => {
  const w = loadBridge(createHost({ gameRoot: GAME_ROOT, docsRoot: '/tmp/d' }));
  const fsShim = w.require('fs');
  const result = await Promise.race([
    new Promise((resolve, reject) => {
      fsShim.stat(GAME_ROOT + '/index.html', { bigint: false }, (err, value) => {
        if (err) reject(err); else resolve(value);
      });
    }),
    new Promise((resolve) => setTimeout(() => resolve('TIMEOUT'), 1000))
  ]);
  assert.notStrictEqual(result, 'TIMEOUT', 'fs.stat(path, options, cb) 的回调必须被调用');
  assert.strictEqual(result.isFile(), true);
});

/* ------------------------------------------------------------------ *
 * Task 4 — `child_process` command mapping and `nw.gui`
 *
 * The command table is derived from the decoded engine source, not guessed:
 * see the Task 4 report for the enumerated call sites. Each test drives the
 * shim through the exact call shapes the engine uses (`execSync(cmd, {encoding:
 * 'buffer'})`, `exec(cmd, cb)`, `spawn(exe, args)`).
 * ------------------------------------------------------------------ */

test('wmic os get Caption 返回纯 ASCII 的 Android 版本串', () => {
  const w = loadBridge(createHost({ gameRoot: GAME_ROOT, docsRoot: '/tmp/d' }));
  const cp = w.require('child_process');
  const out = cp.execSync('chcp 936 && wmic os get Caption', { encoding: 'buffer' });
  const s = Buffer.from(out).toString('latin1');
  assert.ok(/^[\x00-\x7F]*$/.test(s), '输出必须全为 ASCII，Review Focus #4');
  assert.ok(s.indexOf('Android') >= 0 || s.indexOf('android') >= 0);
});

test('wmic useraccount 返回非空设备名', () => {
  const w = loadBridge(createHost({ gameRoot: GAME_ROOT, docsRoot: '/tmp/d' }));
  const s = w.require('child_process').execSync('chcp 936 && wmic useraccount where name="x" get fullname');
  assert.ok(String(s).length > 0);
});

test('关机命令触发 fakeShutdown 而不是真的执行', () => {
  let shut = 0;
  const host = createHost({ gameRoot: GAME_ROOT, docsRoot: '/tmp/d' });
  host.fakeShutdown = () => { shut++; };
  const w = loadBridge(host);
  w.require('child_process').exec(GAME_ROOT + '/asset/pcSys/nircmd.exe "shutdown"');
  assert.strictEqual(shut, 1);
});

test('本 Demo 实际的断电演出 nircmd.exe hibernate 同样走 fakeShutdown', () => {
  let shut = 0;
  const logs = [];
  const host = createHost({ gameRoot: GAME_ROOT, docsRoot: '/tmp/d' });
  host.fakeShutdown = () => { shut++; };
  host.log = (s) => { logs.push(String(s)); };
  const w = loadBridge(host);
  const cp = w.require('child_process');
  // customCommand_15033 → W26_VisualSysOpt.hibernate()
  cp.exec('"' + GAME_ROOT + '/asset/pcSys/nircmd.exe" hibernate', () => {});
  assert.strictEqual(shut, 1, 'Demo 的关机演出必须映射到安卓退出表演');
  // customCommand_15032 → W26_VisualSysOpt.offMonitor()：「关闭显示器」尚无宿主能力
  cp.exec('"undefined\\system32\\scrnsave.scr" /s', () => {});
  assert.strictEqual(shut, 1, '关显示器不得被当成关机');
  assert.ok(logs.some((s) => s.indexOf('scrnsave.scr') >= 0), '关显示器必须留痕而非静默');
});

test('nw.gui 提供 Window.get / Clipboard.get / Shell.openItem', () => {
  const w = loadBridge(createHost({ gameRoot: GAME_ROOT, docsRoot: '/tmp/d' }));
  const nw = w.require('nw.gui');
  assert.strictEqual(typeof nw.Window.get, 'function');
  assert.strictEqual(typeof nw.Window.get().close, 'function');
  assert.strictEqual(typeof nw.Clipboard.get().set, 'function');
  assert.strictEqual(typeof nw.Shell.openItem, 'function');
  // 注意：本用例对 Task 2 的 no-op 代理是「真空通过」的（代理的任意属性都是可调用
  // 函数），因此它只固定接口形状；真实行为由下面 Window/Clipboard/Shell 的用例覆盖。
});

/* ---- Task 4 extra coverage ---- */

test('wmic os get Caption 的第三行是版本值，可被 W26_TraceConsole.handleInfo 采用', () => {
  const host = createHost({ gameRoot: GAME_ROOT, docsRoot: '/tmp/d' });
  host.androidVersion = () => '14';
  const w = loadBridge(host);
  const s = String(w.require('child_process').execSync('chcp 936 && wmic os get Caption'));
  assert.ok(/^[\x00-\x7F]*$/.test(s), '输出必须全为 ASCII');
  // 引擎 W26_TraceConsole.handleInfo 从下标 2 开始并跳过空行，因此值必须落在第 3 行。
  assert.strictEqual(s.split('\n')[2], 'Android 14');
});

test('设备名非 ASCII 时 GBK 缓冲路径仍返回纯 ASCII（Review Focus #4）', () => {
  const host = createHost({ gameRoot: GAME_ROOT, docsRoot: '/tmp/d' });
  host.deviceName = () => '张三的 OnePlus 12';
  const w = loadBridge(host);
  const cp = w.require('child_process');
  const buf = cp.execSync('chcp 936 && wmic useraccount where name="x" get fullname', { encoding: 'buffer' });
  const s = Buffer.from(buf).toString('latin1');
  assert.ok(/^[\x00-\x7F]*$/.test(s), '非 ASCII 设备名必须被净化');
  assert.ok(s.indexOf('OnePlus 12') >= 0, '可读的 ASCII 部分必须保留');
  assert.ok(s.indexOf('张三') < 0);
});

test('wmic useraccount 的输出形状可供引擎 split("\\n")[2].trim() 取值', () => {
  const host = createHost({ gameRoot: GAME_ROOT, docsRoot: '/tmp/d' });
  host.deviceName = () => 'Pixel Owner';
  const w = loadBridge(host);
  const cp = w.require('child_process');
  // 引擎：W26_WindowsFullName.fullName = execSync(...).decode(gbk).split("\n")[2].trim()
  const buf = cp.execSync('chcp 936 && wmic useraccount where name="x" get fullname', { encoding: 'buffer' });
  const info = Buffer.from(buf).toString('latin1');
  assert.strictEqual(info.split('\n')[2].trim(), 'Pixel Owner');
});

test('net user %username% 走设备名，且解析后与设备名逐字一致', () => {
  const host = createHost({ gameRoot: GAME_ROOT, docsRoot: '/tmp/d' });
  host.deviceName = () => 'Pixel Owner';
  const w = loadBridge(host);
  const cp = w.require('child_process');
  // 忠实复刻引擎 W26_VisualSysOpt.getWindowsFullName 的解析逻辑。
  const info = String(cp.execSync('chcp 936 && net user %username%'));
  const arr = info.split('\n')[2].split(' ');
  let fullName = '';
  let add = false;
  for (let i = 1; i < arr.length; i++) {
    if (arr[i] !== '') add = true;
    if (add) fullName += arr[i] + ' ';
  }
  if (fullName.length > 0) fullName = fullName.substr(0, fullName.length - 2);
  assert.strictEqual(fullName, 'Pixel Owner', '引擎切掉末两字符后仍须得到完整设备名');
});

test('reg add ... /v Wallpaper 读取游戏内图片并以 base64 交给宿主 setWallpaper', () => {
  let wall = null;
  const host = createHost({ gameRoot: GAME_ROOT, docsRoot: '/tmp/d' });
  host.setWallpaper = (b64) => { wall = b64; return true; };
  host.log = () => {}; // 刷新的 rundll32 未映射，吞掉宿主日志噪声
  const w = loadBridge(host);
  const img = GAME_ROOT + '/asset/pcSys/nircmd.exe'; // 任何真实文件均可，MZ 头便于断言
  w.require('child_process').execSync(
    'reg add "HKEY_CURRENT_USER\\Control Panel\\Desktop" /v Wallpaper /t REG_SZ /d "' + img + '" /f');
  assert.ok(typeof wall === 'string' && wall.length > 0, 'setWallpaper 必须被调用');
  const bytes = Buffer.from(wall, 'base64');
  assert.strictEqual(bytes[0], 0x4d, 'M');
  assert.strictEqual(bytes[1], 0x5a, 'Z');
  // 刷新桌面的 rundll32 命令不得误触发壁纸替换
  wall = null;
  w.require('child_process').execSync('rundll32.exe user32.dll,UpdatePerUserSystemParameters');
  assert.strictEqual(wall, null);
});

test('trayballoon 真实命令形态（exe 路径带引号）只把正文交给 toast，不泄漏内部路径', () => {
  const toasts = [];
  const host = createHost({ gameRoot: GAME_ROOT, docsRoot: '/tmp/d' });
  host.toast = (m) => { toasts.push(String(m)); };
  const w = loadBridge(host);
  // 引擎 getTrayballoonPath() 返回 "\"<绝对路径>\""，所以真实命令的首个引号段
  // 就是可执行文件路径（rv.js showTrayballoon），随后才是正文与图标路径。
  const exe = '"' + GAME_ROOT + '/asset/pcSys/trayballoon.exe"';
  const icon = GAME_ROOT + '/asset/pcSys/icon.png';
  w.require('child_process').execSync(
    exe + ' "标题" "不要再看了" "5000" "0" "' + icon + '" ');
  assert.strictEqual(toasts.length, 1);
  assert.strictEqual(toasts[0], '标题 不要再看了', '只应保留真正面向用户的文本');
  assert.ok(toasts[0].indexOf('不要再看了') >= 0, '气泡正文必须传给 toast');
  assert.ok(toasts[0].indexOf('trayballoon.exe') < 0, 'exe 路径不得泄漏到提示里');
  assert.ok(toasts[0].indexOf(GAME_ROOT) < 0, '内部路径不得泄漏到提示里');
});

test('nircmd infobox 真实命令形态不把 exe 路径当作提示正文', () => {
  const toasts = [];
  const host = createHost({ gameRoot: GAME_ROOT, docsRoot: '/tmp/d' });
  host.toast = (m) => { toasts.push(String(m)); };
  const w = loadBridge(host);
  const exe = '"' + GAME_ROOT + '/asset/pcSys/nircmd.exe"';
  // 引擎：getNirCmdPath() + ' "infobox" "<content>" "<title>"'
  w.require('child_process').exec(exe + ' "infobox" "正文内容" "标题"');
  assert.strictEqual(toasts.length, 1);
  assert.ok(toasts[0].indexOf('正文内容') >= 0, '正文必须传给 toast');
  assert.ok(toasts[0].indexOf('nircmd.exe') < 0, 'exe 路径不得泄漏');
  assert.ok(toasts[0].indexOf(GAME_ROOT) < 0, '内部路径不得泄漏');
});

test('nircmd qboxcom 真实命令形态不泄漏路径，也不退出应用', () => {
  let shut = 0;
  const toasts = [];
  const host = createHost({ gameRoot: GAME_ROOT, docsRoot: '/tmp/d' });
  host.fakeShutdown = () => { shut++; };
  host.toast = (m) => { toasts.push(String(m)); };
  const w = loadBridge(host);
  const exe = '"' + GAME_ROOT + '/asset/pcSys/nircmd.exe"';
  // 引擎：... + ' "qboxcom" "<content>" "<title>" consolewrite yes'
  w.require('child_process').exec(exe + ' "qboxcom" "要退出吗" "确认" consolewrite yes');
  assert.strictEqual(toasts.length, 1);
  assert.strictEqual(toasts[0], '要退出吗 确认', '正文与标题按引擎顺序、且只有它们');
  assert.ok(toasts[0].indexOf('要退出吗') >= 0, '正文必须传给 toast');
  assert.ok(toasts[0].indexOf('consolewrite') < 0, 'qboxcom 的裸尾参数不得泄漏进提示');
  assert.ok(toasts[0].indexOf(GAME_ROOT) < 0, '内部路径不得泄漏');
  assert.strictEqual(shut, 0, 'qboxcom 不是关机命令');
});

test('提示正文含斜杠（分数）时不得被误当路径丢弃', () => {
  const toasts = [];
  const host = createHost({ gameRoot: GAME_ROOT, docsRoot: '/tmp/d' });
  host.toast = (m) => { toasts.push(String(m)); };
  const w = loadBridge(host);
  const exe = '"' + GAME_ROOT + '/asset/pcSys/nircmd.exe"';
  w.require('child_process').execSync(exe + ' "infobox" "已经有 1/2 的进度了" "提示"');
  assert.strictEqual(toasts.length, 1);
  assert.strictEqual(toasts[0], '已经有 1/2 的进度了 提示', '含斜杠的正文必须完整保留');
});

test('提示正文含反斜杠（Windows 路径玩笑）时不得被误当路径丢弃', () => {
  const toasts = [];
  const host = createHost({ gameRoot: GAME_ROOT, docsRoot: '/tmp/d' });
  host.toast = (m) => { toasts.push(String(m)); };
  const w = loadBridge(host);
  const exe = '"' + GAME_ROOT + '/asset/pcSys/nircmd.exe"';
  w.require('child_process').execSync(exe + ' "infobox" "C:\\Games\\love" "提示"');
  assert.strictEqual(toasts.length, 1);
  assert.strictEqual(toasts[0], 'C:\\Games\\love 提示', '含反斜杠的正文必须完整保留');
});

test('提示正文以 .com/.exe 结尾时不得被误当可执行文件丢弃', () => {
  const toasts = [];
  const host = createHost({ gameRoot: GAME_ROOT, docsRoot: '/tmp/d' });
  host.toast = (m) => { toasts.push(String(m)); };
  const w = loadBridge(host);
  const exe = '"' + GAME_ROOT + '/asset/pcSys/nircmd.exe"';
  w.require('child_process').execSync(exe + ' "infobox" "www.baidu.com" "标题"');
  assert.strictEqual(toasts.length, 1);
  assert.strictEqual(toasts[0], 'www.baidu.com 标题', '以 .com 结尾的正文必须完整保留');
  toasts.length = 0;
  w.require('child_process').execSync(exe + ' "infobox" "点击 setup.exe" "安装"');
  assert.strictEqual(toasts[0], '点击 setup.exe 安装', '正文里的 .exe 只是文字，不是被启动的文件');
});

test('消息正文里出现 shutdown 时仍只弹提示，绝不退出应用（Fix 2）', () => {
  let shut = 0;
  const toasts = [];
  const host = createHost({ gameRoot: GAME_ROOT, docsRoot: '/tmp/d' });
  host.fakeShutdown = () => { shut++; };
  host.toast = (m) => { toasts.push(String(m)); };
  const w = loadBridge(host);
  const exe = '"' + GAME_ROOT + '/asset/pcSys/nircmd.exe"';
  w.require('child_process').execSync(exe + ' "infobox" "shutdown" "系统提示"');
  assert.strictEqual(shut, 0, '正文里的 shutdown 不得导致应用退出');
  assert.strictEqual(toasts.length, 1, '必须仍然弹提示');
  assert.ok(toasts[0].indexOf('shutdown') >= 0);
});

test('未映射的 Windows 命令写宿主日志并返回空串；exec 的 stdout 通过回调异步送达', async () => {
  const logs = [];
  const host = createHost({ gameRoot: GAME_ROOT, docsRoot: '/tmp/d' });
  host.log = (s) => { logs.push(String(s)); };
  const w = loadBridge(host);
  const cp = w.require('child_process');
  assert.strictEqual(cp.execSync('chcp 936 && wmic cpu get Name'), '');
  assert.ok(logs.some((s) => s.indexOf('wmic cpu get Name') >= 0), '未映射命令必须记录');
  const buf = cp.execSync('chcp 936 && wmic memorychip get Capacity', { encoding: 'buffer' });
  assert.ok(buf && typeof buf.length === 'number' && buf.length === 0);
  const seen = await new Promise((resolve, reject) => {
    cp.exec('chcp 936 && wmic cpu get Name', { encoding: 'buffer' }, (err, out, stderr) => {
      if (err) reject(err); else resolve({ out, stderr });
    });
  });
  assert.strictEqual(Buffer.from(seen.out).length, 0);
  assert.strictEqual(seen.stderr, '', '引擎用 stderr.length > 0 判定失败，必须为空串');
});

test('exec 回调签名与 Node 一致：(error, stdout, stderr)，且不阻塞返回', async () => {
  const host = createHost({ gameRoot: GAME_ROOT, docsRoot: '/tmp/d' });
  host.androidVersion = () => '14';
  const w = loadBridge(host);
  const cp = w.require('child_process');
  const seen = await new Promise((resolve) => {
    const ret = cp.exec('chcp 936 && wmic os get Caption', { encoding: 'buffer' }, (err, out, stderr) => {
      resolve({ err, out, stderr });
    });
    assert.strictEqual(ret, undefined, 'exec 必须立即返回 undefined');
  });
  assert.strictEqual(seen.err, null);
  assert.strictEqual(Buffer.from(seen.out).toString('latin1'), '\n\nAndroid 14');
  assert.strictEqual(seen.stderr, '');
});

test('process.exec / process.execSync 转发到同一个命令路由器（Task 2 的接缝）', () => {
  let shut = 0;
  const host = createHost({ gameRoot: GAME_ROOT, docsRoot: '/tmp/d' });
  host.fakeShutdown = () => { shut++; };
  host.androidVersion = () => '14';
  const w = loadBridge(host);
  // 修复前的 no-op 代理会让这两条断言静默通过/失败，故必须真正驱动副作用
  w.process.exec(GAME_ROOT + '/asset/pcSys/nircmd.exe "shutdown"');
  assert.strictEqual(shut, 1, 'process.exec 必须到达命令路由器');
  assert.strictEqual(w.process.execSync('chcp 936 && wmic os get Caption'), '\n\nAndroid 14');
});

test('spawn 返回带 on("close") 的子进程对象并把弹窗映射为 toast', async () => {
  const toasts = [];
  const host = createHost({ gameRoot: GAME_ROOT, docsRoot: '/tmp/d' });
  host.toast = (m) => { toasts.push(String(m)); };
  const w = loadBridge(host);
  const cp = w.require('child_process');
  const exe = GAME_ROOT + '/asset/pcSys/MessageShow.exe';
  const ps = cp.spawn(exe, ['正文', '标题', 'MB_OK', 'MB_ICONASTERISK'], { shell: false });
  assert.strictEqual(typeof ps.on, 'function');
  const code = await new Promise((resolve) => { ps.on('close', (c) => resolve(c)); });
  assert.strictEqual(code, 0);
  assert.strictEqual(toasts.length, 1);
  assert.ok(toasts[0].indexOf('正文') >= 0);
});

test('nw.gui Window 提供引擎实际调用的全部成员，close 映射为宿主退出', () => {
  let shut = 0;
  const host = createHost({ gameRoot: GAME_ROOT, docsRoot: '/tmp/d' });
  host.fakeShutdown = () => { shut++; };
  const w = loadBridge(host);
  const win = w.require('nw.gui').Window.get();
  ['close', 'hide', 'show', 'moveTo', 'resizeTo', 'minimize', 'maximize', 'restore',
    'setResizable', 'setAlwaysOnTop', 'setMaximumSize', 'setMinimumSize',
    'enterFullscreen', 'leaveFullscreen', 'getPrinters', 'print', 'on']
    .forEach((name) => assert.strictEqual(typeof win[name], 'function', name + ' 必须是函数'));
  assert.strictEqual(typeof win.x, 'number');
  assert.strictEqual(typeof win.y, 'number');
  assert.strictEqual(typeof win.width, 'number');
  assert.strictEqual(typeof win.height, 'number');
  // 引擎启动时即调用 Window.get()，且不会因这些调用抛出。
  assert.doesNotThrow(() => {
    win.setResizable(true);
    win.moveTo(0, 0);
    win.resizeTo(1600, 900);
    win.enterFullscreen();
    win.on('close', () => {});
  });
  assert.strictEqual(shut, 0, '普通窗口控制不得触发退出');
  win.close(true);
  assert.strictEqual(shut, 1, 'Window.close() 即安卓的退出应用');
});

test('nw.gui Clipboard 读写走宿主剪贴板桥', () => {
  let set = null;
  const host = createHost({ gameRoot: GAME_ROOT, docsRoot: '/tmp/d' });
  host.clipboardGet = () => '剪贴板内容';
  host.clipboardSet = (s) => { set = String(s); };
  const w = loadBridge(host);
  const clip = w.require('nw.gui').Clipboard.get();
  assert.strictEqual(clip.get('text'), '剪贴板内容');
  clip.set('写回内容', 'text');
  assert.strictEqual(set, '写回内容');
});

test('nw.gui Shell.openItem 走宿主的系统 Intent 打开文件', () => {
  const opened = [];
  const host = createHost({ gameRoot: GAME_ROOT, docsRoot: '/tmp/d' });
  host.openFile = (p) => { opened.push(String(p)); return true; };
  const w = loadBridge(host);
  const ok = w.require('nw.gui').Shell.openItem(GAME_ROOT + '/index.html');
  assert.deepStrictEqual(opened, [GAME_ROOT + '/index.html']);
  assert.strictEqual(ok, true);
});

/* ------------------------------------------------------------------ *
 * Task 5 — engine boot gaps (exposed by `run.js --inject`)
 * ------------------------------------------------------------------ */

test('fs.constants 暴露 F_OK/X_OK/W_OK/R_OK（Node 取值）', () => {
  const w = loadBridge(createHost({ gameRoot: GAME_ROOT, docsRoot: '/tmp/d' }));
  const c = w.require('fs').constants;
  // 这是启动时第一个 ReferenceError（W26_TraceConsole.ensureDirExists）。
  assert.strictEqual(c.F_OK, 0);
  assert.strictEqual(c.X_OK, 1);
  assert.strictEqual(c.W_OK, 2);
  assert.strictEqual(c.R_OK, 4);
});

test('fs.accessSync 用存在性判定可访问性，缺失 ENOENT、越界 EACCES', () => {
  const w = loadBridge(createHost({ gameRoot: GAME_ROOT, docsRoot: '/tmp/d' }));
  const fsShim = w.require('fs');
  const F_OK = fsShim.constants.F_OK;
  assert.doesNotThrow(() => fsShim.accessSync(GAME_ROOT + '/index.html', F_OK));
  assert.throws(() => fsShim.accessSync(GAME_ROOT + '/__nope__.png', F_OK),
    (err) => err && err.code === 'ENOENT');
  assert.throws(() => fsShim.accessSync('/etc/passwd', F_OK),
    (err) => err && err.code === 'EACCES');
});

test('fs.copyFileSync 逐字节复制源文件并落到目标（经宿主 writeBase64）', () => {
  const host = createHost({ gameRoot: GAME_ROOT, docsRoot: '/tmp/d' });
  const writes = [];
  host.writeBase64 = (p, b64) => { writes.push({ p: String(p), b64: String(b64) }); return true; };
  const w = loadBridge(host);
  const fsShim = w.require('fs');
  fsShim.copyFileSync(GAME_ROOT + '/icon.png', '/tmp/d/icon-copy.png');
  assert.strictEqual(writes.length, 1);
  assert.strictEqual(writes[0].p, '/tmp/d/icon-copy.png');
  assert.strictEqual(writes[0].b64, fs.readFileSync(GAME_ROOT + '/icon.png').toString('base64'));
  assert.throws(() => fsShim.copyFileSync(GAME_ROOT + '/__nope__', '/tmp/d/x'),
    (err) => err && err.code === 'ENOENT');
});

test('fs.renameSync 经真实宿主真的移动文件，移动后可读回', () => {
  const docs = fs.mkdtempSync('/tmp/lovenest-rename-');
  try {
    const w = loadBridge(createHost({ gameRoot: GAME_ROOT, docsRoot: docs }));
    const fsShim = w.require('fs');
    const src = docs + '/save.gcdata';
    const dst = docs + '/save.gcdata.bak';
    fsShim.writeFileSync(src, '存档内容');
    assert.strictEqual(fsShim.existsSync(src), true);

    fsShim.renameSync(src, dst);

    assert.strictEqual(fsShim.existsSync(src), false, '源文件必须真的消失');
    assert.strictEqual(fsShim.existsSync(dst), true, '目标文件必须真的出现');
    assert.strictEqual(fsShim.readFileSync(dst, 'utf8'), '存档内容');
    // Cross-check against the real filesystem, not just the shim's own view.
    assert.strictEqual(fs.existsSync(src), false);
    assert.strictEqual(fs.readFileSync(dst, 'utf8'), '存档内容');
  } finally {
    fs.rmSync(docs, { recursive: true, force: true });
  }
});

test('fs.renameSync 源缺失 → ENOENT，任一端越界 → EACCES', () => {
  const docs = fs.mkdtempSync('/tmp/lovenest-rename-err-');
  try {
    const w = loadBridge(createHost({ gameRoot: GAME_ROOT, docsRoot: docs }));
    const fsShim = w.require('fs');
    assert.throws(() => fsShim.renameSync(docs + '/__nope__', docs + '/x'),
      (err) => err && err.code === 'ENOENT');
    assert.throws(() => fsShim.renameSync('/etc/passwd', docs + '/x'),
      (err) => err && err.code === 'EACCES');
    assert.throws(() => fsShim.renameSync(docs + '/a', '/etc/passwd'),
      (err) => err && err.code === 'EACCES');
  } finally {
    fs.rmSync(docs, { recursive: true, force: true });
  }
});

test('fs.rmdirSync 经真实宿主删除真实空目录', () => {
  const docs = fs.mkdtempSync('/tmp/lovenest-rmdir-');
  try {
    const w = loadBridge(createHost({ gameRoot: GAME_ROOT, docsRoot: docs }));
    const fsShim = w.require('fs');
    const dir = docs + '/empty-dir';
    fsShim.mkdirSync(dir);
    assert.strictEqual(fs.existsSync(dir), true);

    fsShim.rmdirSync(dir);

    assert.strictEqual(fs.existsSync(dir), false, '空目录必须真的被删除');
    assert.strictEqual(fsShim.existsSync(dir), false);
  } finally {
    fs.rmSync(docs, { recursive: true, force: true });
  }
});

test('fs.rmdirSync 非空目录 → ENOTEMPTY，文件 → ENOTDIR，缺失 → ENOENT，越界 → EACCES', () => {
  const docs = fs.mkdtempSync('/tmp/lovenest-rmdir-err-');
  try {
    const w = loadBridge(createHost({ gameRoot: GAME_ROOT, docsRoot: docs }));
    const fsShim = w.require('fs');
    const full = docs + '/full';
    fsShim.mkdirSync(full);
    fsShim.writeFileSync(full + '/x.txt', 'x');
    assert.throws(() => fsShim.rmdirSync(full),
      (err) => err && err.code === 'ENOTEMPTY');
    assert.throws(() => fsShim.rmdirSync(full + '/x.txt'),
      (err) => err && err.code === 'ENOTDIR');
    assert.throws(() => fsShim.rmdirSync(docs + '/__nope__'),
      (err) => err && err.code === 'ENOENT');
    assert.throws(() => fsShim.rmdirSync('/etc'),
      (err) => err && err.code === 'EACCES');
  } finally {
    fs.rmSync(docs, { recursive: true, force: true });
  }
});

test('fs.rename/fs.rmdir 异步形式经真实宿主生效，错误交给回调', async () => {
  const docs = fs.mkdtempSync('/tmp/lovenest-async-');
  try {
    const w = loadBridge(createHost({ gameRoot: GAME_ROOT, docsRoot: docs }));
    const fsShim = w.require('fs');
    const src = docs + '/a.txt';
    const dst = docs + '/b.txt';
    fsShim.writeFileSync(src, 'hi');

    const renameErr = await new Promise((resolve) => fsShim.rename(src, dst, resolve));
    assert.strictEqual(renameErr, null);
    assert.strictEqual(fs.existsSync(src), false);
    assert.strictEqual(fs.readFileSync(dst, 'utf8'), 'hi');

    const rmdirErr = await new Promise((resolve) => fsShim.rmdir(docs + '/__nope__', resolve));
    assert.ok(rmdirErr && rmdirErr.code === 'ENOENT');
  } finally {
    fs.rmSync(docs, { recursive: true, force: true });
  }
});

test('fs.createWriteStream 异步触发 finish 再 close（否则等待的 SyncTask 永挂起）', async () => {
  const w = loadBridge(createHost({ gameRoot: GAME_ROOT, docsRoot: '/tmp/d' }));
  const fsShim = w.require('fs');
  const ws = fsShim.createWriteStream('/tmp/d/日志.txt', { flags: 'a' });
  assert.strictEqual(ws.write('hello', 'utf8'), true);
  const events = [];
  ws.on('finish', () => events.push('finish'));
  ws.on('close', () => events.push('close'));
  ws.end();
  assert.deepStrictEqual(events, [], 'finish/close 必须异步，先于监听器注册就不会触发');
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.deepStrictEqual(events, ['finish', 'close']);
});

test('fs.createReadStream().pipe() 交付源文件字节并发出 end', async () => {
  const w = loadBridge(createHost({ gameRoot: GAME_ROOT, docsRoot: '/tmp/d' }));
  const fsShim = w.require('fs');
  const chunks = [];
  let ended = false;
  let endEvent = false;
  const dest = { write: (b) => { chunks.push(b); }, end: () => { ended = true; } };
  const rs = fsShim.createReadStream(GAME_ROOT + '/index.html');
  rs.on('end', () => { endEvent = true; });
  rs.pipe(dest);
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.strictEqual(chunks.length, 1);
  assert.strictEqual(Buffer.from(chunks[0]).length, fs.statSync(GAME_ROOT + '/index.html').size);
  assert.strictEqual(ended, true);
  assert.strictEqual(endEvent, true);
});

test('fs.createReadStream 读缺失文件时发出 error 而非抛异常', async () => {
  const w = loadBridge(createHost({ gameRoot: GAME_ROOT, docsRoot: '/tmp/d' }));
  const fsShim = w.require('fs');
  let err = null;
  const rs = fsShim.createReadStream(GAME_ROOT + '/__nope__');
  rs.on('error', (e) => { err = e; });
  rs.pipe({ write: () => {}, end: () => {} });
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.ok(err && err.code === 'ENOENT');
});

test('window.Buffer.from(str,"base64") 与 Node 逐字节一致，并带 TypedArray 形状', () => {
  const w = loadBridge(createHost({ gameRoot: GAME_ROOT, docsRoot: '/tmp/d' }));
  const B = w.Buffer;
  assert.strictEqual(typeof B, 'function');
  const original = fs.readFileSync(GAME_ROOT + '/icon.png');
  const decoded = B.from(original.toString('base64'), 'base64');
  assert.strictEqual(decoded.length, original.length);
  assert.strictEqual(Buffer.compare(Buffer.from(decoded), original), 0);
  assert.ok(decoded.buffer && typeof decoded.buffer.byteLength === 'number');
  assert.strictEqual(typeof decoded.byteOffset, 'number');
  assert.strictEqual(decoded.byteLength, decoded.length);
  assert.strictEqual(B.isBuffer(decoded), true);
  assert.strictEqual(B.isBuffer('not-a-buffer'), false);
});

test('new Buffer(str,"base64") 构造形式同样可用（Live2D wasm 加载器的兜底分支）', () => {
  const w = loadBridge(createHost({ gameRoot: GAME_ROOT, docsRoot: '/tmp/d' }));
  const original = fs.readFileSync(GAME_ROOT + '/icon.png');
  const viaNew = new w.Buffer(original.toString('base64'), 'base64');
  assert.strictEqual(Buffer.compare(Buffer.from(viaNew), original), 0);
});

test('Buffer.from(Uint8Array) 复制而非共享底层字节', () => {
  const w = loadBridge(createHost({ gameRoot: GAME_ROOT, docsRoot: '/tmp/d' }));
  const B = w.Buffer;
  const src = new Uint8Array([1, 2, 3]);
  const copy = B.from(src);
  copy[0] = 9;
  assert.strictEqual(src[0], 1, 'Node 的 Buffer.from 是拷贝语义');
  assert.strictEqual(B.byteLength('abc'), 3);
  assert.strictEqual(B.from('héllo', 'utf8').length, 6);
  assert.strictEqual(B.alloc(4).length, 4);
});

/* ------------------------------------------------------------------ *
 * Task 7b — the three remaining Meta-performance gaps
 *
 * The engine reaches the phone's real wallpaper through a virtual
 * `%APPDATA%\Microsoft\Windows\Themes` tree (`fs` only, no child_process),
 * asks a yes/no question through `nircmd qboxcom` (`stdout.trim() == "yes"`),
 * and darkens the screen through `scrnsave.scr /s`. Task 4 measured all three
 * as non-landing; these tests pin the routing that closes them.
 * ------------------------------------------------------------------ */

test('APPDATA\\Microsoft\\Windows\\Themes 壁纸读取经 getWallpaper() 返回真实字节', () => {
  const real = fs.readFileSync(GAME_ROOT + '/icon.png').toString('base64');
  let asked = 0;
  const host = createHost({ gameRoot: GAME_ROOT, docsRoot: '/tmp/d' });
  host.getWallpaper = () => { asked++; return real; };
  const w = loadBridge(host);
  const fsShim = w.require('fs');
  const path = w.require('path');

  // Exactly the paths W26_DesktopWallpaper builds from process.env.APPDATA.
  const cached = path.join(w.process.env.APPDATA, '\\Microsoft\\Windows\\Themes\\CachedFiles\\');
  assert.strictEqual(fsShim.existsSync(cached), true, '有壁纸时 CachedFiles 必须如实存在');
  const names = fsShim.readdirSync(cached);
  assert.ok(Array.isArray(names) && names.length > 0, 'CachedFiles 必须列出至少一个文件');

  const file = path.join(cached, names[0]);
  assert.doesNotThrow(() => fsShim.accessSync(file, fsShim.constants.R_OK | fsShim.constants.F_OK));
  const bytes = fsShim.readFileSync(file, { encoding: null });
  assert.strictEqual(bytes.toString('base64'), real, '读回的必须是壁纸的真实字节');

  // The engine's own last step: "data:image/png;base64," + data.toString('base64').
  assert.strictEqual(
    'data:image/png;base64,' + bytes.toString('base64'),
    'data:image/png;base64,' + real);
  assert.ok(asked > 0, 'getWallpaper() 必须被调用');

  // No wallpaper -> the tree reports "absent", the way a fresh Windows profile
  // does, and the engine degrades to an empty string rather than a corrupt URL.
  host.getWallpaper = () => null;
  assert.strictEqual(fsShim.existsSync(cached), false);
  assert.throws(() => fsShim.readFileSync(file, { encoding: null }),
    (err) => err && err.code === 'ENOENT');
});

test('nircmd qboxcom 路由到 confirm()，并据其返回值在 stdout 恰好产出 "yes" / ""', async () => {
  const asks = [];
  let answer = true;
  const host = createHost({ gameRoot: GAME_ROOT, docsRoot: '/tmp/d' });
  host.toast = () => {}; // the notification is not what this test pins
  host.confirm = (title, body) => { asks.push([String(title), String(body)]); return answer; };
  const w = loadBridge(host);
  const cp = w.require('child_process');
  const exe = '"' + GAME_ROOT + '/asset/pcSys/nircmd.exe"';
  const cmd = exe + ' "qboxcom" "要退出吗" "确认" consolewrite yes';

  // The engine calls exec (not execSync) and compares stdout.trim() == "yes".
  const yes = await new Promise((resolve) => {
    cp.exec(cmd, (err, stdout) => resolve(String(stdout)));
  });
  assert.strictEqual(yes.trim(), 'yes', '用户答“是”时 stdout.trim() 必须是 "yes"');
  assert.deepStrictEqual(asks, [['确认', '要退出吗']], 'confirm(title, body) 的参数顺序');

  asks.length = 0;
  answer = false;
  const no = await new Promise((resolve) => {
    cp.exec(cmd, (err, stdout) => resolve(String(stdout)));
  });
  assert.strictEqual(no, '', '用户答“否”时 stdout 必须是空串（不得是 "no"）');
  assert.deepStrictEqual(asks, [['确认', '要退出吗']]);
});

test('offMonitor 的 scrnsave.scr /s 命令路由到 screenOff()（不是关机、不是只写日志）', () => {
  let off = 0;
  let shut = 0;
  const host = createHost({ gameRoot: GAME_ROOT, docsRoot: '/tmp/d' });
  host.log = () => {};
  host.fakeShutdown = () => { shut++; };
  host.screenOff = () => { off++; };
  const w = loadBridge(host);
  const cp = w.require('child_process');

  cp.exec('"undefined\\system32\\scrnsave.scr" /s', () => {});
  assert.strictEqual(off, 1, 'exec 形态必须熄屏');
  assert.strictEqual(shut, 0, '关显示器不得被当成关机');

  assert.strictEqual(cp.execSync('"undefined\\system32\\scrnsave.scr" /s'), '');
  assert.strictEqual(off, 2, 'execSync 形态必须熄屏');
  assert.strictEqual(shut, 0);
});

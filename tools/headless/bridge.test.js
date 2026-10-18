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

test('trayballoon 命令转为宿主 toast，并把消息正文带给用户', () => {
  const toasts = [];
  const host = createHost({ gameRoot: GAME_ROOT, docsRoot: '/tmp/d' });
  host.toast = (m) => { toasts.push(String(m)); };
  const w = loadBridge(host);
  w.require('child_process').execSync(
    GAME_ROOT + '/asset/pcSys/trayballoon.exe "标题" "不要再看了" "5000" "0" "1" ');
  assert.strictEqual(toasts.length, 1);
  assert.ok(toasts[0].indexOf('不要再看了') >= 0, '气泡正文必须传给 toast');
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
  assert.strictEqual(Buffer.from(seen.out).toString('latin1'), 'Android 14');
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
  assert.strictEqual(w.process.execSync('chcp 936 && wmic os get Caption'), 'Android 14');
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

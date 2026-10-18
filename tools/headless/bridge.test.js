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

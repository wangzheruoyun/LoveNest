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

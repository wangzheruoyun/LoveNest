'use strict';

/**
 * Contract tests for the rest of the `createHost()` surface.
 *
 * `host-native.test.js` is the minimal contract fixed by the plan and covers
 * three methods. The host implements the rest, and every later JS task builds
 * on them, so the remaining behaviour — path resolution / escape rejection,
 * base64 round trips, the failure-never-throws rule, and the "game folder is
 * never written to" constraint — is pinned down here.
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { createHost } = require('./host-native');

const GAME_ROOT = '/storage/emulated/0/Download/爱之巢DemoV1.52';
const DOCS_ROOT = '/tmp/lovenest-contract-' + process.pid;

// The full `__GCNative` method list from the plan's Task 3 Interfaces, extended
// by Task 5 fix round 2 with `rename`/`rmdir` (21 methods) and by Task 7b with
// `getWallpaper`/`confirm`/`screenOff` (24 methods).
const METHOD_NAMES = [
  'gameRoot',
  'docsRoot',
  'exists',
  'stat',
  'readBase64',
  'writeBase64',
  'readDir',
  'mkdirp',
  'unlink',
  'rename',
  'rmdir',
  'deviceName',
  'androidVersion',
  'setWallpaper',
  'getWallpaper',
  'confirm',
  'screenOff',
  'toast',
  'fakeShutdown',
  'openFile',
  'vibrate',
  'clipboardGet',
  'clipboardSet',
  'log',
];

const host = createHost({ gameRoot: GAME_ROOT, docsRoot: DOCS_ROOT });

test.after(() => {
  fs.rmSync(DOCS_ROOT, { recursive: true, force: true });
});

/** Collects `console.log` output instead of printing, so test output stays clean. */
function capturedConsole(fn) {
  const original = console.log;
  const lines = [];
  console.log = (...args) => lines.push(args.join(' '));
  try {
    fn();
  } finally {
    console.log = original;
  }
  return lines;
}

/** Paths, sizes and mtimes of an entire tree, for before/after comparison. */
function snapshotTree(root) {
  const entries = [];
  const walk = (dir) => {
    for (const name of fs.readdirSync(dir).sort()) {
      const abs = path.join(dir, name);
      const st = fs.lstatSync(abs);
      if (st.isDirectory()) {
        entries.push(abs + ' [dir]');
        walk(abs);
      } else {
        entries.push(abs + ' ' + st.size + ' ' + st.mtimeMs);
      }
    }
  };
  walk(root);
  return entries;
}

// Escapes both roots: `..` climbs above gameRoot, a bare /etc path is outside.
const ESCAPING_PATHS = [
  GAME_ROOT + '/../escape.txt',
  GAME_ROOT + '/asset/../../escape.txt',
  '/etc/passwd',
  '../escape.txt',
];

test('实现 Task 3 Interfaces 的全部 24 个方法，不多不少', () => {
  assert.deepStrictEqual(Object.keys(host).sort(), [...METHOD_NAMES].sort());
  for (const name of METHOD_NAMES) {
    assert.strictEqual(typeof host[name], 'function', name + ' 必须是函数');
  }
});

test('gameRoot()/docsRoot() 返回去尾斜杠的绝对路径', () => {
  assert.strictEqual(host.gameRoot(), GAME_ROOT);
  assert.strictEqual(host.docsRoot(), DOCS_ROOT);

  const noisy = createHost({ gameRoot: GAME_ROOT + '///', docsRoot: DOCS_ROOT + '//' });
  assert.strictEqual(noisy.gameRoot(), GAME_ROOT);
  assert.strictEqual(noisy.docsRoot(), DOCS_ROOT);
});

test('相对路径按 gameRoot 解析，以 / 开头的路径视为绝对路径', () => {
  assert.strictEqual(host.exists('index.html'), true);
  assert.strictEqual(host.exists(GAME_ROOT + '/index.html'), true);
  assert.strictEqual(host.exists('asset'), true);
});

test('stat() 返回 {"isDirectory":Boolean,"size":Number} 的 JSON 文本', () => {
  const file = JSON.parse(host.stat('index.html'));
  assert.strictEqual(file.isDirectory, false);
  assert.strictEqual(typeof file.size, 'number');
  assert.ok(file.size > 0);

  const dir = JSON.parse(host.stat(GAME_ROOT));
  assert.strictEqual(dir.isDirectory, true);

  assert.strictEqual(host.stat('definitely-missing-file.xyz'), null);
});

test('readDir() 返回 JSON 名称数组', () => {
  const names = JSON.parse(host.readDir(GAME_ROOT));
  assert.ok(Array.isArray(names));
  assert.ok(names.indexOf('index.html') >= 0);
  assert.ok(names.indexOf('script.js') >= 0);

  // A failure still returns parseable JSON, never a throw.
  assert.strictEqual(host.readDir('definitely-missing-dir'), '[]');
  assert.strictEqual(host.readDir('index.html'), '[]', '文件不是目录');
});

test('writeBase64/readBase64 往返二进制，自动创建父目录，落在 docsRoot', () => {
  const allBytes = Buffer.from(Array.from({ length: 256 }, (_, i) => i));
  const b64 = allBytes.toString('base64');
  const target = DOCS_ROOT + '/deeply/nested/blob.bin';

  assert.strictEqual(host.writeBase64(target, b64), true);
  assert.strictEqual(host.exists(target), true);
  assert.strictEqual(host.readBase64(target), b64);
  assert.ok(Buffer.from(host.readBase64(target), 'base64').equals(allBytes));
});

test('存档路径基于 docsRoot 可用（os.homedir() 映射的落点）', () => {
  const save = DOCS_ROOT + '/Documents/爱之巢 Demo/save1.json';
  const text = '{"名字":"爱之巢","进度":42}';
  const b64 = Buffer.from(text, 'utf8').toString('base64');

  assert.strictEqual(host.writeBase64(save, b64), true);
  assert.strictEqual(Buffer.from(host.readBase64(save), 'base64').toString('utf8'), text);

  assert.strictEqual(host.exists(save), true);
  assert.strictEqual(JSON.parse(host.stat(save)).isDirectory, false);
});

test('mkdirp() 与 unlink() 工作，且 unlink 拒绝目录', () => {
  const dir = DOCS_ROOT + '/made/up/dir';
  assert.strictEqual(host.mkdirp(dir), true);
  assert.strictEqual(JSON.parse(host.stat(dir)).isDirectory, true);
  assert.strictEqual(host.mkdirp(dir), true, '重复创建不是错误');

  const file = dir + '/x.txt';
  assert.strictEqual(host.writeBase64(file, Buffer.from('x').toString('base64')), true);
  assert.strictEqual(host.unlink(file), true);
  assert.strictEqual(host.exists(file), false);

  assert.strictEqual(host.unlink(dir), false, 'unlink 不得删除目录');
  assert.strictEqual(host.unlink(file), false, '删除不存在的文件返回 false');
});

test('rename() 与 rmdir() 工作，后者拒绝非空目录与文件', () => {
  const dir = DOCS_ROOT + '/mut';
  assert.strictEqual(host.mkdirp(dir), true);
  const src = dir + '/a.txt';
  const dst = dir + '/b.txt';
  assert.strictEqual(host.writeBase64(src, Buffer.from('move me').toString('base64')), true);

  assert.strictEqual(host.rename(src, dst), true);
  assert.strictEqual(host.exists(src), false);
  assert.strictEqual(Buffer.from(host.readBase64(dst), 'base64').toString('utf8'), 'move me');
  assert.strictEqual(host.rename(src, dst), false, '重命名不存在的文件返回 false');

  // rmdir only removes empty directories.
  const empty = dir + '/empty';
  assert.strictEqual(host.mkdirp(empty), true);
  assert.strictEqual(host.rmdir(empty), true);
  assert.strictEqual(host.exists(empty), false);
  assert.strictEqual(host.rmdir(dir), false, '非空目录不得删除');
  assert.strictEqual(host.rmdir(dst), false, '文件不是目录');
  assert.strictEqual(host.rmdir(dir + '/__nope__'), false, '不存在的目录返回 false');
});

test('逃逸出 gameRoot/docsRoot 的路径一律被拒绝', () => {
  for (const p of ESCAPING_PATHS) {
    assert.strictEqual(host.exists(p), false, 'exists ' + p);
    assert.strictEqual(host.stat(p), null, 'stat ' + p);
    assert.strictEqual(host.readBase64(p), null, 'readBase64 ' + p);
    assert.strictEqual(host.readDir(p), '[]', 'readDir ' + p);
    assert.strictEqual(host.mkdirp(p), false, 'mkdirp ' + p);
    assert.strictEqual(host.unlink(p), false, 'unlink ' + p);
    assert.strictEqual(host.rename(p, DOCS_ROOT + '/x'), false, 'rename src ' + p);
    assert.strictEqual(host.rmdir(p), false, 'rmdir ' + p);
    assert.strictEqual(host.writeBase64(p, 'aGk='), false, 'writeBase64 ' + p);
  }
  assert.strictEqual(fs.existsSync('/tmp/escape.txt'), false, '不得真的写出逃逸文件');
});

test('空路径与不存在的路径返回 null/false/[]，从不抛异常', () => {
  for (const p of ['', null, undefined]) {
    assert.strictEqual(host.exists(p), false);
    assert.strictEqual(host.stat(p), null);
    assert.strictEqual(host.readBase64(p), null);
    assert.strictEqual(host.readDir(p), '[]');
    assert.strictEqual(host.mkdirp(p), false);
    assert.strictEqual(host.unlink(p), false);
    assert.strictEqual(host.rename(p, DOCS_ROOT + '/x'), false);
    assert.strictEqual(host.rmdir(p), false);
    assert.strictEqual(host.writeBase64(p, 'aGk='), false);
  }

  const missing = DOCS_ROOT + '/not/here/at/all.bin';
  assert.strictEqual(host.readBase64(missing), null, '读不存在的文件');
  assert.strictEqual(host.readBase64(GAME_ROOT), null, '读目录不是崩溃');
  assert.strictEqual(host.exists(GAME_ROOT + '/nope_missing_file.xyz'), false);
});

test('前缀相同的兄弟目录不算在 root 之内', () => {
  // `<docsRoot>-evil` shares a string prefix with docsRoot but is outside it.
  const sibling = DOCS_ROOT + '-evil';
  fs.mkdirSync(sibling, { recursive: true });
  fs.writeFileSync(path.join(sibling, 'secret.txt'), 'nope');
  try {
    assert.strictEqual(host.exists(sibling + '/secret.txt'), false);
    assert.strictEqual(host.readBase64(sibling + '/secret.txt'), null);
    assert.strictEqual(host.mkdirp(sibling + '/sub'), false);
    assert.strictEqual(host.writeBase64(sibling + '/new.txt', 'aGk='), false);
    assert.strictEqual(fs.existsSync(path.join(sibling, 'new.txt')), false);
    assert.strictEqual(fs.existsSync(path.join(sibling, 'sub')), false);
  } finally {
    fs.rmSync(sibling, { recursive: true, force: true });
  }
});

test('无头宿主的设备类方法返回固定桩值', () => {
  assert.strictEqual(host.deviceName(), 'Headless Host');
  assert.strictEqual(host.androidVersion(), '0');
  assert.strictEqual(host.setWallpaper('aGk='), false);
  assert.strictEqual(host.clipboardGet(), '');

  const lines = capturedConsole(() => {
    assert.strictEqual(host.openFile('/some/file.txt'), false);
  });
  assert.strictEqual(lines.length, 1, 'openFile 记录一次尝试');
});

test('toast/fakeShutdown/vibrate/clipboardSet/log 写入控制台且不抛异常', () => {
  const lines = capturedConsole(() => {
    host.toast('你好');
    host.fakeShutdown();
    host.vibrate(100);
    host.clipboardSet('剪贴板');
    host.log('引擎日志');
  });

  assert.strictEqual(lines.length, 5);
  assert.ok(lines[0].indexOf('你好') >= 0, 'toast 内容应可见');
  assert.ok(lines[4].indexOf('引擎日志') >= 0, 'log 内容应可见');
});

test('读取游戏目录与写入 docsRoot 都不会改动游戏目录', () => {
  const before = snapshotTree(GAME_ROOT);

  // Representative traffic: the reads the engine will do, plus real save writes.
  host.exists('index.html');
  host.readBase64('icon.png');
  host.readDir(GAME_ROOT);
  host.stat('script.js');
  host.writeBase64(DOCS_ROOT + '/Documents/爱之巢/save.json', Buffer.from('{}').toString('base64'));
  host.mkdirp(DOCS_ROOT + '/Documents/爱之巢/sub');
  host.unlink(DOCS_ROOT + '/Documents/爱之巢/save.json');

  assert.deepStrictEqual(snapshotTree(GAME_ROOT), before);
});

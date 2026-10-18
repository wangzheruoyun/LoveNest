const test = require('node:test');
const assert = require('node:assert');
const { createHost } = require('./host-native');

const GAME_ROOT = '/storage/emulated/0/Download/爱之巢DemoV1.52';

test('exists() 对存在的游戏文件返回 true，对不存在的返回 false', () => {
  const host = createHost({ gameRoot: GAME_ROOT, docsRoot: '/tmp/lovenest-docs' });
  assert.strictEqual(host.exists('index.html'), true);
  assert.strictEqual(host.exists('nope_missing_file.xyz'), false);
});

test('readBase64() 往返中文路径下的文件', () => {
  const host = createHost({ gameRoot: GAME_ROOT, docsRoot: '/tmp/lovenest-docs' });
  const b64 = host.readBase64('icon.png');
  assert.ok(b64 && b64.length > 0, '应读到 icon.png');
  assert.strictEqual(Buffer.from(b64, 'base64').length > 0, true);
});

test('gameRoot() 返回去尾斜杠的绝对路径', () => {
  const host = createHost({ gameRoot: GAME_ROOT + '/', docsRoot: '/tmp/lovenest-docs' });
  assert.strictEqual(host.gameRoot(), GAME_ROOT);
});

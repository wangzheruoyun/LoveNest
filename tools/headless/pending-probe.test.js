const test = require('node:test');
const assert = require('node:assert');
const vm = require('node:vm');
const fs = require('node:fs');
const path = require('node:path');
const { createHost } = require('./host-native');

/**
 * `pend=<n>` in the black-screen diagnostics is the load-bearing evidence for
 * "the engine is stalled waiting on I/O": a request that appears in the dump's
 * `pending` table but that the browser actually finished would make the whole
 * theory wrong. This file pins the pending table against the one XHR pattern
 * that the probe's bookkeeping gets wrong - reusing an `XMLHttpRequest` object,
 * which is exactly what a resource loader does for a batch of sibling files.
 */

const GAME_ROOT = '/storage/emulated/0/Download/爱之巢DemoV1.52';
const BRIDGE_PATH = process.env.GC_BRIDGE_UNDER_TEST ||
  '../../android-app/app/src/main/assets/gc-bridge.js';

/**
 * Minimal `XMLHttpRequest` that models the ordering that matters:
 * `open()` aborts an in-flight request **synchronously**, so the `abort` and
 * `loadend` events fire from inside `open()`.
 */
function makeFakeXHR() {
  function FakeXHR() {
    this._listeners = Object.create(null);
    this.status = 0;
    this.responseText = '';
    this.responseType = '';
    this._inflight = false;
  }
  FakeXHR.prototype.addEventListener = function (type, fn) {
    (this._listeners[type] = this._listeners[type] || []).push(fn);
  };
  FakeXHR.prototype._fire = function (type) {
    const list = this._listeners[type] || [];
    for (let i = 0; i < list.length; i++) list[i].call(this, { type: type });
  };
  FakeXHR.prototype._abortInFlight = function () {
    if (!this._inflight) return;
    this._inflight = false;
    this._fire('abort');
    this._fire('loadend');
  };
  FakeXHR.prototype.open = function (method, url) {
    // XHR spec, step 1 of `open()`: terminate the ongoing fetch.
    this._abortInFlight();
    this._method = method;
    this._url = url;
    this._inflight = true;
  };
  FakeXHR.prototype.send = function () {
    if (!this._inflight) throw new Error('InvalidStateError');
  };
  /** Test helper: complete the in-flight request. */
  FakeXHR.prototype.finish = function (status, body) {
    this.status = status;
    this.responseText = body == null ? '' : body;
    this._inflight = false;
    this._fire('load');
    this._fire('loadend');
  };
  return FakeXHR;
}

function loadBridge(host, windowProps) {
  const sandbox = {
    window: {}, console, __GCNative: host, setTimeout, clearTimeout, Date, JSON, Math,
  };
  if (windowProps) Object.assign(sandbox.window, windowProps);
  sandbox.window.window = sandbox.window;
  sandbox.globalThis = sandbox.window;
  vm.createContext(sandbox);
  vm.runInContext(fs.readFileSync(BRIDGE_PATH, 'utf8'), sandbox);
  return sandbox.window;
}

function loadWithXhr() {
  const host = createHost({ gameRoot: GAME_ROOT, docsRoot: '/tmp/d' });
  const lines = [];
  host.log = (s) => { lines.push(String(s)); };
  const FakeXHR = makeFakeXHR();
  const w = loadBridge(host, { __gcDiag: true, XMLHttpRequest: FakeXHR });
  return { w, lines, FakeXHR };
}

/** URLs still listed as pending, in the dump's own order. */
function pendingOf(w) {
  const dump = JSON.parse(w.__gcDiagDump());
  return dump.pending.map((e) => e.url);
}

test('单个 XHR：发送后进挂起表，loadend 后清空', () => {
  const { w, FakeXHR } = loadWithXhr();
  const x = new FakeXHR();
  x.open('GET', '/single.json');
  x.send();
  assert.deepStrictEqual(pendingOf(w), ['/single.json'], '发送之后必须出现在挂起表里');
  x.finish(200, '{}');
  assert.deepStrictEqual(pendingOf(w), [], 'loadend 之后必须清空');
});

test('复用 XHR 对象（open 打断在途请求）后，挂起表必须清空', () => {
  const { w, FakeXHR } = loadWithXhr();
  const x = new FakeXHR();
  x.open('GET', '/first.json');
  x.send();
  // 引擎式复用：同一个 XHR 对象再 open 一次，在途的 first 会被 abort。
  x.open('GET', '/second.json');
  x.send();
  x.finish(200, '{}');
  assert.deepStrictEqual(pendingOf(w), [],
    '被 abort 的 first.json 不得永久滞留在挂起表里');
});

test('复用 XHR 对象时，挂起计数与挂起表必须一致', () => {
  const { w, FakeXHR } = loadWithXhr();
  const x = new FakeXHR();
  x.open('GET', '/first.json');
  x.send();
  x.open('GET', '/second.json');
  x.send();
  x.finish(200, '{}');
  const dump = JSON.parse(w.__gcDiagDump());
  assert.strictEqual(dump.counters.pend, dump.pending.length,
    'pend 计数与挂起表长度必须相等');
  assert.strictEqual(dump.counters.pend, 0, '没有在途请求时 pend 必须是 0');
});

/**
 * The v2 pack reported `bytes` as `responseText.length`, i.e. UTF-16 code
 * units, which under-counts non-ASCII text: `startup.json` measured 971490
 * against 1025562 real bytes on disk. Task 13 makes `bytes` a byte count and
 * records the code-unit length separately as `len`, with `src` naming which
 * of the two shapes produced the number.
 */
function doneLines(lines) {
  return lines.filter((s) => s.indexOf('REQ done ') === 0);
}

test('纯 ASCII 文件：bytes 按字节计，恰等于磁盘字节数', () => {
  const rel = 'asset/json/animation/data/ani1014.json';
  const file = path.join(GAME_ROOT, rel);
  const diskBytes = fs.statSync(file).size;
  const text = fs.readFileSync(file, 'utf8');
  assert.ok(!/[^\x00-\x7f]/.test(text), '夹具必须是纯 ASCII 文件');

  const { lines, FakeXHR } = loadWithXhr();
  const x = new FakeXHR();
  x.open('GET', file);
  x.send();
  x.finish(0, text); // file:// success
  const done = doneLines(lines);
  assert.strictEqual(done.length, 1, done.join('\n'));
  assert.ok(new RegExp(' bytes=' + diskBytes + ' src=text len=' + text.length + ' ').test(done[0]),
    'ASCII 文件 bytes 必须等于磁盘字节数，len 等于码元数：' + done[0]);
});

test('含中文的 JSON：bytes 是 UTF-8 字节、len 是 UTF-16 码元，两者都记且不同', () => {
  const rel = 'asset/json/standAvatar/data/standAvatar3.json';
  const file = path.join(GAME_ROOT, rel);
  const diskBytes = fs.statSync(file).size;
  const text = fs.readFileSync(file, 'utf8');
  assert.strictEqual(Buffer.byteLength(text, 'utf8'), diskBytes, '夹具必须是合法 UTF-8');
  assert.ok(/[\u4e00-\u9fff]/.test(text), '夹具必须含中文');

  const { lines, FakeXHR } = loadWithXhr();
  const x = new FakeXHR();
  x.open('GET', file);
  x.send();
  x.finish(0, text);
  const done = doneLines(lines);
  assert.strictEqual(done.length, 1, done.join('\n'));
  const m = / bytes=(\d+) src=text len=(\d+) /.exec(done[0]);
  assert.ok(m, '完成行必须同时带 src 与 len：' + done[0]);
  assert.strictEqual(Number(m[1]), diskBytes, 'bytes 必须是 UTF-8 字节数，恰好等于磁盘大小');
  assert.strictEqual(Number(m[2]), text.length, 'len 必须是 responseText.length（码元）');
  assert.notStrictEqual(Number(m[1]), Number(m[2]), '中文 JSON 的两种口径必须不同（这正是 v2 的缺陷）');
});

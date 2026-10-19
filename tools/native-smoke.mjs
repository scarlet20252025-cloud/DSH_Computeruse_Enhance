#!/usr/bin/env node
//
// dsh-computer-use 原生后端冒烟测试（协议 dsh-cua/1）。
//
// 用法：
//   node tools/native-smoke.mjs
//
// 只使用 Node 内置模块。启动 powershell.exe（Windows PowerShell 5.1）常驻进程，
// 逐行喂 NDJSON 请求并校验响应。
//
// 安全约定：本测试**不会**向用户桌面注入真实点击/按键。
// 覆盖范围 = 只读方法 + 剪贴板 + 启动一个记事本窗口并 focus/get_app_state。
// 若记事本是本测试新拉起的进程，结束时会被关闭。

import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..');
const scriptPath = path.join(repoRoot, 'src', 'native', 'cua.ps1');

const REQUEST_TIMEOUT_MS = Number(process.env.CUA_SMOKE_TIMEOUT_MS || 90000);

// ---------------------------------------------------------------------------
// 断言与报告
// ---------------------------------------------------------------------------
let passCount = 0;
const failures = [];
let currentSection = '(none)';

function section(title) {
  currentSection = title;
  console.log(`\n=== ${title} ===`);
}

function check(name, condition, actual) {
  if (condition) {
    passCount += 1;
    console.log(`  PASS  ${name}${actual === undefined ? '' : `  -> ${fmt(actual)}`}`);
    return true;
  }
  failures.push({ section: currentSection, name, actual });
  console.log(`  FAIL  ${name}  -> ${fmt(actual)}`);
  return false;
}

function note(message) {
  console.log(`  NOTE  ${message}`);
}

function fmt(value) {
  if (value === undefined) return 'undefined';
  if (typeof value === 'string') return value.length > 240 ? `${JSON.stringify(value.slice(0, 240))}...` : JSON.stringify(value);
  try {
    const s = JSON.stringify(value);
    return s === undefined ? String(value) : s.length > 240 ? `${s.slice(0, 240)}...` : s;
  } catch {
    return String(value);
  }
}

function approx(a, b, eps = 1e-6) {
  return Math.abs(a - b) <= eps;
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function isHexHwnd(v) {
  return typeof v === 'string' && /^0x[0-9a-f]{1,16}$/i.test(v);
}

// ---------------------------------------------------------------------------
// 桥进程
// ---------------------------------------------------------------------------
class Bridge {
  constructor() {
    this.child = null;
    this.buffer = '';
    this.rawChunks = [];
    this.stderrText = '';
    this.lines = [];
    this.pending = [];
    this.nextId = 0;
    this.exited = null;
    this.exitInfo = null;
    this.stdoutLeaks = [];
    this.sawReady = false;
    this.readyLine = null;
  }

  start() {
    if (!existsSync(scriptPath)) {
      throw new Error(`cua.ps1 not found at ${scriptPath}`);
    }
    this.child = spawn(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', scriptPath],
      { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true },
    );
    this.child.stdout.on('data', (chunk) => {
      this.rawChunks.push(chunk);
      this.buffer += chunk.toString('utf8');
      let index = this.buffer.indexOf('\n');
      while (index >= 0) {
        const line = this.buffer.slice(0, index).replace(/\r$/, '');
        this.buffer = this.buffer.slice(index + 1);
        if (line.length > 0) this.onLine(line);
        index = this.buffer.indexOf('\n');
      }
    });
    this.child.stderr.on('data', (chunk) => {
      this.stderrText += chunk.toString('utf8');
    });
    this.exited = new Promise((resolve) => {
      this.child.on('exit', (code, signal) => {
        this.exitInfo = { code, signal };
        resolve(this.exitInfo);
      });
    });
    return this.awaitReady();
  }

  onLine(line) {
    let parsed;
    try {
      parsed = JSON.parse(line);
    } catch {
      this.stdoutLeaks.push(`non-JSON stdout line: ${line}`);
      return;
    }
    this.lines.push(parsed);
    if (parsed.event === 'ready') {
      this.sawReady = true;
      this.readyLine = parsed;
      const waiter = this.pending.shift();
      if (waiter) waiter.resolve(parsed);
      return;
    }
    if (parsed.id !== null && parsed.id !== undefined) {
      const wanted = String(parsed.id);
      const index = this.pending.findIndex((w) => w.id === wanted);
      if (index >= 0) {
        this.pending.splice(index, 1)[0].resolve(parsed);
        return;
      }
    }
    // 非法请求（无法解析 / 无 cmd）可能回一个 id 未知甚至为 null 的响应，
    // 这类请求用 any 等待器接收。
    const anyIndex = this.pending.findIndex((w) => w.any === true);
    if (anyIndex >= 0) {
      this.pending.splice(anyIndex, 1)[0].resolve(parsed);
      return;
    }
    this.stdoutLeaks.push(`unexpected/duplicate response: ${line.slice(0, 240)}`);
  }

  awaitReady() {
    if (this.sawReady) return Promise.resolve(this.readyLine);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('timed out waiting for the ready banner')), 30000);
      this.pending.push({
        id: '__ready__',
        resolve: (value) => {
          clearTimeout(timer);
          resolve(value);
        },
      });
    });
  }

  send(id, cmd, args) {
    const line = JSON.stringify({ id, cmd, args: args || {} });
    this.child.stdin.write(`${line}\n`);
  }

  /** 发送一条请求并等待它自己的响应（严格串行）。 */
  request(cmd, args, options = {}) {
    this.nextId += 1;
    const id = options.id || `t${this.nextId}`;
    const timeout = options.timeout || REQUEST_TIMEOUT_MS;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        const idx = this.pending.findIndex((w) => w.id === id);
        if (idx >= 0) this.pending.splice(idx, 1);
        reject(new Error(`timeout waiting for ${cmd} (id=${id})`));
      }, timeout);
      this.pending.push({
        id,
        resolve: (value) => {
          clearTimeout(timer);
          resolve(value);
        },
      });
      this.send(id, cmd, args);
    });
  }

  /** 一次性发多条，校验串行处理与顺序。 */
  async requestBatch(items) {
    const ids = [];
    const promises = [];
    for (const item of items) {
      this.nextId += 1;
      const id = `b${this.nextId}`;
      ids.push(id);
      promises.push(
        new Promise((resolve, reject) => {
          const timer = setTimeout(() => reject(new Error(`timeout waiting for batch ${item.cmd}`)), REQUEST_TIMEOUT_MS);
          this.pending.push({
            id,
            resolve: (value) => {
              clearTimeout(timer);
              resolve(value);
            },
          });
        }),
      );
      this.send(id, item.cmd, item.args || {});
    }
    const results = await Promise.all(promises);
    return { ids, results };
  }

  sendRaw(text) {
    this.child.stdin.write(text.endsWith('\n') ? text : `${text}\n`);
  }

  /** 发送一行原始请求（可能是非法 JSON / 缺 cmd）并等待它自己的响应。 */
  rawRequest(text) {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('timeout waiting for raw request response')), REQUEST_TIMEOUT_MS);
      this.pending.push({
        id: null,
        any: true,
        resolve: (value) => {
          clearTimeout(timer);
          resolve(value);
        },
      });
      this.child.stdin.write(`${text}\n`);
    });
  }

  rawBuffer() {
    return Buffer.concat(this.rawChunks);
  }

  async closeStdin() {
    try {
      this.child.stdin.end();
    } catch {
      /* ignore */
    }
  }

  kill() {
    try {
      this.child.kill();
    } catch {
      /* ignore */
    }
  }
}

// ---------------------------------------------------------------------------
// 辅助
// ---------------------------------------------------------------------------
function dataOf(res) {
  return res && res.ok === true ? res.data : undefined;
}

function errorCode(res) {
  return res && res.ok === false && res.error ? res.error.code : undefined;
}

function runCommand(command, args) {
  return new Promise((resolve) => {
    const child = spawn(command, args, { stdio: 'ignore', windowsHide: true });
    child.on('exit', (code) => resolve(code));
    child.on('error', () => resolve(-1));
  });
}

async function killPid(pid) {
  return runCommand('taskkill', ['/PID', String(pid), '/F']);
}

// ---------------------------------------------------------------------------
// 主流程
// ---------------------------------------------------------------------------
const bridge = new Bridge();
let exitCode = 1;
let launchedNotepadPid = 0;
let notepadPidWasPreexisting = false;
let clipboardBackup = null;
let clipboardBackupValid = false;
let notepadClosedByInputSection = false;

try {
  section('启动 / ready 横幅');
  const ready = await bridge.start();
  check('stdout 第一行是 ready 横幅', bridge.sawReady === true, bridge.sawReady);
  check('ready.id === null', ready.id === null, ready.id);
  check('ready.ok === true', ready.ok === true, ready.ok);
  check('ready.event === "ready"', ready.event === 'ready', ready.event);
  check('protocol === "dsh-cua/1"', dataOf(ready)?.protocol === 'dsh-cua/1', dataOf(ready)?.protocol);
  check('psVersion 是 Windows PowerShell 5.1', /^5\.1\./.test(String(dataOf(ready)?.psVersion)), dataOf(ready)?.psVersion);
  check('dpiAware === true', dataOf(ready)?.dpiAware === true, dataOf(ready)?.dpiAware);
  const readyMonitors = dataOf(ready)?.screen?.monitors;
  check('ready.screen.monitors 是数组且非空', Array.isArray(readyMonitors) && readyMonitors.length > 0, readyMonitors?.length);
  const readyVirtual = dataOf(ready)?.screen?.virtual;
  check(
    'ready.screen.virtual 有正的宽高',
    readyVirtual && readyVirtual.width > 0 && readyVirtual.height > 0,
    readyVirtual,
  );

  section('ping / 串行处理');
  const ping = await bridge.request('ping', {});
  check('ping ok', ping.ok === true, ping.ok);
  check('ping.data.pong === true', dataOf(ping)?.pong === true, dataOf(ping)?.pong);
  check('ping.data.uptimeMs 是数字', typeof dataOf(ping)?.uptimeMs === 'number', dataOf(ping)?.uptimeMs);
  check('纯读取方法不带 action_sent', !('action_sent' in (dataOf(ping) || {})), Object.keys(dataOf(ping) || {}));

  const batch = await bridge.requestBatch([
    { cmd: 'ping' },
    { cmd: 'ping' },
    { cmd: 'ping' },
  ]);
  const batchOk = batch.results.every((r, i) => r.ok === true && r.id === batch.ids[i]);
  check('一次写入 3 条请求 → 3 条按序响应', batchOk, batch.results.map((r) => r.id));

  section('错误路径（截图之前）');
  const noFrame = await bridge.request('click', { x: 10, y: 10 }, { id: 'noframe-1' });
  check('未截图时 click(raster) → NO_FRAME', errorCode(noFrame) === 'NO_FRAME', errorCode(noFrame));
  check('NO_FRAME 响应原样回显 id', noFrame.id === 'noframe-1', noFrame.id);

  const noCmd = await bridge.rawRequest('{"id":"nocmd-1","args":{}}');
  check('缺少 cmd → BAD_REQUEST', errorCode(noCmd) === 'BAD_REQUEST', errorCode(noCmd));
  check('缺少 cmd 时回显 id', noCmd.id === 'nocmd-1', noCmd.id);

  const badJson = await bridge.rawRequest('{"id":"badjson-1","cmd":');
  check('非法 JSON → BAD_REQUEST', errorCode(badJson) === 'BAD_REQUEST', errorCode(badJson));
  check('非法 JSON 的 id 为 null', badJson.id === null, badJson.id);

  const unknown = await bridge.request('definitely_not_a_method', {});
  check('未知 cmd → UNKNOWN_METHOD', errorCode(unknown) === 'UNKNOWN_METHOD', errorCode(unknown));

  const zoomNoArgs = await bridge.request('zoom', { left: 0, top: 0 });
  check('zoom 缺 width/height → BAD_REQUEST', errorCode(zoomNoArgs) === 'BAD_REQUEST', errorCode(zoomNoArgs));

  const badKey = await bridge.request('key', { key: 'ctrl+nosuchkey' });
  check('未知键名 → BAD_REQUEST', errorCode(badKey) === 'BAD_REQUEST', errorCode(badKey));
  check(
    '未知键名的消息列出可用键名类别',
    typeof badKey.error?.message === 'string' && /enter|f1-f24|numpad/i.test(badKey.error.message),
    badKey.error?.message,
  );

  const badSpace = await bridge.request('mouse_move', { x: 1, y: 1, space: 'diagonal' });
  check('非法 space → BAD_REQUEST', errorCode(badSpace) === 'BAD_REQUEST', errorCode(badSpace));

  section('screen_info');
  const screenInfo = await bridge.request('screen_info', {});
  const si = dataOf(screenInfo) || {};
  check('screen_info ok', screenInfo.ok === true, screenInfo.ok);
  check('dpiAware === true', si.dpiAware === true, si.dpiAware);
  check('monitors 是数组且非空', Array.isArray(si.monitors) && si.monitors.length > 0, si.monitors?.length);
  const mono = si.monitors?.[0];
  check('monitor 有 index/device/primary/dpi/bounds/working', (
    typeof mono?.index === 'number'
    && typeof mono?.device === 'string' && mono.device.length > 0
    && typeof mono?.primary === 'boolean'
    && typeof mono?.dpi === 'number' && mono.dpi > 0
    && typeof mono?.bounds?.width === 'number' && mono.bounds.width > 0
    && typeof mono?.working?.height === 'number' && mono.working.height > 0
  ), mono);
  check('virtual 尺寸 > 0', si.virtual?.width > 0 && si.virtual?.height > 0, si.virtual);
  check('纯读取方法不带 action_sent', !('action_sent' in si), Object.keys(si));

  section('screenshot（全屏 PNG）');
  const shot = await bridge.request('screenshot', {}, { timeout: 120000 });
  const sd = dataOf(shot) || {};
  check('screenshot ok', shot.ok === true, shot.error || shot.ok);
  check('frame_id 存在', typeof sd.frame_id === 'string' && sd.frame_id.length > 0, sd.frame_id);
  check('mediaType === image/png', sd.image?.mediaType === 'image/png', sd.image?.mediaType);
  const pngBytes = sd.image?.base64 ? Buffer.from(sd.image.base64, 'base64') : Buffer.alloc(0);
  check(
    'PNG 魔数 89 50 4E 47',
    pngBytes.length > 8 && pngBytes[0] === 0x89 && pngBytes[1] === 0x50 && pngBytes[2] === 0x4e && pngBytes[3] === 0x47,
    pngBytes.subarray(0, 4).toString('hex'),
  );
  check('image.width/height > 0', sd.image?.width > 0 && sd.image?.height > 0, `${sd.image?.width}x${sd.image?.height}`);
  check('image.bytes 与 base64 解码长度一致', sd.image?.bytes === pngBytes.length, { reported: sd.image?.bytes, decoded: pngBytes.length });
  check(
    '截图尺寸 == 虚拟屏尺寸（DPI 感知一致）',
    sd.image?.width === si.virtual?.width && sd.image?.height === si.virtual?.height,
    { shot: `${sd.image?.width}x${sd.image?.height}`, virtual: `${si.virtual?.width}x${si.virtual?.height}` },
  );
  check('source 覆盖整个虚拟屏', sd.source?.x === si.virtual?.x && sd.source?.y === si.virtual?.y && sd.source?.width === si.virtual?.width && sd.source?.height === si.virtual?.height, sd.source);
  check('scale ≈ 1', approx(sd.scale?.x, 1) && approx(sd.scale?.y, 1), sd.scale);
  check('screenshot_display.raster 与 image 一致', sd.screenshot_display?.raster?.width === sd.image?.width && sd.screenshot_display?.raster?.height === sd.image?.height, sd.screenshot_display?.raster);
  check('screenshot_display.screen 与 source 一致', sd.screenshot_display?.screen?.width === sd.source?.width, sd.screenshot_display?.screen);
  check('纯读取方法不带 action_sent', !('action_sent' in sd), Object.keys(sd));
  const fullFrameId = sd.frame_id;

  section('screenshot（max_width 缩放 + JPEG）');
  const maxWidth = 640;
  const scaled = await bridge.request('screenshot', { max_width: maxWidth }, { timeout: 120000 });
  const sc = dataOf(scaled) || {};
  check('缩放截图 ok', scaled.ok === true, scaled.error || scaled.ok);
  check('缩放后宽度 <= max_width', sc.image?.width <= maxWidth, sc.image?.width);
  check('缩放后高度 <= max_width（长边受限）', sc.image?.height <= maxWidth, sc.image?.height);
  check(
    'scale.x ≈ raster.width / source.width',
    approx(sc.scale?.x, sc.image.width / sc.source.width, 1e-9),
    { scale: sc.scale?.x, expected: sc.image.width / sc.source.width },
  );
  check(
    'scale.y ≈ raster.height / source.height',
    approx(sc.scale?.y, sc.image.height / sc.source.height, 1e-9),
    { scale: sc.scale?.y, expected: sc.image.height / sc.source.height },
  );
  check('缩放后 frame_id 是新的一帧', sc.frame_id !== fullFrameId && typeof sc.frame_id === 'string', { full: fullFrameId, scaled: sc.frame_id });
  const scaledBytes = Buffer.from(sc.image.base64, 'base64');
  check('缩放后体积小于全尺寸', scaledBytes.length < pngBytes.length, { scaled: scaledBytes.length, full: pngBytes.length });

  const jpeg = await bridge.request('screenshot', { max_width: 800, format: 'jpeg', quality: 70 }, { timeout: 120000 });
  const jp = dataOf(jpeg) || {};
  check('JPEG 截图 ok', jpeg.ok === true, jpeg.error || jpeg.ok);
  check('mediaType === image/jpeg', jp.image?.mediaType === 'image/jpeg', jp.image?.mediaType);
  const jpegBytes = jp.image?.base64 ? Buffer.from(jp.image.base64, 'base64') : Buffer.alloc(0);
  check('JPEG 魔数 FF D8', jpegBytes.length > 2 && jpegBytes[0] === 0xff && jpegBytes[1] === 0xd8, jpegBytes.subarray(0, 2).toString('hex'));
  check('JPEG 体积明显小于 PNG', jpegBytes.length < pngBytes.length / 2, { jpeg: jpegBytes.length, png: pngBytes.length });

  section('zoom');
  const zi = si.monitors[0].bounds;
  const zx = zi.x + Math.floor(zi.width / 4);
  const zy = zi.y + Math.floor(zi.height / 4);
  const zw = Math.min(400, Math.floor(zi.width / 2));
  const zh = Math.min(300, Math.floor(zi.height / 2));
  const zoom = await bridge.request('zoom', { left: zx, top: zy, width: zw, height: zh, scale: 2 }, { timeout: 120000 });
  const zd = dataOf(zoom) || {};
  check('zoom ok', zoom.ok === true, zoom.error || zoom.ok);
  check('zoomed === true', zd.zoomed === true, zd.zoomed);
  check('clamped === false', zd.clamped === false, zd.clamped);
  check('source 与请求区域一致', zd.source?.x === zx && zd.source?.y === zy && zd.source?.width === zw && zd.source?.height === zh, zd.source);
  check('raster = source × 2', zd.image?.width === zw * 2 && zd.image?.height === zh * 2, `${zd.image?.width}x${zd.image?.height}`);
  check('scale ≈ 2', approx(zd.scale?.x, 2, 1e-9) && approx(zd.scale?.y, 2, 1e-9), zd.scale);
  check('zoom 返回 frame_id', typeof zd.frame_id === 'string' && zd.frame_id.length > 0, zd.frame_id);

  const clampedZoom = await bridge.request('zoom', { left: zi.x - 100, top: zi.y - 100, width: 400, height: 400, scale: 2 }, { timeout: 120000 });
  check('越界 + 默认 clamp → clamped:true 且裁剪到屏内', clampedZoom.ok === true && dataOf(clampedZoom)?.clamped === true, { clamped: dataOf(clampedZoom)?.clamped, source: dataOf(clampedZoom)?.source });

  const oobZoom = await bridge.request('zoom', { left: zi.x - 5000, top: zi.y - 5000, width: 100, height: 100, clamp: false });
  check('越界 + clamp:false → OUT_OF_BOUNDS', errorCode(oobZoom) === 'OUT_OF_BOUNDS', errorCode(oobZoom));

  const regionShot = await bridge.request('screenshot', { left: zi.x + 50, top: zi.y + 60, width: 320, height: 200 }, { timeout: 120000 });
  const rs = dataOf(regionShot) || {};
  check('screenshot 支持区域截取且 mode === "region"', regionShot.ok === true && rs.screenshot_display?.mode === 'region', rs.screenshot_display?.mode);
  check('区域截图 source == 请求矩形', rs.source?.x === zi.x + 50 && rs.source?.y === zi.y + 60 && rs.source?.width === 320 && rs.source?.height === 200, rs.source);
  check('区域截图 raster 尺寸 == 区域尺寸', rs.image?.width === 320 && rs.image?.height === 200, `${rs.image?.width}x${rs.image?.height}`);

  const badFrame = await bridge.request('click', { x: 5, y: 5, frame_id: 'f_does_not_exist' });
  check('显式传入不一致 frame_id → ELEMENT_STALE', errorCode(badFrame) === 'ELEMENT_STALE', errorCode(badFrame));

  section('list_apps / list_windows');
  const apps = await bridge.request('list_apps', {});
  const ap = dataOf(apps) || {};
  check('list_apps ok', apps.ok === true, apps.error || apps.ok);
  check('count > 0', typeof ap.count === 'number' && ap.count > 0, ap.count);
  check('apps 是数组且长度 == count', Array.isArray(ap.apps) && ap.apps.length === ap.count, { len: ap.apps?.length, count: ap.count });
  const everyAppOk = (ap.apps || []).every(
    (a) => typeof a.appKey === 'string' && a.appKey.length > 0
      && typeof a.displayName === 'string' && a.displayName.length > 0
      && typeof a.process === 'string'
      && typeof a.pid === 'number'
      && typeof a.foreground === 'boolean'
      && typeof a.windowCount === 'number'
      && Array.isArray(a.windows),
  );
  check('每个 app 都有 appKey/displayName/process/pid/foreground/windowCount/windows', everyAppOk, (ap.apps || []).slice(0, 3));
  const everyAppWindowOk = (ap.apps || []).every((a) => a.windows.every((w) => isHexHwnd(w.hwnd) && typeof w.title === 'string' && typeof w.className === 'string' && typeof w.minimized === 'boolean' && typeof w.bounds?.width === 'number'));
  check('每个 app.window 都有 hwnd(0x..)/title/className/minimized/bounds', everyAppWindowOk, (ap.apps || [])[0]?.windows?.[0]);
  check('纯读取方法不带 action_sent', !('action_sent' in ap), Object.keys(ap));

  const windows = await bridge.request('list_windows', {});
  const wd = dataOf(windows) || {};
  check('list_windows ok', windows.ok === true, windows.error || windows.ok);
  check('count > 0', typeof wd.count === 'number' && wd.count > 0, wd.count);
  const everyWinOk = (wd.windows || []).every(
    (w) => isHexHwnd(w.hwnd)
      && typeof w.title === 'string' && w.title.length > 0
      && typeof w.className === 'string'
      && typeof w.pid === 'number'
      && typeof w.appKey === 'string'
      && typeof w.displayName === 'string'
      && typeof w.foreground === 'boolean'
      && typeof w.minimized === 'boolean'
      && typeof w.bounds?.x === 'number',
  );
  check('每个 window 都有完整字段', everyWinOk, (wd.windows || [])[0]);

  const filtered = await bridge.request('list_windows', { appKey: ap.apps[0].appKey });
  check('list_windows 支持 appKey 过滤', filtered.ok === true && dataOf(filtered)?.count >= 1, { appKey: ap.apps[0].appKey, count: dataOf(filtered)?.count });
  const filteredHwnd = await bridge.request('list_windows', { hwnd: wd.windows[0].hwnd });
  check('list_windows 支持 hwnd 过滤', filteredHwnd.ok === true && dataOf(filteredHwnd)?.count === 1 && dataOf(filteredHwnd)?.windows[0].hwnd === wd.windows[0].hwnd, dataOf(filteredHwnd)?.windows?.[0]?.hwnd);
  const filteredPid = await bridge.request('list_windows', { pid: wd.windows[0].pid });
  check('list_windows 支持 pid 过滤', filteredPid.ok === true && dataOf(filteredPid)?.count >= 1, { pid: wd.windows[0].pid, count: dataOf(filteredPid)?.count });

  const cjkTitles = (wd.windows || []).filter((w) => /[\u4e00-\u9fff]/.test(w.title));
  check('存在中文窗口标题（UTF-8 传输验证的前提）', cjkTitles.length > 0, cjkTitles.length);
  if (cjkTitles.length > 0) {
    note(`中文标题样例: ${cjkTitles[0].title}`);
  }

  section('目标解析失败');
  const badApp = await bridge.request('get_app_state', { appKey: 'definitely-not-installed-app' });
  check('未知 appKey → APP_NOT_FOUND', errorCode(badApp) === 'APP_NOT_FOUND', errorCode(badApp));

  const badHwnd = await bridge.request('get_app_state', { hwnd: '0x00000000' });
  check('hwnd=0 → BAD_REQUEST', errorCode(badHwnd) === 'BAD_REQUEST', errorCode(badHwnd));

  section('剪贴板往返');
  const clipRead0 = await bridge.request('clipboard_read', {});
  clipboardBackupValid = clipRead0.ok === true && dataOf(clipRead0)?.hasText === true;
  if (clipboardBackupValid) clipboardBackup = dataOf(clipRead0).text;
  note(clipboardBackupValid ? `已备份原剪贴板文本（${String(clipboardBackup).length} 字符），测试结束会还原` : '原剪贴板没有文本，测试结束会清空');
  check('clipboard_read ok', clipRead0.ok === true, clipRead0.error || clipRead0.ok);
  check('clipboard_read 有 text/hasText/empty 字段', typeof dataOf(clipRead0)?.text === 'string' && typeof dataOf(clipRead0)?.hasText === 'boolean' && typeof dataOf(clipRead0)?.empty === 'boolean', dataOf(clipRead0));
  check('纯读取方法不带 action_sent', !('action_sent' in (dataOf(clipRead0) || {})), Object.keys(dataOf(clipRead0) || {}));

  const probeText = 'dsh-cua 冒烟测试 ✅ 中文 emoji \u{1F680} 42';
  const clipWrite = await bridge.request('clipboard_write', { text: probeText });
  check('clipboard_write ok', clipWrite.ok === true, clipWrite.error || clipWrite.ok);
  check('clipboard_write 带 action_sent:true', dataOf(clipWrite)?.action_sent === true, dataOf(clipWrite)?.action_sent);
  check('characters 与字符数一致', dataOf(clipWrite)?.characters === [...probeText].length, { got: dataOf(clipWrite)?.characters, want: [...probeText].length });

  const clipRead = await bridge.request('clipboard_read', {});
  check('clipboard_read 往返文本一致', dataOf(clipRead)?.text === probeText, dataOf(clipRead)?.text);
  check('hasText === true 且 empty === false', dataOf(clipRead)?.hasText === true && dataOf(clipRead)?.empty === false, { hasText: dataOf(clipRead)?.hasText, empty: dataOf(clipRead)?.empty });

  section('open_application + focus_window + get_app_state');
  const notepadBefore = (wd.windows || []).filter((w) => /notepad/i.test(w.className) || /notepad|记事本/i.test(w.title));
  const notepadPidsBefore = new Set(notepadBefore.map((w) => w.pid));
  note(`启动前记事本窗口 ${notepadBefore.length} 个`);

  const opened = await bridge.request('open_application', { name: 'notepad', wait_ms: 5000 }, { timeout: 60000 });
  const od = dataOf(opened) || {};
  check('open_application ok', opened.ok === true, opened.error || opened.ok);
  check('open_application 带 action_sent:true', od.action_sent === true, od.action_sent);
  check('launched.kind === "name"', od.launched?.kind === 'name', od.launched);
  check('launched.target === "notepad"', od.launched?.target === 'notepad', od.launched?.target);
  check('回填了 pid', typeof od.launched?.pid === 'number' && od.launched.pid > 0, od.launched?.pid);
  check('回填了 hwnd', isHexHwnd(od.launched?.hwnd), od.launched?.hwnd);
  check('text 说明打开了什么', typeof od.text === 'string' && od.text.length > 0, od.text);

  launchedNotepadPid = od.launched?.pid || 0;
  notepadPidWasPreexisting = notepadPidsBefore.has(launchedNotepadPid);

  const badLaunch = await bridge.request('open_application', { name: 'definitely-not-an-application-xyz' });
  check('启动不存在的应用 → LAUNCH_FAILED', errorCode(badLaunch) === 'LAUNCH_FAILED', errorCode(badLaunch));
  check(
    'LAUNCH_FAILED 消息包含被拒绝的目标名',
    typeof badLaunch.error?.message === 'string' && badLaunch.error.message.includes('definitely-not-an-application-xyz'),
    badLaunch.error?.message,
  );

  const badLaunchArgs = await bridge.request('open_application', {});
  check('open_application 无参数 → BAD_REQUEST', errorCode(badLaunchArgs) === 'BAD_REQUEST', errorCode(badLaunchArgs));

  if (isHexHwnd(od.launched?.hwnd)) {
    const focused = await bridge.request('focus_window', { hwnd: od.launched.hwnd }, { timeout: 30000 });
    check('focus_window ok', focused.ok === true, focused.error || focused.ok);
    check('focus_window 带 action_sent:true', dataOf(focused)?.action_sent === true, dataOf(focused)?.action_sent);
    check('focus_window 回显 hwnd', dataOf(focused)?.hwnd === od.launched.hwnd, dataOf(focused)?.hwnd);
    check('focus_window 回显 title', typeof dataOf(focused)?.title === 'string', dataOf(focused)?.title);
  } else {
    check('focus_window ok', false, 'open_application 未回填 hwnd，无法测试 focus_window');
  }

  const state = await bridge.request('get_app_state', { hwnd: od.launched?.hwnd || undefined, appKey: od.launched?.hwnd ? undefined : 'notepad', max_elements: 120, max_depth: 8, timeout_ms: 5000 }, { timeout: 60000 });
  const st = dataOf(state) || {};
  check('get_app_state ok', state.ok === true, state.error || state.ok);
  check('state_id 存在', typeof st.state_id === 'string' && st.state_id.length > 0, st.state_id);
  check('elementCount > 0', typeof st.elementCount === 'number' && st.elementCount > 0, st.elementCount);
  check('elements 非空且长度 == elementCount', Array.isArray(st.elements) && st.elements.length === st.elementCount, { len: st.elements?.length, count: st.elementCount });
  check('text 非空', typeof st.text === 'string' && st.text.length > 0, st.text ? `${st.text.length} chars` : st.text);
  check('text 以 <app 开头并以 </app> 结尾', typeof st.text === 'string' && st.text.startsWith('<app ') && st.text.trimEnd().endsWith('</app>'), typeof st.text === 'string' ? st.text.split('\n')[0] : st.text);
  check('app 有 appKey/displayName/pid', typeof st.app?.appKey === 'string' && typeof st.app?.displayName === 'string' && typeof st.app?.pid === 'number', st.app);
  check('window 有 hwnd/title/className/bounds/foreground/minimized', isHexHwnd(st.window?.hwnd) && typeof st.window?.title === 'string' && typeof st.window?.className === 'string' && typeof st.window?.bounds?.width === 'number' && typeof st.window?.foreground === 'boolean' && typeof st.window?.minimized === 'boolean', st.window);
  check('truncated 是布尔', typeof st.truncated === 'boolean', st.truncated);
  const everyElOk = (st.elements || []).every(
    (e) => typeof e.index === 'number'
      && typeof e.role === 'string'
      && typeof e.name === 'string'
      && typeof e.enabled === 'boolean'
      && typeof e.focused === 'boolean'
      && typeof e.offscreen === 'boolean'
      && Array.isArray(e.actions),
  );
  check('每个 element 都有 index/role/name/enabled/focused/offscreen/actions', everyElOk, (st.elements || [])[0]);
  const actionVocab = new Set(['invoke', 'expand', 'collapse', 'toggle', 'select', 'set_value', 'select_text', 'focus', 'scroll']);
  const actionsValid = (st.elements || []).every((e) => e.actions.every((a) => actionVocab.has(a)));
  check('actions 取值都在协议词表内', actionsValid, [...new Set((st.elements || []).flatMap((e) => e.actions))]);
  check('index 从 0 连续递增', (st.elements || []).every((e, i) => e.index === i), (st.elements || []).slice(0, 3).map((e) => e.index));
  note(`text 首行: ${String(st.text).split('\n')[0]}`);
  note(`text 第二行: ${String(st.text).split('\n')[1] || ''}`);

  section('state_id / element_index 错误路径');
  const staleState = await bridge.request('click', { element_index: 0, state_id: 's0-does-not-exist' });
  check('未知 state_id → ELEMENT_STALE', errorCode(staleState) === 'ELEMENT_STALE', errorCode(staleState));

  const noStateId = await bridge.request('click', { element_index: 0 });
  check('element_index 缺 state_id → BAD_REQUEST', errorCode(noStateId) === 'BAD_REQUEST', errorCode(noStateId));

  const notFound = await bridge.request('click', { element_index: 999999, state_id: st.state_id });
  check('element_index 越界 → ELEMENT_NOT_FOUND', errorCode(notFound) === 'ELEMENT_NOT_FOUND', errorCode(notFound));

  const setValueBad = await bridge.request('set_value', { element_index: 999999, state_id: st.state_id, value: 'x' });
  check('set_value 越界 → ELEMENT_NOT_FOUND', errorCode(setValueBad) === 'ELEMENT_NOT_FOUND', errorCode(setValueBad));

  const perfBad = await bridge.request('perform_action', { element_index: 0, state_id: st.state_id, action: 'teleport' });
  check('perform_action 非法 action → BAD_REQUEST', errorCode(perfBad) === 'BAD_REQUEST', errorCode(perfBad));

  const selectBad = await bridge.request('select_text', { state_id: st.state_id });
  check('select_text 缺 element_index → BAD_REQUEST', errorCode(selectBad) === 'BAD_REQUEST', errorCode(selectBad));

  const stateNoTarget = await bridge.request('get_app_state', {});
  check('get_app_state 无目标 → BAD_REQUEST', errorCode(stateNoTarget) === 'BAD_REQUEST', errorCode(stateNoTarget));

  // 下面三条故意挑「actions 里没有该动作」的元素：请求必须在真正改动任何东西之前就失败。
  const noValueEl = (st.elements || []).find((e) => !e.actions.includes('set_value'));
  if (noValueEl) {
    const r = await bridge.request('set_value', { element_index: noValueEl.index, state_id: st.state_id, value: 'x' });
    check('元素不支持 ValuePattern → NOT_SETTABLE', errorCode(r) === 'NOT_SETTABLE', { index: noValueEl.index, actions: noValueEl.actions, code: errorCode(r) });
  }

  const noTextEl = (st.elements || []).find((e) => !e.actions.includes('select_text'));
  if (noTextEl) {
    const r = await bridge.request('select_text', { element_index: noTextEl.index, state_id: st.state_id, all: true });
    check('元素不支持 TextPattern → NOT_SELECTABLE', errorCode(r) === 'NOT_SELECTABLE', { index: noTextEl.index, actions: noTextEl.actions, code: errorCode(r) });
  }

  const noInvokeEl = (st.elements || []).find((e) => !e.actions.includes('invoke'));
  if (noInvokeEl) {
    const r = await bridge.request('perform_action', { element_index: noInvokeEl.index, state_id: st.state_id, action: 'invoke' });
    check('元素不支持 InvokePattern → ACTION_UNAVAILABLE', errorCode(r) === 'ACTION_UNAVAILABLE', { index: noInvokeEl.index, actions: noInvokeEl.actions, code: errorCode(r) });
  }

  const badFrameForClick = await bridge.request('click', { x: 1, y: 1, frame_id: 'f0-none' });
  check('click 显式 frame_id 不一致 → ELEMENT_STALE', errorCode(badFrameForClick) === 'ELEMENT_STALE', errorCode(badFrameForClick));

  // -------------------------------------------------------------------------
  // 可选：输入注入。默认关闭，因为 click/type/key/drag/scroll/hold_key 会真实操作用户桌面。
  // 打开后只注入到本测试刚新建的记事本窗口。
  // -------------------------------------------------------------------------
  if (process.env.CUA_SMOKE_INPUT !== '1') {
    section('输入注入（默认跳过）');
    note('设置 CUA_SMOKE_INPUT=1 可额外验证 click/type/key/drag/scroll/hold_key；');
    note('打开后只会注入到本测试新建的记事本窗口，并在结束时关闭它。');
  } else {
    section('输入注入（CUA_SMOKE_INPUT=1，只作用于本测试新建的记事本窗口）');
    const inputHwnd = od.launched?.hwnd;
    if (!isHexHwnd(inputHwnd) || notepadBefore.length > 0) {
      check('输入注入前置条件：独占一个新建记事本窗口', false, { hwnd: inputHwnd, preexistingNotepadWindows: notepadBefore.length });
    } else {
      const focusFirst = await bridge.request('focus_window', { hwnd: inputHwnd }, { timeout: 30000 });
      check('输入前置：focus_window ok', focusFirst.ok === true, errorCode(focusFirst));

      const docState = await bridge.request('get_app_state', { hwnd: inputHwnd, max_elements: 200, max_depth: 10, timeout_ms: 8000 }, { timeout: 60000 });
      const ds = dataOf(docState) || {};
      let docEl = (ds.elements || []).find((e) => e.role === 'Document' && e.bounds && e.bounds.width > 100);
      if (!docEl) docEl = (ds.elements || []).find((e) => e.actions.includes('set_value') && e.bounds && e.bounds.width > 100);
      if (!docEl) docEl = (ds.elements || []).find((e) => e.actions.includes('select_text') && e.bounds && e.bounds.width > 100);
      check('在记事本里找到可输入的文档元素', Boolean(docEl), docEl ? { index: docEl.index, role: docEl.role, name: docEl.name, bounds: docEl.bounds } : (ds.elements || []).map((e) => e.role));

      if (docEl) {
        const shot2 = await bridge.request('screenshot', { max_width: 1280 }, { timeout: 120000 });
        const s2 = dataOf(shot2) || {};
        const cx = Math.round(docEl.bounds.x + docEl.bounds.width / 2);
        const cy = Math.round(docEl.bounds.y + docEl.bounds.height / 2);
        const rasterX = Math.round((cx - s2.source.x) * s2.scale.x);
        const rasterY = Math.round((cy - s2.source.y) * s2.scale.y);
        const mapped = await bridge.request('click', { x: rasterX, y: rasterY, frame_id: s2.frame_id });
        check(
          'click 栅格坐标按 frame 映射回物理像素（协议 §3）',
          mapped.ok === true && Math.abs(dataOf(mapped).target.x - cx) <= 1 && Math.abs(dataOf(mapped).target.y - cy) <= 1,
          { want: { x: cx, y: cy }, got: dataOf(mapped)?.target, error: errorCode(mapped), frame: s2.frame_id, scale: s2.scale, raster: { x: rasterX, y: rasterY } },
        );
        const screenSpace = await bridge.request('mouse_move', { x: cx, y: cy, space: 'screen' });
        check(
          'mouse_move space:"screen" 直接使用物理像素',
          screenSpace.ok === true && dataOf(screenSpace).target.x === cx && dataOf(screenSpace).target.y === cy,
          dataOf(screenSpace)?.target,
        );

        const marker = `dsh-cua-input-${Date.now()}`;
        // 先清空文档，这样回读结果可以严格等于 marker（Notepad 可能会恢复上次未保存的内容）。
        const clearAll = await bridge.request('key', { key: 'ctrl+a' });
        check('key ctrl+a 清空前的全选 ok', clearAll.ok === true, errorCode(clearAll));
        const cleared = await bridge.request('key', { key: 'delete' });
        check('key delete 清空文档 ok', cleared.ok === true, errorCode(cleared));
        await new Promise((resolve) => setTimeout(resolve, 120));

        const typed = await bridge.request('type', { text: marker, element_index: docEl.index, state_id: ds.state_id, interval_ms: 10 }, { timeout: 60000 });
        check('type 带 element_index 成功', typed.ok === true && dataOf(typed)?.characters === marker.length, { ok: typed.ok, error: errorCode(typed), characters: dataOf(typed)?.characters });
        const selectAll = await bridge.request('key', { key: 'ctrl+a' });
        check(
          'key ctrl+a 的 modifiers/keys 回显正确',
          selectAll.ok === true && JSON.stringify(dataOf(selectAll)?.modifiers) === '["ctrl"]' && JSON.stringify(dataOf(selectAll)?.keys) === '["a"]',
          dataOf(selectAll),
        );
        const copy = await bridge.request('key', { key: 'ctrl+c' });
        check('key ctrl+c ok', copy.ok === true, errorCode(copy));
        await sleep(300);
        const clip = await bridge.request('clipboard_read', {});
        check(
          'type 注入的文本可被 ctrl+a / ctrl+c 复制回读（端到端证明注入生效）',
          dataOf(clip)?.text === marker,
          { want: marker, got: dataOf(clip)?.text },
        );

        if (docEl.actions.includes('select_text')) {
          const sel = await bridge.request('select_text', { element_index: docEl.index, state_id: ds.state_id, all: true });
          check(
            'select_text all:true ok 且 selected.length == 文档长度',
            sel.ok === true && dataOf(sel)?.selected?.length === marker.length && dataOf(sel)?.selected?.start === 0,
            { ok: sel.ok, error: errorCode(sel), selected: dataOf(sel)?.selected, expectedLength: marker.length },
          );
          const copy2 = await bridge.request('key', { key: 'ctrl+c' });
          check('select_text 之后再 ctrl+c ok', copy2.ok === true, errorCode(copy2));
          await sleep(300);
          const clip2 = await bridge.request('clipboard_read', {});
          check('select_text 选中的内容可被 ctrl+c 复制回读', dataOf(clip2)?.text === marker, { want: marker, got: dataOf(clip2)?.text });
        } else {
          note(`该文档元素不支持 TextPattern（actions=${JSON.stringify(docEl.actions)}），跳过 select_text 成功路径`);
        }

        const actFocus = await bridge.request('perform_action', { element_index: docEl.index, state_id: ds.state_id, action: 'focus' });
        check(
          'perform_action focus ok 且回显 action',
          actFocus.ok === true && dataOf(actFocus)?.action === 'focus' && dataOf(actFocus)?.action_sent === true,
          { ok: actFocus.ok, error: errorCode(actFocus), action: dataOf(actFocus)?.action },
        );

        const valueEl = (ds.elements || []).find((e) => e.actions.includes('set_value') && e.bounds);
        if (valueEl) {
          const valueMarker = `dsh-cua-value-${Date.now()}`;
          const sv = await bridge.request('set_value', { element_index: valueEl.index, state_id: ds.state_id, value: valueMarker });
          check(
            'set_value ok 且回显 value',
            sv.ok === true && dataOf(sv)?.value === valueMarker && dataOf(sv)?.action_sent === true,
            { ok: sv.ok, error: errorCode(sv), index: valueEl.index, role: valueEl.role },
          );
          if (sv.ok === true) {
            await sleep(250);
            await bridge.request('key', { key: 'ctrl+a' });
            await bridge.request('key', { key: 'ctrl+c' });
            await sleep(350);
            const clip3 = await bridge.request('clipboard_read', {});
            check('set_value 写入的内容可被 ctrl+a / ctrl+c 复制回读', dataOf(clip3)?.text === valueMarker, { want: valueMarker, got: dataOf(clip3)?.text });
          }
        } else {
          note('记事本 UIA 树里没有带 ValuePattern 的元素，跳过 set_value 成功路径');
        }

        const scrolled = await bridge.request('scroll', { direction: 'down', amount: 2, element_index: docEl.index, state_id: ds.state_id });
        check('scroll 支持 element_index', scrolled.ok === true && dataOf(scrolled)?.action_sent === true, { ok: scrolled.ok, error: errorCode(scrolled) });
        const dragged = await bridge.request('drag', { from: { x: rasterX, y: rasterY, frame_id: s2.frame_id }, to: { x: rasterX + 40, y: rasterY, frame_id: s2.frame_id }, duration_ms: 200 });
        check('drag 栅格坐标 ok', dragged.ok === true && dataOf(dragged)?.action_sent === true, { ok: dragged.ok, error: errorCode(dragged) });
        const held = await bridge.request('hold_key', { key: 'shift', duration_ms: 200 });
        check('hold_key ok 且回显 durationMs', held.ok === true && dataOf(held)?.durationMs === 200, { ok: held.ok, error: errorCode(held), durationMs: dataOf(held)?.durationMs });
        const keyChar = await bridge.request('key', { text: 'x' });
        check('key 用 text（单字符）形式', keyChar.ok === true && dataOf(keyChar)?.action_sent === true, { ok: keyChar.ok, error: errorCode(keyChar) });
        const stopped = await bridge.request('stop', {});
        check('输入注入后 stop 依然幂等成功', stopped.ok === true && dataOf(stopped)?.stopped === true, dataOf(stopped));

        // 目标窗口消失后的优雅降级：必须在动手之前就失败，且进程不得退出。
        const killRc = await killPid(launchedNotepadPid);
        await sleep(600);
        const afterKill = await bridge.request('click', { element_index: docEl.index, state_id: ds.state_id });
        check(
          '目标窗口被关闭后 click(element_index) 优雅失败（不崩进程）',
          afterKill.ok === false && ['FOREGROUND_REQUIRED', 'ELEMENT_UNAVAILABLE', 'WINDOW_NOT_FOUND', 'ELEMENT_STALE', 'ELEMENT_NOT_FOUND'].includes(errorCode(afterKill)),
          { code: errorCode(afterKill), message: afterKill.error?.message, taskkillRc: killRc },
        );
        const afterKillSetValue = await bridge.request('set_value', { element_index: docEl.index, state_id: ds.state_id, value: 'x' });
        check(
          '目标窗口被关闭后 set_value 优雅失败（不崩进程）',
          afterKillSetValue.ok === false && ['FOREGROUND_REQUIRED', 'ELEMENT_UNAVAILABLE', 'WINDOW_NOT_FOUND', 'ELEMENT_STALE', 'ELEMENT_NOT_FOUND'].includes(errorCode(afterKillSetValue)),
          { code: errorCode(afterKillSetValue) },
        );
        const stillAlive = await bridge.request('ping', {});
        check('目标窗口消失后进程仍然存活并正常应答', stillAlive.ok === true && dataOf(stillAlive)?.pong === true, dataOf(stillAlive));
        notepadClosedByInputSection = true;
      }
    }
  }

  section('wait / stop / shutdown');
  const waited = await bridge.request('wait', { duration_ms: 120 }, { timeout: 30000 });
  check('wait ok', waited.ok === true, waited.error || waited.ok);
  check('waitedMs === 120', dataOf(waited)?.waitedMs === 120, dataOf(waited)?.waitedMs);
  check('wait.text 形如 "Waited 0.12s"', /^Waited \d+\.\d{2}s$/.test(String(dataOf(waited)?.text)), dataOf(waited)?.text);

  const liveWindows = await bridge.request('list_windows', {});
  const liveHwnd = dataOf(liveWindows)?.windows?.[0]?.hwnd;
  const waitedApp = await bridge.request('wait', { duration_ms: 100, hwnd: liveHwnd, max_elements: 20 }, { timeout: 60000 });
  check(
    'wait 带目标时回填 state_id/elements',
    waitedApp.ok === true && typeof dataOf(waitedApp)?.state_id === 'string' && Array.isArray(dataOf(waitedApp)?.elements),
    { hwnd: liveHwnd, state_id: dataOf(waitedApp)?.state_id, n: dataOf(waitedApp)?.elements?.length, error: errorCode(waitedApp) },
  );
  check('wait 带目标时 text 依然是 "Waited x.xxs"（协议 §4.21）', /^Waited \d+\.\d{2}s$/.test(String(dataOf(waitedApp)?.text)), dataOf(waitedApp)?.text);
  check('wait 带目标时额外回填 state_text', typeof dataOf(waitedApp)?.state_text === 'string' && dataOf(waitedApp).state_text.length > 0, typeof dataOf(waitedApp)?.state_text);

  const stop1 = await bridge.request('stop', {});
  check('stop #1 ok', stop1.ok === true, stop1.error || stop1.ok);
  check('stop 带 action_sent:true 与 stopped:true', dataOf(stop1)?.action_sent === true && dataOf(stop1)?.stopped === true, dataOf(stop1));
  check('stop.releasedKeys 是数组', Array.isArray(dataOf(stop1)?.releasedKeys), dataOf(stop1)?.releasedKeys);
  const stop2 = await bridge.request('stop', {});
  check('stop #2 幂等且成功', stop2.ok === true && dataOf(stop2)?.stopped === true, dataOf(stop2));

  section('清理');
  // 只有在本测试之前完全没有记事本窗口时才关闭它（此时那个空文档一定是本测试创建的）。
  // 否则宁可在用户桌面上留一个记事本窗口，也不冒丢失用户未保存内容的风险。
  if (notepadClosedByInputSection) {
    note('记事本已在输入注入段结束时关闭');
  } else if (launchedNotepadPid > 0 && notepadBefore.length === 0 && !notepadPidWasPreexisting) {
    const rc = await killPid(launchedNotepadPid);
    note(`已关闭本测试新建的记事本 pid=${launchedNotepadPid} (taskkill 退出码 ${rc})`);
  } else if (launchedNotepadPid > 0) {
    note(`测试前已存在记事本窗口，为避免丢失用户未保存内容，保留 pid=${launchedNotepadPid} 的记事本窗口不关闭`);
  }

  section('shutdown');
  const shutdown = await bridge.request('shutdown', {});
  check('shutdown ok', shutdown.ok === true, shutdown.error || shutdown.ok);
  check('shutdown.data.stopped === true', dataOf(shutdown)?.stopped === true, dataOf(shutdown));

  const exit = await Promise.race([
    bridge.exited,
    new Promise((resolve) => setTimeout(() => resolve({ code: 'TIMEOUT' }), 15000)),
  ]);
  check('shutdown 后进程以退出码 0 结束', exit.code === 0, exit);

  section('stdout 纯净性与编码');
  check('stdout 中没有非 JSON / 意外行', bridge.stdoutLeaks.length === 0, bridge.stdoutLeaks.slice(0, 5));
  const raw = bridge.rawBuffer();
  const rawText = raw.toString('utf8');
  // 不用「不含 U+FFFD」判断：剪贴板里可能本来就存着别人写坏的内容。
  // 判据是字节级可逆：能无损解码成 UTF-8 字符串（无非法字节序列）。
  check(
    'stdout 是合法 UTF-8（解码后再编码字节完全一致）',
    Buffer.from(rawText, 'utf8').equals(raw),
    { rawBytes: raw.length, decoded: rawText.length },
  );
  check('stdout 以 \\n 结尾，不含 CR（协议 §2）', raw.toString('latin1').indexOf('\r') === -1, raw.toString('latin1').includes('\r') ? 'found CR' : 'LF only');
  if (cjkTitles.length > 0) {
    // 只取「连续的」CJK 片段做字节级比对：标题里的引号/反斜杠会被 JSON 转义，
    // 而把多段 CJK 拼接起来也不会在原始字节里连续出现。
    const runs = cjkTitles.flatMap((w) => w.title.match(/[\u4e00-\u9fff]{2,}/g) || []);
    check('中文标题里存在可做字节比对的连续 CJK 片段', runs.length > 0, runs.slice(0, 5));
    const hit = runs.find((run) => raw.includes(Buffer.from(run, 'utf8')));
    check(
      'stdout 原始字节里存在中文标题的 UTF-8 序列（非转义、非乱码）',
      Boolean(hit),
      { tried: runs.slice(0, 6), hit, utf8hex: hit ? Buffer.from(hit, 'utf8').toString('hex') : null },
    );
  }
  const clipNeedle = Buffer.from('冒烟测试', 'utf8');
  check('stdout 原始字节里存在剪贴板中文的 UTF-8 序列', raw.includes(clipNeedle), clipNeedle.toString('hex'));
  check('stdout 至少收到了所有响应', bridge.lines.length >= 40, bridge.lines.length);

  if (bridge.stderrText.trim().length > 0) {
    note(`stderr 输出（诊断用，非失败）：\n${bridge.stderrText.trim().split('\n').slice(0, 10).join('\n')}`);
  } else {
    note('stderr 为空');
  }

  // 还原剪贴板（尽力而为）
  if (clipboardBackupValid) {
    const restore = new Bridge();
    try {
      await restore.start();
      await restore.request('clipboard_write', { text: clipboardBackup });
      await restore.request('shutdown', {});
      await restore.exited;
      note('剪贴板文本已还原');
    } catch (error) {
      note(`剪贴板还原失败：${error.message}`);
      restore.kill();
    }
  }

  exitCode = failures.length === 0 ? 0 : 1;
} catch (error) {
  failures.push({ section: currentSection, name: 'unhandled smoke-test error', actual: error.stack || error.message });
  console.error('\nUNHANDLED ERROR:', error.stack || error.message);
  exitCode = 1;
} finally {
  if (bridge.exitInfo === null) {
    bridge.kill();
  }
  try {
    await Promise.race([bridge.exited, new Promise((r) => setTimeout(r, 2000))]);
  } catch {
    /* ignore */
  }
}

console.log(`\n${'='.repeat(72)}`);
console.log(`PASS ${passCount}   FAIL ${failures.length}`);
if (failures.length > 0) {
  console.log('\n失败清单：');
  for (const f of failures) {
    console.log(`  - [${f.section}] ${f.name}  -> ${fmt(f.actual)}`);
  }
}
console.log('='.repeat(72));

process.exit(exitCode);

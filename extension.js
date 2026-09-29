// Preview HTML files in a VS Code webview, served by the Live Server extension
// (ritwickdey.LiveServer). Live Server has no API, so we drive it through its
// commands and discover the port it bound by probing for its injected script.
const vscode = require('vscode');
const path = require('path');
const fs = require('fs');
const http = require('http');
const https = require('https');
const net = require('net');
const tls = require('tls');
const { execFile } = require('child_process');

const LS_MARKER = 'Code injected by live-server';
const VIEW_TYPE = 'liveServerPreview.editor';
const panels = new Map(); // fsPath -> WebviewPanel
let starting = null; // shared promise while Live Server is starting

// The preview is a custom editor, so it is the default opener for .html files
// (single click in the explorer). "Open Source" reopens the file as text.
function activate(context) {
  const report = (e) => vscode.window.showErrorMessage(`Live Server Preview: ${e.message || e}`);
  context.subscriptions.push(
    vscode.window.registerCustomEditorProvider(VIEW_TYPE, {
      openCustomDocument: (uri) => ({ uri, dispose() {} }),
      resolveCustomEditor: (document, panel) => resolvePreview(document.uri, panel),
    }, { webviewOptions: { retainContextWhenHidden: true }, supportsMultipleEditorsPerDocument: true }),
    vscode.commands.registerCommand('liveServerPreview.open', (uri) => openPreview(uri).catch(report)),
    vscode.commands.registerCommand('liveServerPreview.openSource', (uri) => openSource(uri).catch(report))
  );
}

function tabUri() {
  const input = vscode.window.tabGroups.activeTabGroup.activeTab?.input;
  return input?.uri instanceof vscode.Uri ? input.uri : undefined;
}

// Right-click command: open the preview as a tab next to an existing preview,
// or beside the current editor if there is none.
async function openPreview(uri) {
  if (!(uri instanceof vscode.Uri)) uri = vscode.window.activeTextEditor?.document.uri || tabUri();
  if (!uri || !/\.html?$/i.test(uri.fsPath)) throw new Error('Select an .html file to preview.');
  const open = panels.get(uri.fsPath);
  if (open) return open.reveal(undefined, true);
  const existing = [...panels.values()].find((p) => p.viewColumn !== undefined);
  await vscode.commands.executeCommand('vscode.openWith', uri, VIEW_TYPE,
    { viewColumn: existing ? existing.viewColumn : vscode.ViewColumn.Beside, preserveFocus: true });
}

async function openSource(uri) {
  if (!(uri instanceof vscode.Uri)) uri = tabUri();
  if (!uri) return;
  const panel = panels.get(uri.fsPath);
  await vscode.commands.executeCommand('vscode.openWith', uri, 'default', panel?.viewColumn);
}

async function resolvePreview(uri, panel) {
  const key = uri.fsPath;
  panels.set(key, panel);
  panel.onDidDispose(() => { if (panels.get(key) === panel) panels.delete(key); });
  panel.onDidChangeViewState(() => { if (panel.active) panels.set(key, panel); });
  keepTab(uri);
  panel.webview.options = { enableScripts: true };
  panel.webview.onDidReceiveMessage((m) => {
    if (m === 'source') openSource(uri);
    if (m?.type === 'copy' && m.text) vscode.env.clipboard.writeText(m.text);
    // Bump the file's mtime so Live Server sends its own reload; the page then
    // calls location.reload() itself, which keeps the scroll position.
    if (m === 'reload') {
      try { const now = new Date(); fs.utimesSync(uri.fsPath, now, now); } catch { /* webview falls back */ }
    }
  });
  panel.webview.html = page(`<div class="msg">Starting Live Server...</div>`);
  try {
    const url = await previewUrl(uri);
    panel.webview.html = page(`<iframe id="f" src="${esc(url)}" allow="clipboard-read; clipboard-write"></iframe>`, url);
  } catch (e) {
    panel.webview.html = page(`<div class="msg">Could not preview: ${esc(e.message || String(e))}</div>`);
  }
}

function lsConfig(uri) {
  return vscode.workspace.getConfiguration('liveServer.settings', uri);
}

// A single click in the explorer opens a temporary "preview mode" tab that the
// next click replaces. Pin HTML previews so each file gets its own tab.
async function keepTab(uri) {
  for (let i = 0; i < 20; i++) {
    const tab = vscode.window.tabGroups.activeTabGroup.activeTab;
    if (tab?.input instanceof vscode.TabInputCustom && tab.input.viewType === VIEW_TYPE && tab.input.uri.fsPath === uri.fsPath) {
      if (tab.isPreview) await vscode.commands.executeCommand('workbench.action.keepEditor');
      return;
    }
    await sleep(50);
  }
}

// Starts Live Server if needed and returns the URL the webview can load.
async function previewUrl(uri) {
  const doc = vscode.workspace.textDocuments.find((d) => d.uri.toString() === uri.toString());
  if (doc?.isDirty) await doc.save();

  const urlPath = servedPath(uri);
  const cfg = lsConfig(uri);
  const scheme = cfg.get('https')?.enable ? 'https' : 'http';
  let host = cfg.get('host') || '127.0.0.1';
  if (host === '0.0.0.0' || host === 'localhost') host = '127.0.0.1';

  const port = await vscode.window.withProgress(
    { location: vscode.ProgressLocation.Window, title: 'Live Server Preview: connecting' },
    () => ensureServer(uri, scheme, host, urlPath)
  );

  const proxyPort = await ensureProxy(scheme, host, port);
  const local = vscode.Uri.parse(`http://127.0.0.1:${proxyPort}${urlPath}`);
  // Forwards the port when VS Code is connected to a remote (SSH, WSL, containers).
  const external = await vscode.env.asExternalUri(local);
  return external.toString(true);
}

// URL path for the file, relative to the Live Server root of its workspace folder.
function servedPath(uri) {
  const folder = vscode.workspace.getWorkspaceFolder(uri);
  if (!folder) throw new Error('Live Server only serves files inside an open workspace folder.');
  const rootSetting = lsConfig(uri).get('root') || '/';
  const root = path.join(folder.uri.fsPath, rootSetting);
  const rel = path.relative(root, uri.fsPath);
  if (rel.startsWith('..') || path.isAbsolute(rel)) {
    throw new Error(`File is outside the Live Server root (${rootSetting}).`);
  }
  return '/' + rel.split(path.sep).map(encodeURIComponent).join('/');
}

async function ensureServer(uri, scheme, host, urlPath) {
  const found = await findServerPort(uri, scheme, host, urlPath);
  if (found) return found;
  if (!starting) starting = startServer(uri, scheme, host, urlPath).finally(() => { starting = null; });
  return starting;
}

async function startServer(uri, scheme, host, urlPath) {
  // Stop Live Server from opening a browser: set NoBrowser for this start only.
  const cfg = vscode.workspace.getConfiguration('liveServer.settings');
  const info = cfg.inspect('NoBrowser') || {};
  const needsToggle = !cfg.get('NoBrowser');
  // Write to the most specific scope that sets it, so a workspace `false` can't win.
  const [target, prev] = info.workspaceValue !== undefined
    ? [vscode.ConfigurationTarget.Workspace, info.workspaceValue]
    : [vscode.ConfigurationTarget.Global, info.globalValue];
  if (needsToggle) await cfg.update('NoBrowser', true, target);
  try {
    await vscode.commands.executeCommand('extension.liveServer.goOnline', uri);
    const timeoutMs = vscode.workspace.getConfiguration('liveServerPreview').get('startTimeoutSeconds', 15) * 1000;
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      await sleep(400);
      const port = await findServerPort(uri, scheme, host, urlPath);
      if (port) {
        // Live Server decides whether to open the browser right after it starts listening.
        await sleep(1500);
        return port;
      }
    }
    throw new Error('Timed out waiting for Live Server to start. Check the Live Server output / status bar.');
  } finally {
    if (needsToggle) await cfg.update('NoBrowser', prev, target);
  }
}

// Candidate ports: the configured port and the next few (Live Server moves on
// when the port is taken), plus every port this extension host process listens
// on (Live Server runs in the same process and may fall back to a random port).
async function findServerPort(uri, scheme, host, urlPath) {
  const base = Number(lsConfig(uri).get('port')) || 5500;
  const candidates = new Set();
  for (let p = base; p < base + 10; p++) candidates.add(p);
  for (const p of await listeningPorts()) candidates.add(p);
  const results = await Promise.all([...candidates].map(async (p) => ((await isLiveServer(scheme, host, p, urlPath)) ? p : null)));
  return results.find((p) => p !== null) || null;
}

function isLiveServer(scheme, host, port, urlPath) {
  return new Promise((resolve) => {
    const lib = scheme === 'https' ? https : http;
    const req = lib.get({ host, port, path: urlPath, timeout: 800, rejectUnauthorized: false }, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (c) => { body += c; if (body.length > 5e6) res.destroy(); });
      res.on('end', () => resolve(res.statusCode === 200 && body.includes(LS_MARKER)));
      res.on('error', () => resolve(false));
    });
    req.on('timeout', () => req.destroy());
    req.on('error', () => resolve(false));
  });
}

async function listeningPorts() {
  try {
    if (process.platform === 'linux') return linuxListeningPorts();
    if (process.platform === 'darwin') {
      const out = await run('lsof', ['-a', '-p', String(process.pid), '-iTCP', '-sTCP:LISTEN', '-P', '-n']);
      return [...out.matchAll(/:(\d+) \(LISTEN\)/g)].map((m) => Number(m[1]));
    }
    if (process.platform === 'win32') {
      const out = await run('netstat', ['-ano', '-p', 'TCP']);
      return out.split(/\r?\n/)
        .map((l) => l.trim().split(/\s+/))
        .filter((c) => c[3] === 'LISTENING' && c[4] === String(process.pid))
        .map((c) => Number(c[1].split(':').pop()));
    }
  } catch { /* fall back to configured ports only */ }
  return [];
}

function linuxListeningPorts() {
  const inodes = new Set();
  for (const fd of fs.readdirSync('/proc/self/fd')) {
    try {
      const m = /^socket:\[(\d+)\]$/.exec(fs.readlinkSync(`/proc/self/fd/${fd}`));
      if (m) inodes.add(m[1]);
    } catch { /* fd closed meanwhile */ }
  }
  const ports = [];
  for (const f of ['/proc/net/tcp', '/proc/net/tcp6']) {
    let text = '';
    try { text = fs.readFileSync(f, 'utf8'); } catch { continue; }
    for (const line of text.split('\n').slice(1)) {
      const c = line.trim().split(/\s+/);
      if (c.length > 9 && c[3] === '0A' && inodes.has(c[9])) ports.push(parseInt(c[1].split(':')[1], 16));
    }
  }
  return ports;
}

function run(cmd, args) {
  return new Promise((resolve, reject) => execFile(cmd, args, { timeout: 3000 }, (e, out) => (e ? reject(e) : resolve(out))));
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

const esc = (s) => s.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');

function page(content, url) {
  const origin = url ? new URL(url).origin : "'none'";
  const nonce = Math.random().toString(36).slice(2);
  return `<!DOCTYPE html>
<html><head><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; frame-src ${origin}; style-src 'unsafe-inline'; script-src 'nonce-${nonce}';">
<style>
  html, body { margin: 0; padding: 0; height: 100%; overflow: hidden; background: var(--vscode-editor-background); }
  body { display: flex; flex-direction: column; }
  .bar { display: flex; gap: 6px; align-items: center; padding: 3px 6px; font: 12px var(--vscode-font-family);
         color: var(--vscode-foreground); border-bottom: 1px solid var(--vscode-panel-border); }
  .bar span { flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; opacity: .8; }
  .msg { padding: 12px; font: 13px var(--vscode-font-family); color: var(--vscode-foreground); }
  button { background: var(--vscode-button-secondaryBackground); color: var(--vscode-button-secondaryForeground);
           border: none; padding: 2px 8px; cursor: pointer; }
  .view { flex: 1; position: relative; display: flex; }
  iframe { flex: 1; border: none; width: 100%; background: white; }
  #flash { position: absolute; inset: 0; pointer-events: none; opacity: 0; background: var(--vscode-focusBorder, #0078d4); }
  #flash.on { animation: flash .5s ease-out; }
  @keyframes flash { from { opacity: .3; } to { opacity: 0; } }
</style></head>
<body>
  <div class="bar">
    ${url ? '<button id="reload" title="Reload">&#x21bb; Reload</button>' : ''}
    <button id="source" title="Reopen this file as text">Open Source</button>
    <span>${url ? esc(url) : ''}</span>
  </div>
  <div class="view">${content}<div id="flash"></div></div>
  <script nonce="${nonce}">
    const vscode = acquireVsCodeApi();
    document.getElementById('source').onclick = () => vscode.postMessage('source');
    const f = document.getElementById('f'), r = document.getElementById('reload');
    // Ask Live Server to reload the page in place (keeps scroll). If the frame
    // doesn't reload within 2.5 s, reload it from scratch (scrolls to top).
    // Flash the page on every reload after the first load (Reload button or save).
    // Copy: the frame sends its selection; VS Code's copy command fires 'copy' here.
    window.addEventListener('message', (e) => {
      if (f && e.source === f.contentWindow && e.data && e.data.__lsp === 'copy') vscode.postMessage({ type: 'copy', text: e.data.text });
    });
    document.addEventListener('copy', () => {
      if (f && !String(getSelection())) f.contentWindow.postMessage({ __lsp: 'getSelection' }, '*');
    });
    const flash = document.getElementById('flash');
    let firstLoad = true;
    if (f) f.addEventListener('load', () => {
      if (firstLoad || f.getAttribute('src') === 'about:blank') { firstLoad = false; return; }
      flash.classList.remove('on'); void flash.offsetWidth; flash.classList.add('on');
    });
    if (r) r.onclick = () => {
      let loaded = false;
      f.addEventListener('load', () => { loaded = true; }, { once: true });
      vscode.postMessage('reload');
      setTimeout(() => { if (!loaded) { const u = f.src; f.src = 'about:blank'; setTimeout(() => { f.src = u; }, 50); } }, 2500);
    };
  </script>
</body></html>`;
}

// The page runs in a cross-origin iframe, so VS Code's copy command can't see
// its selection. A small proxy in front of Live Server adds a script to HTML
// pages that sends the selection to the webview, which puts it on the
// clipboard. WebSocket upgrades (live reload) are piped through unchanged.
const BRIDGE = `<script>(function () {
  if (window.parent === window) return;
  var send = function () { var t = String(getSelection()); if (t) parent.postMessage({ __lsp: 'copy', text: t }, '*'); };
  document.addEventListener('keydown', function (e) {
    if ((e.metaKey || e.ctrlKey) && !e.altKey && !e.shiftKey && e.key.toLowerCase() === 'c') send();
  }, true);
  document.addEventListener('copy', send, true);
  window.addEventListener('message', function (e) { if (e.data && e.data.__lsp === 'getSelection') send(); });
})();</script>`;

const proxies = new Map(); // upstream origin -> Promise<proxy port>
const proxyServers = [];

function injectBridge(html) {
  const i = html.toLowerCase().lastIndexOf('</body>');
  return i < 0 ? html + BRIDGE : html.slice(0, i) + BRIDGE + html.slice(i);
}

function ensureProxy(scheme, host, port) {
  const key = `${scheme}://${host}:${port}`;
  if (!proxies.has(key)) proxies.set(key, new Promise((resolve, reject) => {
    const lib = scheme === 'https' ? https : http;
    const target = `${host}:${port}`;
    const server = http.createServer((req, res) => {
      const up = lib.request({
        host, port, method: req.method, path: req.url, rejectUnauthorized: false,
        headers: { ...req.headers, host: target, 'accept-encoding': 'identity' },
      }, (ur) => {
        if (!/text\/html/i.test(ur.headers['content-type'] || '')) {
          res.writeHead(ur.statusCode, ur.headers);
          ur.pipe(res);
          return;
        }
        const chunks = [];
        ur.on('data', (c) => chunks.push(c));
        ur.on('end', () => {
          const body = Buffer.from(injectBridge(Buffer.concat(chunks).toString('utf8')));
          const headers = { ...ur.headers, 'content-length': body.length };
          delete headers['content-encoding'];
          delete headers['transfer-encoding'];
          res.writeHead(ur.statusCode, headers);
          res.end(body);
        });
      });
      up.on('error', (e) => { res.writeHead(502); res.end(`Live Server Preview proxy: ${e.message}`); });
      req.pipe(up);
    });
    server.on('upgrade', (req, socket, head) => {
      const up = scheme === 'https'
        ? tls.connect({ host, port, rejectUnauthorized: false })
        : net.connect(port, host);
      let raw = `${req.method} ${req.url} HTTP/${req.httpVersion}\r\n`;
      for (let i = 0; i < req.rawHeaders.length; i += 2) {
        const name = req.rawHeaders[i];
        raw += `${name}: ${name.toLowerCase() === 'host' ? target : req.rawHeaders[i + 1]}\r\n`;
      }
      up.write(raw + '\r\n');
      if (head?.length) up.write(head);
      up.pipe(socket);
      socket.pipe(up);
      up.on('error', () => socket.destroy());
      socket.on('error', () => up.destroy());
    });
    server.on('error', (e) => { proxies.delete(key); reject(e); });
    server.listen(0, '127.0.0.1', () => resolve(server.address().port));
    proxyServers.push(server);
  }));
  return proxies.get(key);
}


function deactivate() {
  for (const s of proxyServers) s.close();
}

module.exports = { activate, deactivate };

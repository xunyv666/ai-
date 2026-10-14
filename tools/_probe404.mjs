// 一次性探针：只渲染 public/404.html，检查资源与错别页样式是否正常
const PORT = process.env.CDP_PORT || 9333;
const URL_ = process.env.PAGE_URL || "http://127.0.0.1:8765/404.html";
const OUT = process.env.OUT_DIR || "public/assets/_shots";

import { mkdirSync, writeFileSync } from "node:fs";
mkdirSync(OUT, { recursive: true });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let wsUrl = null;
for (let i = 0; i < 60 && !wsUrl; i++) {
  try {
    const r = await fetch(`http://127.0.0.1:${PORT}/json/list`);
    const list = await r.json();
    const page = list.find((t) => t.type === "page");
    if (page?.webSocketDebuggerUrl) wsUrl = page.webSocketDebuggerUrl;
  } catch {}
  if (!wsUrl) await sleep(500);
}
if (!wsUrl) throw new Error("CDP not reachable");

const ws = new WebSocket(wsUrl);
await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });

let id = 0;
const pending = new Map();
const responses = [];
const reqUrl = new Map();
const failed = [];
const logErrors = [];
const exceptions = [];
ws.onmessage = (m) => {
  const msg = JSON.parse(m.data);
  if (msg.id && pending.has(msg.id)) {
    const { res, rej } = pending.get(msg.id);
    pending.delete(msg.id);
    msg.error ? rej(new Error(JSON.stringify(msg.error))) : res(msg.result);
  } else if (msg.method === "Network.requestWillBeSent") {
    reqUrl.set(msg.params.requestId, msg.params.request.url);
  } else if (msg.method === "Network.loadingFailed") {
    failed.push({ url: reqUrl.get(msg.params.requestId) || "?", err: msg.params.errorText });
  } else if (msg.method === "Network.responseReceived") {
    const { url, status } = msg.params.response;
    responses.push({ url, status });
  } else if (msg.method === "Log.entryAdded" && msg.params.entry.level === "error") {
    logErrors.push(msg.params.entry.text);
  } else if (msg.method === "Runtime.exceptionThrown") {
    exceptions.push(msg.params.exceptionDetails.text);
  }
};
function send(method, params = {}) {
  const mid = ++id;
  ws.send(JSON.stringify({ id: mid, method, params }));
  return new Promise((res, rej) => pending.set(mid, { res, rej }));
}

await send("Page.enable");
await send("Runtime.enable");
await send("Log.enable");
await send("Network.enable");
await send("Emulation.setDeviceMetricsOverride", { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });

await send("Page.navigate", { url: URL_ });
await sleep(4000);

const evalJs = async (expr) => {
  const r = await send("Runtime.evaluate", { expression: expr, returnByValue: true, awaitPromise: true });
  if (r.exceptionDetails) return { __err: r.exceptionDetails.text };
  return r.result.value;
};

const info = await evalJs(`(()=>{
  const de=document.documentElement;
  const bd=document.querySelector('.backdrop');
  const pill=document.querySelector('.pill');
  return {
    title: document.title,
    code: document.querySelector('.code').textContent,
    h1: document.querySelector('h1').textContent,
    pillText: pill.textContent.trim(),
    pillHref: pill.getAttribute('href'),
    mailHref: document.querySelector('.quiet').getAttribute('href'),
    bgImage: getComputedStyle(bd).backgroundImage.slice(0,120),
    fontsLoaded: document.fonts ? document.fonts.status : 'n/a',
    overflowX: de.scrollWidth > de.clientWidth,
    docH: de.scrollHeight, viewH: window.innerHeight,
    foot: document.querySelector('.foot').textContent.trim(),
  };
})()`);
console.log("P404 " + JSON.stringify(info, null, 2));

const poster = responses.filter((r) => r.url.includes("dusk-poster"));
console.log("POSTER " + JSON.stringify(poster));
const bad = responses.filter((r) => r.status >= 400);
console.log("BAD_RESPONSES " + JSON.stringify(bad));
console.log("FAILED_REQUESTS " + JSON.stringify(failed));
console.log("CONSOLE_ERRORS " + JSON.stringify(logErrors));
console.log("EXCEPTIONS " + JSON.stringify(exceptions));

const shot = await send("Page.captureScreenshot", { format: "jpeg", quality: 84 });
writeFileSync(`${OUT}/404.jpg`, Buffer.from(shot.data, "base64"));

// 窄屏也看一眼
await send("Emulation.setDeviceMetricsOverride", { width: 390, height: 844, deviceScaleFactor: 2, mobile: true });
await sleep(900);
const narrow = await evalJs(`(()=>{const de=document.documentElement;return{overflowX:de.scrollWidth>de.clientWidth,scrollW:de.scrollWidth,clientW:de.clientWidth};})()`);
console.log("MOBILE404 " + JSON.stringify(narrow));
const shot2 = await send("Page.captureScreenshot", { format: "jpeg", quality: 84 });
writeFileSync(`${OUT}/404_mobile.jpg`, Buffer.from(shot2.data, "base64"));

ws.close();
process.exit(0);

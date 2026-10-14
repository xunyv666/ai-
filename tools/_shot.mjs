// 无依赖 CDP 驱动：用 Edge 无头模式真实渲染 index.html 并截图
// Node 22 内置 fetch + WebSocket，不需要安装任何 npm 包
const PORT = process.env.CDP_PORT || 9333;
const URL_ = process.env.PAGE_URL || "http://127.0.0.1:8765/index.html";
const OUT = process.env.OUT_DIR || "public/assets/_shots";

import { mkdirSync, writeFileSync } from "node:fs";
mkdirSync(OUT, { recursive: true });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function getWs() {
  for (let i = 0; i < 60; i++) {
    try {
      const r = await fetch(`http://127.0.0.1:${PORT}/json/list`);
      const list = await r.json();
      const page = list.find((t) => t.type === "page");
      if (page?.webSocketDebuggerUrl) return page.webSocketDebuggerUrl;
    } catch {}
    await sleep(500);
  }
  throw new Error("CDP not reachable");
}

const wsUrl = await getWs();
const ws = new WebSocket(wsUrl);
await new Promise((res, rej) => {
  ws.onopen = res;
  ws.onerror = rej;
});

let id = 0;
const pending = new Map();
const events = [];
ws.onmessage = (m) => {
  const msg = JSON.parse(m.data);
  if (msg.id && pending.has(msg.id)) {
    const { res, rej } = pending.get(msg.id);
    pending.delete(msg.id);
    msg.error ? rej(new Error(JSON.stringify(msg.error))) : res(msg.result);
  } else if (msg.method) {
    events.push(msg);
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
await send("Emulation.setDeviceMetricsOverride", {
  width: 1440, height: 900, deviceScaleFactor: 1, mobile: false,
});

await send("Page.navigate", { url: URL_ });
await sleep(4500);

const evalJs = async (expr) => {
  const r = await send("Runtime.evaluate", {
    expression: expr, returnByValue: true, awaitPromise: true,
  });
  if (r.exceptionDetails) return { __err: r.exceptionDetails.text };
  return r.result.value;
};

// --- 基本健康检查 ---
const health = await evalJs(`(()=>{
  const v=document.getElementById('clip');
  const de=document.documentElement;
  return {
    title: document.title,
    panelCount: document.querySelectorAll('[data-panel]').length,
    stagCount: document.querySelectorAll('[data-stag]').length,
    videoSrc: v.currentSrc || v.src,
    videoDuration: v.duration,
    videoW: v.videoWidth, videoH: v.videoHeight,
    videoReadyState: v.readyState,
    bootDone: document.getElementById('boot').classList.contains('done'),
    stageReady: document.getElementById('stage').classList.contains('is-ready'),
    scrollHeight: de.scrollHeight,
    innerHeight: window.innerHeight,
    maxScroll: de.scrollHeight - window.innerHeight,
    docScrollW: de.scrollWidth, docClientW: de.clientWidth,
    overflowX: de.scrollWidth > de.clientWidth,
    fontsLoaded: document.fonts ? document.fonts.status : 'n/a',
  };
})()`);
console.log("HEALTH " + JSON.stringify(health, null, 2));

// --- 在多个滚动位置截图，并采样文字透明度 ---
const stops = [0.06, 0.16, 0.30, 0.41, 0.49, 0.63, 0.74, 0.82, 0.93, 1.0];
for (const p of stops) {
  const info = await evalJs(`(async()=>{
    const de=document.documentElement;
    const max=Math.max(1,de.scrollHeight-window.innerHeight);
    window.scrollTo(0, ${p}*max);
    await new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)));
    await new Promise(r=>setTimeout(r,900));
    const panels=[...document.querySelectorAll('[data-panel]')].map((el,i)=>({
      i,
      op: +(+el.querySelector('[data-stag]').style.opacity||0).toFixed(3),
      ctaOp: +(+el.querySelector('.cta').style.opacity||0).toFixed(3),
      pe: el.style.pointerEvents,
      inert: !!el.inert,
      aria: el.getAttribute('aria-hidden'),
    }));
    return {
      progress:+ (window.pageYOffset/max).toFixed(3),
      idx: document.getElementById('idxNum').textContent,
      time: document.getElementById('idxTime').textContent,
      railOn: [...document.querySelectorAll('[data-rail]')].findIndex(l=>l.classList.contains('on')),
      dusk: getComputedStyle(de).getPropertyValue('--dusk').trim(),
      panels,
      visible: panels.filter(p=>p.op>0.05).length,
    };
  })()`);
  const shot = await send("Page.captureScreenshot", { format: "jpeg", quality: 82 });
  const name = `p${String(Math.round(p * 100)).padStart(3, "0")}.jpg`;
  writeFileSync(`${OUT}/${name}`, Buffer.from(shot.data, "base64"));
  console.log(`STOP p=${p} -> ${name}  ` + JSON.stringify(info));
}

// --- 移动端视图 ---
await send("Emulation.setDeviceMetricsOverride", {
  width: 390, height: 844, deviceScaleFactor: 2, mobile: true,
});
await evalJs(`window.scrollTo(0,0)`);
await sleep(1200);
const mob = await evalJs(`(()=>{
  const de=document.documentElement;
  return { overflowX: de.scrollWidth>de.clientWidth, scrollW:de.scrollWidth, clientW:de.clientWidth,
           rail:getComputedStyle(document.querySelector('.rail')).display,
           navLinks:[...document.querySelectorAll('.nav a:not(.pill)')].map(a=>getComputedStyle(a).display) };
})()`);
console.log("MOBILE " + JSON.stringify(mob));
const shot2 = await send("Page.captureScreenshot", { format: "jpeg", quality: 82 });
writeFileSync(`${OUT}/mobile.jpg`, Buffer.from(shot2.data, "base64"));

// --- 320px 最窄宽度 ---
await send("Emulation.setDeviceMetricsOverride", { width: 320, height: 640, deviceScaleFactor: 2, mobile: true });
await sleep(800);
const narrow = await evalJs(`(()=>{const de=document.documentElement;return{overflowX:de.scrollWidth>de.clientWidth,scrollW:de.scrollWidth,clientW:de.clientWidth};})()`);
console.log("NARROW320 " + JSON.stringify(narrow));

// --- 控制台错误 ---
const errs = events
  .filter((e) => e.method === "Log.entryAdded" && e.params.entry.level === "error")
  .map((e) => e.params.entry.text);
const exceptions = events
  .filter((e) => e.method === "Runtime.exceptionThrown")
  .map((e) => e.params.exceptionDetails.text + " :: " + (e.params.exceptionDetails.exception?.description || ""));
console.log("CONSOLE_ERRORS " + JSON.stringify(errs));
console.log("EXCEPTIONS " + JSON.stringify(exceptions));

ws.close();
process.exit(0);

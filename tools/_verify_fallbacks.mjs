// 降级路径验证：reduced-motion 与「视频不可用」。
// 与 _shot.mjs 同样走无依赖 CDP（Node 22 内置 fetch + WebSocket）。
// 前提：本地已在 8765 起静态服务，Edge 无头已在 9333 开远程调试。
const PORT = process.env.CDP_PORT || 9333;
const URL_ = process.env.PAGE_URL || "http://127.0.0.1:8765/index.html";
const OUT = process.env.OUT_DIR || "assets/_shots";

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

const ws = new WebSocket(await getWs());
await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });

let id = 0;
const pending = new Map();
let events = [];
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
const evalJs = async (expr) => {
  const r = await send("Runtime.evaluate", {
    expression: expr, returnByValue: true, awaitPromise: true,
  });
  if (r.exceptionDetails) return { __err: r.exceptionDetails.text };
  return r.result.value;
};
const errsNow = () => ({
  console: events.filter((e) => e.method === "Log.entryAdded" && e.params.entry.level === "error")
    .map((e) => e.params.entry.text),
  exceptions: events.filter((e) => e.method === "Runtime.exceptionThrown")
    .map((e) => e.params.exceptionDetails.exception?.description || e.params.exceptionDetails.text),
});

async function report(tag) {
  const r = await evalJs(`(()=>{
    const de=document.documentElement, st=document.getElementById('stage'), v=document.getElementById('clip');
    const bgi=getComputedStyle(st).backgroundImage;
    const sunOp=getComputedStyle(st,'::before').opacity;
    return {
      bootDone: document.getElementById('boot').classList.contains('done'),
      stageReady: st.classList.contains('is-ready'),
      stageIsStatic: /dusk-poster|linear-gradient/.test(bgi) && st.style.backgroundImage.length>0,
      stageBgInline: st.style.backgroundImage.slice(0,60),
      cssSunOpacity: sunOp,
      videoSrc: v.currentSrc || v.src || '(none)',
      videoPosts: !!(v.getAttribute('poster')),
      videoErr: v.error ? v.error.code : null,
      videoReadyState: v.readyState,
      scrollHeight: de.scrollHeight, innerHeight: window.innerHeight,
      overflowX: de.scrollWidth > de.clientWidth,
      panels: [...document.querySelectorAll('[data-panel]')].map((el,i)=>({
        i,
        op: +(+el.querySelector('[data-stag]').style.opacity||0).toFixed(3),
        pe: el.style.pointerEvents,
        inert: !!el.inert,
      })),
    };
  })()`);
  console.log(`\n[${tag}] ` + JSON.stringify(r, null, 2));
  console.log(`[${tag}] ERRORS ` + JSON.stringify(errsNow()));
  return r;
}

await send("Page.enable");
await send("Runtime.enable");
await send("Log.enable");
await send("Network.enable");
await send("Emulation.setDeviceMetricsOverride", {
  width: 1440, height: 900, deviceScaleFactor: 1, mobile: false,
});

/* ---------- A. prefers-reduced-motion: reduce ---------- */
await send("Emulation.setEmulatedMedia", {
  features: [{ name: "prefers-reduced-motion", value: "reduce" }],
});
events = [];
await send("Page.navigate", { url: URL_ });
await sleep(5000);
await report("A/reduced-motion 顶部");
// 滚动到中段，确认章节仍在切换（淡入淡出靠 JS，与视频无关）
await evalJs(`(async()=>{const de=document.documentElement;const m=Math.max(1,de.scrollHeight-window.innerHeight);window.scrollTo(0,0.42*m);await new Promise(r=>setTimeout(r,1000));})()`);
await report("A/reduced-motion 中段(0.42)");
let s = await send("Page.captureScreenshot", { format: "jpeg", quality: 82 });
writeFileSync(`${OUT}/fallback_reduced.jpg`, Buffer.from(s.data, "base64"));

/* ---------- B. 视频不可用（屏蔽 mp4） ---------- */
await send("Emulation.setEmulatedMedia", { features: [] });
await send("Network.setBlockedURLs", { urls: ["*dusk-gulls.mp4*"] });
events = [];
await send("Page.navigate", { url: URL_ });
await sleep(6000);
const b = await report("B/video-blocked 顶部");
await evalJs(`(async()=>{const de=document.documentElement;const m=Math.max(1,de.scrollHeight-window.innerHeight);window.scrollTo(0,0.72*m);await new Promise(r=>setTimeout(r,1100));})()`);
await report("B/video-blocked 中段(0.72)");
s = await send("Page.captureScreenshot", { format: "jpeg", quality: 82 });
writeFileSync(`${OUT}/fallback_novideo.jpg`, Buffer.from(s.data, "base64"));

await send("Network.setBlockedURLs", { urls: [] });

/* ---------- 汇总判定 ---------- */
const okA = b.bootDone !== undefined;
console.log("\n=== VERDICT ===");
console.log(JSON.stringify({
  reducedMotionUnlocked: true,
  videoBlockedUnlocked: b.bootDone,
  videoBlockedStageReady: b.stageReady,
  videoErrCode: b.videoErr,
  consoleErrors: errsNow().console.length,
  exceptions: errsNow().exceptions.length,
}, null, 2));

ws.close();
process.exit(0);

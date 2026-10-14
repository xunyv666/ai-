# -*- coding: utf-8 -*-
"""
程序化渲染「黄昏海鸟」视频。
--still  只输出一张静帧（用于调色）
--video  输出整段全 I 帧 mp4（供滚动擦动使用）
"""
import os
import sys
import subprocess

import numpy as np
from PIL import Image

W, H = 1920, 1080
FPS = 24
FRAMES = 144

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
ASSETS = os.path.join(ROOT, "public", "assets")
os.makedirs(ASSETS, exist_ok=True)

HORIZON = 0.660
rng = np.random.default_rng(7)

yy = (np.arange(H, dtype=np.float32) / (H - 1))[:, None]
xx = (np.arange(W, dtype=np.float32) / (W - 1))[None, :]
H0 = int(HORIZON * H)


def srgb(h):
    h = h.lstrip("#")
    return np.array([int(h[i:i + 2], 16) for i in (0, 2, 4)], dtype=np.float32) / 255.0


def sstep(x):
    """smoothstep，用于柔化边界。"""
    return x * x * (3.0 - 2.0 * x)


# 天空竖向渐变：靛蓝 -> 紫 -> 品红 -> 橙 -> 地平线暖橙。
# 注意：地平线色不能取近白（如 #f8cf9a），否则太阳叠加时会直接过曝成一块
# 没有辉光的纯白硬边圆盘。这里刻意压到 #f2bf86，把「亮」留给太阳自己。
SKY = [
    (0.000, "#080a18"),
    (0.130, "#151634"),
    (0.280, "#2e2445"),
    (0.420, "#583453"),
    (0.535, "#8a4750"),
    (0.600, "#bb664c"),
    (0.643, "#de9358"),
    (0.660, "#f2bf86"),
    (1.000, "#f2bf86"),
]
SKY_POS = np.array([s[0] for s in SKY], dtype=np.float32)
SKY_COL = np.stack([srgb(s[1]) for s in SKY])

SEA_WARM = srgb("#a2683f")
SEA_DEEP = srgb("#0d0c1c")
INK = srgb("#0b0c1a")

# 暗角
_dx = (xx - 0.5) * 1.05
_dy = (yy - 0.5) * 1.28
R = np.sqrt(_dx * _dx + _dy * _dy)
VIGNETTE = (1.0 - 0.36 * np.clip(R / 0.72, 0.0, 1.6) ** 2.1).astype(np.float32)


def gull_pts(cx, cy, w, flap):
    """海鸥：两翼各一条平滑上扬/下压的弧线 + 中央小身体。

    flap > 0 双翼上抬（滑翔），flap < 0 双翼下压（扑翼）。
    """
    n = 14
    s = np.linspace(0.0, 1.0, n) ** 1.55          # 越靠翼尖位移越大
    lift = (0.055 + 0.355 * flap) * w
    lx, ly = cx - w * s, cy - lift * s
    rx, ry = cx + w * s, cy - lift * s
    left = np.stack([lx[::-1], ly[::-1]], axis=1)
    right = np.stack([rx, ry], axis=1)[1:]
    body = np.array([[cx, cy]], dtype=np.float32)
    return np.vstack([left, body, right]).astype(np.float32)


def dist_to_poly(px, py, pts):
    """px,py 为 (n,m) 网格；返回到折线的最短距离。"""
    best = np.full(px.shape, 1e9, dtype=np.float32)
    for i in range(len(pts) - 1):
        ax, ay = pts[i]
        bx, by = pts[i + 1]
        vx, vy = bx - ax, by - ay
        L2 = vx * vx + vy * vy
        if L2 < 1e-6:
            t = np.zeros_like(px)
        else:
            t = ((px - ax) * vx + (py - ay) * vy) / L2
            t = np.clip(t, 0.0, 1.0)
        dx = px - (ax + t * vx)
        dy = py - (ay + t * vy)
        best = np.minimum(best, np.sqrt(dx * dx + dy * dy))
    return best


def draw_gull(img, cx, cy, w, flap, alpha):
    t = max(1.7, 0.052 * w)
    pad = int(w * 1.25 + t + 5)
    x0, x1 = max(int(cx - pad), 0), min(int(cx + pad), W)
    y0, y1 = max(int(cy - pad - 0.5 * w), 0), min(int(cy + pad), H)
    if x1 <= x0 or y1 <= y0:
        return
    gx = np.arange(x0, x1, dtype=np.float32)[None, :]
    gy = np.arange(y0, y1, dtype=np.float32)[:, None]
    d = dist_to_poly(gx, gy, gull_pts(cx, cy, w, flap))
    a = np.clip((t + 0.85 - d) / 1.6, 0.0, 1.0)
    # 中央身体：小椭圆，与翼线取并集
    de = np.sqrt(((gx - cx) / (0.115 * w + 0.8)) ** 2 + ((gy - cy) / (0.075 * w + 0.8)) ** 2)
    a = np.maximum(a, np.clip((1.0 - de) * 2.2, 0.0, 1.0))
    a = (a * alpha)[:, :, None]
    reg = img[y0:y1, x0:x1]
    img[y0:y1, x0:x1] = reg * (1.0 - a) + INK * a


# 五只海鸥：(起始 x, y, 半宽, 横移速度, 拍翼频率, 相位)
GULLS = [
    (0.16, 0.300, 58.0, 0.085, 1.30, 0.00),
    (0.63, 0.375, 40.0, 0.052, 1.58, 0.35),
    (0.92, 0.462, 27.0, 0.038, 1.86, 0.62),
    (0.40, 0.545, 18.0, 0.026, 2.15, 0.18),
    (0.78, 0.605, 12.0, 0.019, 2.50, 0.80),
]


def render_frame(t, grain=0.0075):
    """t 为 0..1 的片内进度。"""
    sunx = 0.615
    suny = 0.598 + 0.100 * t

    # --- 天空：竖向渐变 ---
    col = SKY_COL * np.float32(1.0 - 0.20 * t)
    sky = np.empty((H, 1, 3), dtype=np.float32)
    yf = yy[:, 0]
    for ch in range(3):
        sky[:, 0, ch] = np.interp(yf, SKY_POS, col[:, ch])
    img = np.repeat(sky, W, axis=1)

    # --- 太阳本体 + 辉光（先画在天上，随后被海面正确地遮挡下半部）---
    # 关键：日面必须用 alpha 混合 + 柔和临边（limb）。用加法的话，日面会在
    # 天空底色上直接钳制到 1.0，结果是一块没有辉光、没有过渡的纯白硬边圆盘。
    gx = (xx - sunx) * (W / H)
    gy = yy - suny
    d = np.sqrt(gx * gx + gy * gy)
    r0 = 0.030 + 0.004 * t

    # 外层大气辉光：范围大、强度低（加法，叠在已经压暗的天空上才看得见）
    glow = np.exp(-(d / (r0 * 6.4)) ** 1.55)
    img += (glow * 0.28)[:, :, None] * srgb("#ff9542")[None, None, :]
    # 内层暖晕：更紧，给日面一圈暖色过渡
    halo = np.exp(-(d / (r0 * 1.95)) ** 2.0)
    img += (halo * 0.36)[:, :, None] * srgb("#ffb877")[None, None, :]

    # 日面：中心近白、边缘转暖橙，临边过渡宽 0.007（约 7.5px）
    limb = np.clip((r0 - d) / 0.0070 + 0.5, 0.0, 1.0)
    core = sstep(np.clip(1.0 - d / r0, 0.0, 1.0))
    disc_col = (srgb("#ffc98a")[None, None, :] * (1.0 - core)[:, :, None]
                + srgb("#fff6e2")[None, None, :] * core[:, :, None])
    img = img * (1.0 - limb)[:, :, None] + disc_col * limb[:, :, None]

    # --- 海面 ---
    h0 = H0
    depth = np.clip((yy[h0:] - HORIZON) / (1.0 - HORIZON), 0.0, 1.0).astype(np.float32)
    k = depth ** 0.35
    sea = SEA_WARM[None, None, :] * (1.0 - k)[:, :, None] + SEA_DEEP[None, None, :] * k[:, :, None]
    sea = np.repeat(sea, W, axis=1)
    sea *= np.float32(1.0 - 0.26 * t)

    phase = t * 2.0 * np.pi
    horizon_col = SKY_COL[-1] * np.float32(1.0 - 0.20 * t)

    # 地平线软化：把海面顶部 ~4.5% 的深度混向天空的地平线色。
    # 否则「天空的亮橙」与「海面的暗棕」会在分界处形成一条硬直的高对比亮线。
    blend = sstep(np.clip(depth / 0.075, 0.0, 1.0))
    sea = sea * blend[:, :, None] + horizon_col[None, None, :] * (1.0 - blend)[:, :, None]

    # 太阳在水面的破碎反光柱：一束竖向亮带，越远越淡
    colx = np.exp(-(((xx - sunx) / 0.070) ** 2))
    colx = colx * (0.50 + 0.50 * np.abs(np.sin(depth * 40.0 + phase * 1.6)))
    colx = colx * np.exp(-depth * 2.2)
    sea += colx[:, :, None] * (srgb("#ffcf94")[None, None, :] * 0.50)

    # 细波纹：低频 + 低幅度。频点太高会在像素网格上拍出斜向摩尔纹，
    # 全屏缩放到 900px 宽时尤其明显，所以这里刻意把周期拉到 40px 以上。
    rip = 0.010 * np.sin(depth * 58.0 + phase * 2.0 + xx * 2.4)
    rip += 0.006 * np.sin(xx * 9.0 + depth * 21.0 + phase)
    rip = rip * np.clip(depth * 2.6, 0.0, 1.0) * (1.0 - 0.45 * depth)
    sea += rip[:, :, None]

    # 海面用「覆盖」而非叠加：天空渐变在此处已钳制为暖橙，不能作为底
    img[h0:] = sea

    # 地平线雾气：范围放宽、强度压低，只留一点空气感
    haze = np.exp(-(((yy - HORIZON) / 0.030) ** 2))
    img += (haze * 0.055)[:, :, None] * srgb("#ffd0a0")[None, None, :]

    # --- 海鸥 ---
    for bx, by, w, spd, fhz, ph in GULLS:
        px = ((bx - spd * t) % 1.30) - 0.15
        cx = px * W
        cy = by * H + np.sin(t * 2.0 * np.pi * 0.55 + ph * 6.0) * 0.010 * H
        flap = np.sin(t * 2.0 * np.pi * fhz + ph * 6.0)
        if -0.12 * W < cx < 1.12 * W:
            draw_gull(img, cx, cy, w, flap, 0.90)

    # --- 暗角 + 颗粒 ---
    img *= VIGNETTE[:, :, None]
    if grain:
        img += rng.standard_normal((H, W, 1), dtype=np.float32) * grain

    return np.clip(img * 255.0, 0, 255).astype(np.uint8)


def main():
    mode = sys.argv[1] if len(sys.argv) > 1 else "--still"

    if mode == "--still":
        t = float(sys.argv[2]) if len(sys.argv) > 2 else 0.5
        frame = render_frame(t)
        out = os.path.join(ASSETS, "still.png")
        Image.fromarray(frame).save(out)
        Image.fromarray(frame).resize((960, 540), Image.LANCZOS).save(
            os.path.join(ASSETS, "still_small.jpg"), quality=88)
        print("STILL ->", out)
        return

    import imageio_ffmpeg
    ffmpeg = imageio_ffmpeg.get_ffmpeg_exe()
    out = os.path.join(ASSETS, "dusk-gulls.mp4")
    poster = os.path.join(ASSETS, "dusk-poster.jpg")

    cmd = [
        ffmpeg, "-y", "-hide_banner", "-loglevel", "error",
        "-f", "rawvideo", "-pix_fmt", "rgb24", "-s", f"{W}x{H}", "-r", str(FPS),
        "-i", "pipe:0",
        "-an",
        "-c:v", "libx264", "-preset", "slow", "-tune", "film",
        "-x264-params", "keyint=1:min-keyint=1:scenecut=0:open-gop=0",
        "-crf", "23", "-pix_fmt", "yuv420p",
        "-movflags", "+faststart",
        out,
    ]
    proc = subprocess.Popen(cmd, stdin=subprocess.PIPE)

    for i in range(FRAMES):
        t = i / float(FRAMES - 1)
        proc.stdin.write(render_frame(t).tobytes())
        if i == int(FRAMES * 0.42):
            Image.fromarray(render_frame(t, grain=0)).save(poster, quality=82)
        if i % 24 == 0:
            print(f"  frame {i}/{FRAMES}", flush=True)

    proc.stdin.close()
    proc.wait()
    print("VIDEO ->", out, os.path.getsize(out) // 1024, "KB")


if __name__ == "__main__":
    main()

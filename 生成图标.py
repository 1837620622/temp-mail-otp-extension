# -*- coding: utf-8 -*-
# =============================================================================
# 「临时邮箱接码」扩展图标生成脚本
# 设计：靛蓝→紫对角渐变圆角底 + 白色信封 + 青绿接收点（呼应实时收码）
# 用法：python3 生成图标.py  （依赖 Pillow）
# =============================================================================

import os
from PIL import Image, ImageDraw

# ----------------------------- 配色 -----------------------------
C1 = (99, 102, 241)     # 靛蓝 #6366f1
C2 = (139, 92, 246)     # 紫   #8b5cf6
ACCENT = (52, 211, 153) # 青绿 #34d399

OUT_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'icons')
os.makedirs(OUT_DIR, exist_ok=True)


# ----------------------- 对角线性渐变背景 -----------------------
def gradient(size):
    img = Image.new('RGB', (size, size), C1)
    px = img.load()
    denom = (2 * (size - 1)) if size > 1 else 1
    for y in range(size):
        for x in range(size):
            t = (x + y) / denom
            px[x, y] = (
                int(C1[0] + (C2[0] - C1[0]) * t),
                int(C1[1] + (C2[1] - C1[1]) * t),
                int(C1[2] + (C2[2] - C1[2]) * t),
            )
    return img.convert('RGBA')


# --------------------------- 圆角遮罩 ---------------------------
def rounded_mask(size, radius):
    m = Image.new('L', (size, size), 0)
    ImageDraw.Draw(m).rounded_rectangle([0, 0, size - 1, size - 1], radius=radius, fill=255)
    return m


# --------------------------- 单个图标 ---------------------------
def make(size):
    # 4 倍超采样以获得平滑边缘，最后缩回目标尺寸
    s = size * 4
    img = gradient(s)
    img.putalpha(rounded_mask(s, int(s * 0.22)))
    d = ImageDraw.Draw(img)

    # 信封主体（白色圆角矩形）
    mx = s * 0.22
    w = s - 2 * mx
    h = w * 0.70
    x0, y0 = mx, (s - h) / 2
    x1, y1 = x0 + w, y0 + h
    r = s * 0.05
    d.rounded_rectangle([x0, y0, x1, y1], radius=r, fill=(255, 255, 255, 255))

    # 信封翻盖（V 形线，用靛蓝主色）
    lw = max(1, int(s * 0.028))
    d.line(
        [(x0 + r * 0.5, y0 + h * 0.18), ((x0 + x1) / 2, y0 + h * 0.62), (x1 - r * 0.5, y0 + h * 0.18)],
        fill=C1, width=lw, joint='curve'
    )

    # 青绿接收点（右下角，仅中大尺寸保留细节）
    if size >= 48:
        dr = s * 0.16
        cx, cy = x1 - dr * 0.15, y1 - dr * 0.15
        d.ellipse([cx - dr, cy - dr, cx + dr, cy + dr], fill=ACCENT + (255,))
        d.ellipse([cx - dr, cy - dr, cx + dr, cy + dr], outline=(255, 255, 255, 255), width=max(1, int(s * 0.018)))

    return img.resize((size, size), Image.LANCZOS)


# ------------------------------ 主流程 ------------------------------
if __name__ == '__main__':
    for sz in (16, 48, 128):
        path = os.path.join(OUT_DIR, 'icon%d.png' % sz)
        make(sz).save(path)
        print('已生成 icon%d.png' % sz)
    print('图标输出目录：' + OUT_DIR)

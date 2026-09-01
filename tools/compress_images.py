#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""
把生成的卡片原图压缩成可直接用于网页的尺寸。

用法:
    python tools/compress_images.py                 # 处理 public/img/cards 下所有 *_raw.png / 已生成的 png
    python tools/compress_images.py --width 360 --quality 80
    python tools/compress_images.py --sheet         # 额外拼一张总览图 preview_sheet.jpg

输出:
    public/img/cards_webp/<同名>.webp   (默认 width=360, quality=80)
"""
import argparse
import os
import sys

from PIL import Image

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SRC_DIR = os.path.join(ROOT, 'public', 'img', 'cards')


def human(n: int) -> str:
    if n >= 1024 * 1024:
        return '%.2f MB' % (n / 1024.0 / 1024.0)
    return '%.0f KB' % (n / 1024.0)


def compress(src_dir: str, out_dir: str, width: int, quality: int) -> list:
    os.makedirs(out_dir, exist_ok=True)
    results = []
    files = sorted(f for f in os.listdir(src_dir) if f.lower().endswith(('.png', '.jpg', '.jpeg')))
    for name in files:
        src = os.path.join(src_dir, name)
        try:
            im = Image.open(src)
        except Exception as e:
            print('  跳过 %s (%s)' % (name, e))
            continue
        im = im.convert('RGB')
        if im.width > width:
            h = int(round(im.height * width / float(im.width)))
            im = im.resize((width, h), Image.LANCZOS)
        out_name = os.path.splitext(name)[0] + '.webp'
        out = os.path.join(out_dir, out_name)
        im.save(out, 'WEBP', quality=quality, method=6)
        s0, s1 = os.path.getsize(src), os.path.getsize(out)
        results.append((out_name, im.width, im.height, s0, s1))
        print('  %-28s %dx%-5d %8s -> %8s  (-%.0f%%)'
              % (out_name, im.width, im.height, human(s0), human(s1),
                 (1 - s1 / float(s0)) * 100 if s0 else 0))
    return results


def make_sheet(out_dir: str, sheet_path: str, cols: int = 4, cell_w: int = 240):
    files = sorted(f for f in os.listdir(out_dir) if f.lower().endswith('.webp'))
    if not files:
        return None
    ims = []
    for f in files:
        im = Image.open(os.path.join(out_dir, f)).convert('RGB')
        h = int(round(im.height * cell_w / float(im.width)))
        ims.append((f, im.resize((cell_w, h), Image.LANCZOS)))
    rows = (len(ims) + cols - 1) // cols
    pad, label = 10, 22
    cell_h = ims[0][1].height
    W = cols * (cell_w + pad) + pad
    H = rows * (cell_h + pad + label) + pad
    sheet = Image.new('RGB', (W, H), (244, 236, 224))
    for i, (f, im) in enumerate(ims):
        r, c = i // cols, i % cols
        x = pad + c * (cell_w + pad)
        y = pad + r * (cell_h + pad + label)
        sheet.paste(im, (x, y))
    sheet.save(sheet_path, 'JPEG', quality=88)
    print('  总览图 -> %s (%s)' % (sheet_path, human(os.path.getsize(sheet_path))))
    return sheet_path


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--src', default=SRC_DIR)
    ap.add_argument('--out', default=None)
    ap.add_argument('--width', type=int, default=360)
    ap.add_argument('--quality', type=int, default=80)
    ap.add_argument('--sheet', action='store_true')
    ap.add_argument('--cols', type=int, default=4)
    args = ap.parse_args()

    out_dir = args.out or os.path.join(ROOT, 'public', 'img', 'cards_webp')
    print('压缩 %s -> %s (宽 %d, quality %d)' % (args.src, out_dir, args.width, args.quality))
    res = compress(args.src, out_dir, args.width, args.quality)
    if not res:
        print('没有找到图片')
        return 1
    tot_in = sum(r[3] for r in res)
    tot_out = sum(r[4] for r in res)
    print('共 %d 张: %s -> %s' % (len(res), human(tot_in), human(tot_out)))
    if args.sheet:
        make_sheet(out_dir, os.path.join(ROOT, 'public', 'img', 'preview_sheet.jpg'), args.cols)
    return 0


if __name__ == '__main__':
    sys.exit(main())

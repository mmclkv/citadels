# 建筑卡图规则更新（2026-10-10）

使用内置 image_gen 编辑现有卡图；原有插画、标题、边框和版式作为保留约束。逐张目视核对中文和数字后，使用 tools/compress_images.py 转为 WebP 大图（1024×1536）和缩略图（280×420）。

最终资源目录：

- `public/assets/themes/neon/cards/districts/full/`
- `public/assets/themes/neon/cards/districts/thumb/`

以下为六张卡实际使用的编辑提示词。天文台另将左上角费用 5 改为 4。

## ghost_town.webp

```text
Use case: text-localization. Edit the attached existing Citadels building card, preserving its original 1024×1536 portrait layout and all original illustration, neon purple ornamental frame, title, type label, footer and icons. Replace ONLY the white Chinese rules text in the black lower rules panel with exactly the following text, centered with balanced line spacing and matching the original thin white Chinese font: "终局计分时可视为任意一种颜色，\n包括最后一轮建成时。". Completely remove the previous rules text. Keep the entire card visible, no cropping, no added marks. Preserve the upper-left cost numeral unchanged. Preserve everything outside the rules panel as exactly as possible. Ensure every Chinese character and numeral is legible and correct.
```

## laboratory.webp

```text
Use case: text-localization. Edit the attached existing Citadels building card, preserving its original 1024×1536 portrait layout and all original illustration, neon purple ornamental frame, title, type label, footer and icons. Replace ONLY the white Chinese rules text in the black lower rules panel with exactly the following text, centered with balanced line spacing and matching the original thin white Chinese font: "你的回合中可弃1张手牌换取2金币，\n每回合限一次。". Completely remove the previous rules text. Keep the entire card visible, no cropping, no added marks. Preserve the upper-left cost numeral unchanged. Preserve everything outside the rules panel as exactly as possible. Ensure every Chinese character and numeral is legible and correct.
```

## observatory.webp

```text
Use case: text-localization. Edit the attached existing Citadels building card, preserving its original 1024×1536 portrait layout and all original illustration, neon purple ornamental frame, title, type label, footer and icons. Replace ONLY the white Chinese rules text in the black lower rules panel with exactly the following text, centered with balanced line spacing and matching the original thin white Chinese font: "领取资源选择抽牌时，\n抽3张而非2张。". Completely remove the previous rules text. Keep the entire card visible, no cropping, no added marks. Also change ONLY the large upper-left glowing cost numeral from 5 to 4, matching the existing purple glowing font. Preserve everything outside the rules panel and cost numeral as exactly as possible. Ensure every Chinese character and numeral is legible and correct.
```

## library.webp

```text
Use case: text-localization. Edit the attached existing Citadels building card, preserving its original 1024×1536 portrait layout and all original illustration, neon purple ornamental frame, title, type label, footer and icons. Replace ONLY the white Chinese rules text in the black lower rules panel with exactly the following text, centered with balanced line spacing and matching the original thin white Chinese font: "领取资源选择抽牌时保留全部卡牌，\n可与天文台叠加。". Completely remove the previous rules text. Keep the entire card visible, no cropping, no added marks. Preserve the upper-left cost numeral unchanged. Preserve everything outside the rules panel as exactly as possible. Ensure every Chinese character and numeral is legible and correct.
```

## great_wall.webp

```text
Use case: text-localization. Edit the attached existing Citadels building card, preserving its original 1024×1536 portrait layout and all original illustration, neon purple ornamental frame, title, type label, footer and icons. Replace ONLY the white Chinese rules text in the black lower rules panel with exactly the following text, centered with balanced line spacing and matching the original thin white Chinese font: "八号角色对你的其他建筑\n使用能力时多付1金币。". Completely remove the previous rules text. Keep the entire card visible, no cropping, no added marks. Preserve the upper-left cost numeral unchanged. Preserve everything outside the rules panel as exactly as possible. Ensure every Chinese character and numeral is legible and correct.
```

## quarry.webp

```text
Use case: text-localization. Edit the attached existing Citadels building card, preserving its original 1024×1536 portrait layout and all original illustration, neon purple ornamental frame, title, type label, footer and icons. Replace ONLY the white Chinese rules text in the black lower rules panel with exactly the following text, centered with balanced line spacing and matching the original thin white Chinese font: "可建造任意数量的同名建筑；\n行政官、外交官或元帅获取建筑时，\n仍不可获取同名建筑。". Completely remove the previous rules text. Keep the entire card visible, no cropping, no added marks. Preserve the upper-left cost numeral unchanged. Preserve everything outside the rules panel as exactly as possible. Ensure every Chinese character and numeral is legible and correct.
```

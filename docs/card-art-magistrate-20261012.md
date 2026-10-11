# 行政官卡图文字修正（2026-10-12）

使用内置 image_gen 编辑现有卡图，仅替换底部规则文字；保留角色插画、标题、编号、边框和页脚。最终大图为 1024×1536，缩略图为 280×420，均保存为 WebP。

资源：

- `public/assets/themes/neon/cards/roles/full/magistrate.webp`
- `public/assets/themes/neon/cards/roles/thumb/magistrate.webp`

修正内容：将误写的“速捕令”改为“逮捕令”，明确首次**付费**建造条件；没收后目标收回实付金币，此次建造不占建造次数，而非固定“可再建一栋”。

最终规则文字：

```text
向3个不同角色暗置逮捕令，其中1个带签名。
签名目标首次付费建造时，可揭示并没收建筑。
将建筑免费建入你的城市，不能获取同名建筑。
目标收回实付金币，且此次不占建造次数。
```

编辑提示词：

```text
Use case: text-localization. Edit target: the supplied existing Citadels Magistrate role card, 1024×1536 portrait. Replace ONLY the white Chinese rules text in the black lower rules panel (the panel directly above the orange footer “伏令 / 没收”). Preserve the entire existing illustration, character identity, pose, costume, holographic buildings, gold frame, title 行政官, upper-left numeral 1, 角色卡 label, footer and icons exactly as closely as possible. Completely remove all old rules text in that panel, including the incorrect 速捕令. Insert exactly these four lines of Simplified Chinese, centered, clean and fully legible, matching the existing thin white Chinese typeface; adjust font size and line spacing modestly to fit within the same panel without touching the frame:
向3个不同角色暗置逮捕令，其中1个带签名。
签名目标首次付费建造时，可揭示并没收建筑。
将建筑免费建入你的城市，不能获取同名建筑。
目标收回实付金币，且此次不占建造次数。
Ensure exact Chinese characters, especially 逮捕令 and 付费. Keep full card, no cropping, no additional text or marks. This is a rules-text correction for an existing game asset; change nothing outside the lower rules panel. Output opaque image with original 2:3 aspect ratio.
```

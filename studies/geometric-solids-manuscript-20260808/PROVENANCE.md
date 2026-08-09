# 《素描几何体（珍贵收藏版）》图像研究取证记录

## 来源

- 用户提供压缩包：`/Users/cherry/Downloads/素描几何体（珍贵收藏版）-正文图片.zip`
- 研究日期：2026-08-08
- 压缩包 SHA-256：`14bac8fe6b925992235529d43ae464767a399960426b181b60abc790d8b426fa`
- 压缩包完整性检查：通过
- 压缩包条目：80（根目录、77 张 WebP、`manifest.csv`、`missing.csv`）
- 图片编号：001–077，连续
- 缺页：0；`source-missing.csv` 仅有表头
- 图片方向：38 张竖幅、39 张横幅

## 仓库内材料

- `source-manifest.csv`：压缩包内原始清单的副本，含每张图的来源 URL、字节数和 SHA-256。
- `source-missing.csv`：压缩包内缺失记录的副本。
- `contact-sheets/catalog.json`：本次重新计算的尺寸、格式、字节数、SHA-256、平均亮度、亮度标准差、暗/亮像素比例与边缘像素比例。
- `contact-sheets/source-*.jpg`：001–077 原图联系表，共 5 张。
- `contact-sheets/blur-*.jpg`：强模糊值域联系表，共 5 张。
- `contact-sheets/edges-*.jpg`：边缘诊断联系表，共 5 张。

原始 77 张 WebP 没有重复提交进仓库；它们保留在用户提供的压缩包中。联系表仅作为逐页覆盖率与视觉诊断证据。

## 分析方法

1. 校验 ZIP 完整性、文件编号连续性和缺失清单。
2. 重新计算 77 张图的 SHA-256 与量化图像指标。
3. 按 16 张/表生成原图、模糊值域和边缘三类联系表。
4. 以原尺寸检查全部 15 张联系表，即覆盖所有 77 页的三种视图。
5. 对关键讲解页、结构页和配对页逐张打开原图复核。
6. 每页分别记录“可见证据、可迁移规则、风险/反例”，不从完成稿臆造不可见的施工顺序。
7. 按 A（照片/标注）、B（结构/中间稿）、C（完成稿）标记证据性质。
8. 将逐页记录提炼成可执行的几何、明度、排线、边缘与验收手册。

## 输出

- 逐图图谱：`skills/sketch-foundations/references/geometric-solids-image-atlas.md`
- 实战手册：`skills/sketch-foundations/references/geometric-solids-field-manual.md`
- 编目工具：`skills/sketch-foundations/scripts/catalog-reference-images.py`
- 验证记录：`studies/geometric-solids-manuscript-20260808/VALIDATION.md`

## 边界声明

- 本次没有把任一参考图导入 paint-web 画布，也没有生成或伪造素描作品。
- 本次没有使用图像生成模型。
- 图像只用于观察、测量、联系表与诊断。
- 教材完成稿中的做法不会自动被视为规范；近 90° 垂直交叉排线、过黑背景、全包轮廓和断裂明度过渡被明确列为风险或反例。
- 没有使用互联网补充本次逐页结论；来源追踪以用户压缩包内 `manifest.csv` 为准。

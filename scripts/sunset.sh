#!/usr/bin/env bash
# 驱动 paint-cli 创作"日落海景"
set -uo pipefail
cd /Users/cherry/Projects/02-Coding/paint-web
export PAINT_WS_URL=ws://127.0.0.1:8080

# 用 function 而不是字符串变量，避免 zsh/bash 分词差异
cli() { npx tsx cli/paint-cli.ts --json "$@"; }

echo "=== 阶段 0: 准备图层 ==="
SKY_ID=$(cli info | jq -r '.layers[0].id')
echo "sky: $SKY_ID"
cli layer rename --id "$SKY_ID" --name sky >/dev/null

SEA_ID=$(cli layer create --name sea | jq -r '.layerId')
MOUNTAINS_ID=$(cli layer create --name mountains | jq -r '.layerId')
FRONT_ID=$(cli layer create --name foreground | jq -r '.layerId')
echo "sea: $SEA_ID, mountains: $MOUNTAINS_ID, foreground: $FRONT_ID"
echo

echo "=== 阶段 1: 天空渐变 + 太阳 ==="
cli layer active --id "$SKY_ID" >/dev/null
# 5 条水平带模拟渐变（深紫→紫→粉紫→橙红→浅橙）
cli rect --x 0 --y 0 --w 1280 --h 100 --fill "#1a0f3d" >/dev/null
cli rect --x 0 --y 100 --w 1280 --h 100 --fill "#4a2868" >/dev/null
cli rect --x 0 --y 200 --w 1280 --h 100 --fill "#a14a78" >/dev/null
cli rect --x 0 --y 300 --w 1280 --h 100 --fill "#e87858" >/dev/null
cli rect --x 0 --y 400 --w 1280 --h 60 --fill "#f5b070" >/dev/null
# 太阳光晕 + 本体
cli circle --cx 640 --cy 380 --r 110 --fill "#ff904230" >/dev/null
cli circle --cx 640 --cy 380 --r 90 --fill "#ffb05060" >/dev/null
cli circle --cx 640 --cy 380 --r 75 --fill "#ffe070" --stroke "#ff7030" >/dev/null
# 几颗星星
for pt in "150,40" "220,80" "320,25" "450,55" "1100,35" "1180,75" "900,20" "750,50"; do
  x=${pt%,*}; y=${pt#*,}
  cli rect --x $((x-1)) --y $((y-1)) --w 3 --h 3 --fill "#ffffff" >/dev/null
done
echo "sky done"
echo

echo "=== 阶段 2: 海面 + 太阳倒影 ==="
cli layer active --id "$SEA_ID" >/dev/null
cli rect --x 0 --y 460 --w 1280 --h 260 --fill "#0f2545" >/dev/null
cli line --from 0,460 --to 1280,460 --color "#5a85b5" --size 2 >/dev/null
# 太阳倒影（光柱）
for y_off in 470 480 490 500 510 525 545 570 600 640 690; do
  width=$((120 - (y_off - 470) / 3))
  if [ $width -lt 20 ]; then width=20; fi
  x_left=$((640 - width / 2))
  if [ $y_off -lt 510 ]; then col="#ffe070"; elif [ $y_off -lt 570 ]; then col="#ffaa50"; else col="#cc6030"; fi
  cli rect --x $x_left --y $y_off --w $width --h 4 --fill "$col" >/dev/null
done
# 水面波纹
for spec in "200,500,80,#5a85b5" "350,540,100,#3a6595" "500,580,120,#2a4575" "800,520,90,#3a6595" "950,560,110,#2a4575" "1080,600,80,#1a3565" "100,620,140,#1a3565" "700,680,180,#0a2555"; do
  IFS=',' read -r wx wy ww wc <<< "$spec"
  cli line --from $wx,$wy --to $((wx+ww)),$wy --color "$wc" --size 1 >/dev/null
done
echo "sea done"
echo

echo "=== 阶段 3: 远山剪影 ==="
cli layer active --id "$MOUNTAINS_ID" >/dev/null
# 用三角形山尖：从山顶到山脚画一个由 rect 填充的三角形（用 rect 大块 + line 锐化轮廓）
# 左山 (峰 200,330)
cli rect --x 100 --y 380 --w 200 --h 50 --fill "#1f1228" >/dev/null
cli line --from 100,380 --to 200,330 --color "#1f1228" --size 12 >/dev/null
cli line --from 200,330 --to 300,380 --color "#1f1228" --size 12 >/dev/null
# 中山 (峰 640,290) — 太阳后面，更高更暗
cli rect --x 480 --y 380 --w 320 --h 90 --fill "#1a0e20" >/dev/null
cli line --from 480,380 --to 640,290 --color "#1a0e20" --size 14 >/dev/null
cli line --from 640,290 --to 800,380 --color "#1a0e20" --size 14 >/dev/null
# 右山 (峰 1140,310)
cli rect --x 1000 --y 380 --w 280 --h 70 --fill "#1f1228" >/dev/null
cli line --from 1000,380 --to 1140,310 --color "#1f1228" --size 12 >/dev/null
cli line --from 1140,310 --to 1280,380 --color "#1f1228" --size 12 >/dev/null
# 小山补
cli rect --x 0 --y 400 --w 200 --h 60 --fill "#2a1838" >/dev/null
cli rect --x 320 --y 400 --w 200 --h 60 --fill "#2a1838" >/dev/null
cli rect --x 820 --y 400 --w 200 --h 60 --fill "#2a1838" >/dev/null
echo "mountains done"
echo

echo "=== 阶段 4: 前景 (棕榈树 + 鸟 + 沙滩 + 小船) ==="
cli layer active --id "$FRONT_ID" >/dev/null
# 沙滩
cli rect --x 0 --y 620 --w 1280 --h 100 --fill "#3a2818" >/dev/null

# 左侧棕榈树
cli line --from 130,640 --to 145,380 --color "#0a0508" --size 12 >/dev/null
for angle_spec in "145,380,80,310" "145,380,210,295" "145,380,40,300" "145,380,260,330" "145,380,100,290" "145,380,200,290" "145,380,50,340" "145,380,250,360"; do
  IFS=',' read -r fx fy tx ty <<< "$angle_spec"
  cli line --from $fx,$fy --to $tx,$ty --color "#0a0508" --size 4 >/dev/null
done
cli circle --cx 138 --cy 385 --r 5 --fill "#0a0508" >/dev/null
cli circle --cx 152 --cy 385 --r 5 --fill "#0a0508" >/dev/null

# 右侧棕榈树（稍远）
cli line --from 1150,650 --to 1160,420 --color "#0a0508" --size 10 >/dev/null
for angle_spec in "1160,420,1230,360" "1160,420,1090,360" "1160,420,1230,400" "1160,420,1090,400" "1160,420,1200,340" "1160,420,1120,340"; do
  IFS=',' read -r fx fy tx ty <<< "$angle_spec"
  cli line --from $fx,$fy --to $tx,$ty --color "#0a0508" --size 3 >/dev/null
done

# 鸟群（M 形）
for bird in "230,180,15" "270,200,12" "350,170,18" "920,150,15" "980,180,12" "1080,165,14"; do
  IFS=',' read -r bx by bs <<< "$bird"
  cli line --from $((bx-bs)),$by --to $bx,$((by-bs/2)) --color "#1a0e20" --size 2 >/dev/null
  cli line --from $bx,$((by-bs/2)) --to $((bx+bs)),$by --color "#1a0e20" --size 2 >/dev/null
done

# 远处的小帆船
cli rect --x 880 --y 595 --w 80 --h 12 --fill "#0a0508" >/dev/null
cli line --from 920,595 --to 920,540 --color "#0a0508" --size 2 >/dev/null
cli line --from 920,545 --to 945,575 --color "#0a0508" --size 1 >/dev/null
cli line --from 920,545 --to 945,545 --color "#0a0508" --size 1 >/dev/null

echo "foreground done"
echo

echo "=== 完成 ==="
cli layer list | jq -r '.layers[] | "\(.id)  \(.name)"'
echo
echo "画布查看: http://127.0.0.1:8080"
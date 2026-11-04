#!/usr/bin/env bash
# rust↔zig 双实例字节对拍（Rust 迁移各轮复用的验收工具）
# 用法: ./verify-parity.sh <zig端口> <rust端口> [outType]
# 对每个字体 × 随机文本：两侧请求落盘 cmp，全部一致则 PASS
set -euo pipefail
cd "$(dirname "$0")/.."

ZIG_PORT=${1:-8090}
RS_PORT=${2:-8094}
OUT_TYPE=${3:-ttf}

FONTS=(
  "鸿蒙黑体.ttf"
  "令东齐伋复刻体.ttf"
  "悠哉字体.ttf"
  "方舟像素字体.ttf"
  "思源黑体.ttf"
)

urlencode() { python3 -c "import urllib.parse,sys; print(urllib.parse.quote(sys.argv[1]))" "$1"; }

rand_text() {
  # 每次生成不同长度的随机文本（千字文常用字池），防 LRU 缓存命中
  python3 - "$1" <<'EOF'
import random, sys
random.seed(sys.argv[1])
pool = ('字体工具测试页面永和九年岁在癸丑暮春之初会于会稽山阴之兰亭修禊事也群贤毕至'
        '少长咸集此地有崇山峻岭茂林修竹又有清流激湍映带左右引以为流觞曲水列坐其次'
        '虽无丝竹管弦之盛一觞一咏亦足以畅叙幽情是日也天朗气清惠风和畅')
n = random.choice([8, 16, 40, 128])
print(''.join(random.choices(pool, k=n)))
EOF
}

pass=0; fail=0
seed=0
for font in "${FONTS[@]}"; do
  for rep in 1 2 3; do
    seed=$((seed+1))
    TXT=$(rand_text "$seed")
    ENC=$(urlencode "$TXT"); FENC=$(urlencode "$font")
    curl -s --noproxy '*' "http://127.0.0.1:${ZIG_PORT}/api?font=${FENC}&text=${ENC}&outType=${OUT_TYPE}" > /tmp/pz.bin
    curl -s --noproxy '*' "http://127.0.0.1:${RS_PORT}/api?font=${FENC}&text=${ENC}&outType=${OUT_TYPE}" > /tmp/pr.bin
    if cmp -s /tmp/pz.bin /tmp/pr.bin; then
      echo "PASS ${font} seed=${seed} $(wc -c < /tmp/pz.bin)B"
      pass=$((pass+1))
    else
      echo "FAIL ${font} seed=${seed} zig=$(wc -c < /tmp/pz.bin)B rust=$(wc -c < /tmp/pr.bin)B"
      fail=$((fail+1))
    fi
  done
done
echo "----"
echo "结果: ${pass} PASS / ${fail} FAIL"
[ "$fail" -eq 0 ]

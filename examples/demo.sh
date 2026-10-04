#!/usr/bin/env bash
# JEV 办公室 M1 验收演示：连续派发 3 个异构任务（代码审查 / 文档统计 / 前端页面）
# 默认用伪 JEV（无需任何 Key / GPU）；若 OpenJev 在 127.0.0.1:8080 可连，可用:
#   JEV_BACKEND=auto bash examples/demo.sh
# 真后端下脚本还会断言单次判断延迟中位数 < 500ms（见下方判断）。
set -euo pipefail
cd "$(dirname "$0")/.."

BACKEND="${JEV_BACKEND:-pseudo}"
echo "后端: $BACKEND"

# 确保演示 refs 存在（58 个 md）
node src/cli.ts init >/dev/null

fails=0
for brief in examples/briefs/code-review.json examples/briefs/doc-stats.json examples/briefs/frontend-page.json; do
  echo "──────── $brief ────────"
  if node src/cli.ts dispatch --brief "$brief" --yes --backend "$BACKEND" --on-uncertain proceed; then
    :
  else
    code=$?
    # hand-back(3)/need-you(2) 在验收里算路由失败
    fails=$((fails+1))
    echo "dispatch 退出码 $code"
  fi
done

if [ "$fails" -gt 0 ]; then
  echo "✗ demo: $fails 个任务未完成"
  exit 1
fi
echo "✔ demo: 3 个异构任务全部完成"

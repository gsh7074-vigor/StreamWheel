#!/usr/bin/env bash
# 视频拉流加速 · 探测入口（薄封装，方便直接调）
#
# 用法：
#   ~/.workbuddy/skills/video-stream-accelerate/scripts/probe.sh "<直链>"
#   ~/.workbuddy/skills/video-stream-accelerate/scripts/probe.sh "<直链>" --levels 1,8,16 --seconds 8
#   ~/.workbuddy/skills/video-stream-accelerate/scripts/probe.sh            # 不带参数 = 内置自测
#
set -uo pipefail

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PY="$(command -v python3)"

# 本机 http_proxy/https_proxy 会劫持请求，测速必须直连
unset http_proxy https_proxy HTTP_PROXY HTTPS_PROXY

if [ "$#" -eq 0 ]; then
  echo "未给 URL，改用内置自测链接（OVH 100MB，支持 Range）"
  echo
  set -- "https://proof.ovh.net/files/100Mb.dat" --levels 1,4,8 --seconds 4
fi

exec "$PY" "$DIR/speed_probe.py" "$@"

#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""分层限速探测 —— 判断视频/文件拉流慢，到底是哪一层在限速。

核心原理
    服务端限速有两种最常见的实现：
      A. 单连接限速（每条 TCP 连接封顶，如 100KB/s）→ 多连接可线性叠加
      B. 账号/会话/链路限速（总量封顶）        → 多连接叠不上去
    所以「1 连接」与「N 连接」的吞吐比值，就是判断能不能靠多线程加速的硬指标。

用法
    python3 speed_probe.py <直链URL>                    # 默认测 1/4/8/16 连接，每档 6 秒
    python3 speed_probe.py <URL> --seconds 8 --chunk 4194304
    python3 speed_probe.py <URL> --levels 1,2,4,8

注意
    · URL 必须是能直接 200/206 的媒体直链（mp4 / m4s / flv / ts 分片）。
    · .m3u8 是播放列表，不是数据流，别拿它测；拿其中一个 .ts 分片测。
    · 带防盗链的站需要把 Cookie / Referer 一起带上，见 --cookie / --referer。
"""

import argparse
import sys
import threading
import time
import urllib.error
import urllib.request

UA = ("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 "
      "(KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36")


def base_headers(args):
    h = {"User-Agent": UA, "Accept": "*/*", "Accept-Encoding": "identity"}
    if args.referer:
        h["Referer"] = args.referer
    if args.cookie:
        h["Cookie"] = args.cookie
    return h


def probe(url, args):
    """确认是否支持 Range 分段，返回 (status, supports_range, total_size)。"""
    h = base_headers(args)
    h["Range"] = "bytes=0-0"
    try:
        req = urllib.request.Request(url, headers=h)
        with urllib.request.urlopen(req, timeout=args.timeout) as r:
            cr = r.headers.get("Content-Range", "")
            total = None
            if "/" in cr:
                try:
                    total = int(cr.rsplit("/", 1)[1])
                except ValueError:
                    pass
            return r.status, r.status == 206, total
    except urllib.error.HTTPError as e:
        return e.code, False, None
    except Exception as e:  # noqa: BLE001
        return None, False, str(e)


class Counter:
    def __init__(self):
        self.bytes = 0
        self.requests = 0
        self.errors = 0
        self.range_ignored = False
        self.lock = threading.Lock()

    def add(self, n):
        with self.lock:
            self.bytes += n
            self.requests += 1

    def fail(self):
        with self.lock:
            self.errors += 1


def worker(url, args, deadline, start_off, counter):
    """持续拉取 [start_off, ...] 的连续分片，直到到点。"""
    pos = start_off
    h = base_headers(args)
    while time.time() < deadline:
        h["Range"] = "bytes=%d-%d" % (pos, pos + args.chunk - 1)
        try:
            req = urllib.request.Request(url, headers=h)
            with urllib.request.urlopen(req, timeout=args.timeout) as r:
                if r.status != 206:
                    with counter.lock:
                        counter.range_ignored = True
                    return
                body = r.read()
        except Exception:  # noqa: BLE001
            counter.fail()
            return
        if not body:
            return
        counter.add(len(body))
        pos += len(body)
        if time.time() >= deadline:
            return


def measure(url, args, conns):
    counter = Counter()
    # 让各连接的起始偏移错开，避免都从 0 开始读同一段缓存
    step = max(1, args.chunk * 8)
    threads = [
        threading.Thread(
            target=worker,
            args=(url, args, time.time() + args.seconds, i * step, counter),
            daemon=True,
        )
        for i in range(conns)
    ]
    t0 = time.time()
    for t in threads:
        t.start()
    for t in threads:
        t.join(timeout=args.seconds + args.timeout + 2)
    elapsed = max(time.time() - t0, 0.001)
    mbps = counter.bytes * 8 / elapsed / 1e6
    return {
        "conns": conns,
        "mbps": mbps,
        "mbs": counter.bytes / elapsed / 1e6,
        "bytes": counter.bytes,
        "reqs": counter.requests,
        "errors": counter.errors,
        "range_ignored": counter.range_ignored,
    }


def fmt_row(r):
    return "| %5d | %9.2f | %9.2f | %8d | %6d |" % (
        r["conns"], r["mbps"], r["mbs"], r["bytes"] / 1e6, r["reqs"])


def main():
    ap = argparse.ArgumentParser(description="分层限速探测：1 连接 vs 多连接 吞吐对比")
    ap.add_argument("url")
    ap.add_argument("--levels", default="1,4,8,16", help="并发档位，默认 1,4,8,16")
    ap.add_argument("--seconds", type=float, default=6.0, help="每档测量时长（秒）")
    ap.add_argument("--chunk", type=int, default=2 * 1024 * 1024, help="每请求分片大小（字节）")
    ap.add_argument("--timeout", type=float, default=20.0, help="单请求超时（秒）")
    ap.add_argument("--referer", default=None)
    ap.add_argument("--cookie", default=None)
    args = ap.parse_args()

    if ".m3u8" in args.url.split("?")[0]:
        print("! 这是播放列表（.m3u8），不是数据流。请改用其中一个分片 URL 测，"
              "或直接用 N_m3u8DL-RE 多分片并发下载。")
        return 2

    levels = [int(x) for x in args.levels.split(",") if x.strip()]

    status, supports_range, total = probe(args.url, args)
    print("目标：%s" % args.url.split("?")[0][:110])
    print("状态：HTTP %s | 支持 Range 分段：%s | 文件大小：%s" % (
        status, "是" if supports_range else "否",
        ("%.1f MB" % (total / 1e6)) if isinstance(total, int) else "未知"))
    print()

    if not supports_range:
        if status == 429:
            print("! 服务端返回 429（限流）。这是刚测过的痕迹，不是链接不支持分段。")
            print("  等 2~3 分钟再测，或换一条分片 URL；公共测速端点普遍有频率限制。")
            return 5
        if status in (401, 403):
            print("! 被拒（HTTP %s）。多半是防盗链，需要带上 --referer 和 --cookie 再测。" % status)
            return 3
        print("! 服务端未返回 206（不支持分段）。多线程无法叠加，"
              "任何多线程工具对这条链接都无效。")
        print("  可行方向：换 CDN 节点 / 走 CDN 回源中转 / 换网络（IPv6、不同出口）。")
        return 3

    print("| 并发 |    Mbps |     MB/s | 拉取 MB | 请求数 |")
    print("|-----:|--------:|---------:|--------:|-------:|")

    results = []
    for c in levels:
        r = measure(args.url, args, c)
        results.append(r)
        print(fmt_row(r))
        if r["range_ignored"]:
            print("  ! 中途服务端忽略了 Range，该档数据不可信")
            break

    single = next((r for r in results if r["conns"] == 1), None)
    best = max(results, key=lambda r: r["mbps"]) if results else None
    if not single or not best or single["mbps"] <= 0.01:
        print("\n测量失败：单连接吞吐接近 0，检查链接是否过期 / 是否要 Cookie。")
        return 4

    ratio = best["mbps"] / single["mbps"]
    print()
    print("加速比：%.2f×（%d 连接 vs 1 连接）" % (ratio, best["conns"]))

    if ratio >= 2.2:
        verdict = ("A 类 → 单连接限速。多线程可线性叠加，这是能靠工具解决的情况。\n"
                   "  建议：aria2（-x16 -s16 -k2M）或 Gopeed / Motrix；流媒体用 N_m3u8DL-RE。")
    elif ratio >= 1.4:
        verdict = ("A/B 之间 → 部分叠加。说明有单连接限速，但同时存在总量或链路瓶颈。\n"
                   "  建议：并发开到 8~16 够用，再往上无收益；瓶颈在带宽本身，先查本地链路/出口。")
    else:
        verdict = ("B 类 → 账号或链路总量限速。多连接叠不上去，多线程工具对这条链接无效。\n"
                   "  建议：别再折腾下载器。方向是换出口（IPv6 / 换 DNS 优选 CDN 节点 / 自建中转），"
                   "或该内容本身属于会员权益，只能走官方途径。")

    print("判定：" + verdict)
    return 0


if __name__ == "__main__":
    sys.exit(main())

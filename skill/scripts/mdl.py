#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""多连接分段下载器 —— 不依赖 aria2，只用标准库，等价于 aria2c -x16 -s16。

为什么自带：aria2 在本机装不上（brew 的 bottle 校验在此环境失败），
而「单连接限速」恰恰只能靠多连接叠加来治，所以这里用 Range 分段自己实现。

原理
    把文件按字节切成 N 段，N 个线程各持一条 TCP 连接并发拉自己那段，
    服务端如果对单连接封顶，总量就会按 N 倍叠加。

用法
    # 8 连接下载
    python3 mdl.py "<url>" -o ~/Downloads/a.mp4 -x 8

    # 带防盗链
    python3 mdl.py "<url>" -o out.mp4 -x 16 --referer "<页面>" --cookie "k=v"

    # 先看看服务端支不支持分段（只探不下载）
    python3 mdl.py "<url>" --probe-only
"""

import argparse
import os
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
    """返回 (status, 是否支持 Range, 总字节数或 None, 文件名或 None)"""
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
                    total = None
            if total is None:
                cl = r.headers.get("Content-Length")
                total = int(cl) if cl and cl.isdigit() else None
            name = None
            cd = r.headers.get("Content-Disposition", "")
            if "filename=" in cd:
                name = cd.split("filename=")[-1].strip().strip('";')
            return r.status, r.status == 206, total, name
    except urllib.error.HTTPError as e:
        return e.code, False, None, None
    except Exception as e:  # noqa: BLE001
        return None, False, str(e), None


class Progress:
    def __init__(self, total):
        self.total = total
        self.lock = threading.Lock()
        self.done = [0]
        self.started = time.time()

    def add(self, n):
        with self.lock:
            self.done[0] += n

    def snapshot(self):
        with self.lock:
            return self.done[0]


def fetch_part(url, args, start, end, path, prog, stop):
    """下载 [start, end] 闭区间到 path，失败重试。"""
    pos = start
    attempt = 0
    while pos <= end and not stop.is_set():
        headers = base_headers(args)
        headers["Range"] = "bytes=%d-%d" % (pos, end)
        try:
            req = urllib.request.Request(url, headers=headers)
            with urllib.request.urlopen(req, timeout=args.timeout) as r:
                if r.status != 206:
                    stop.set()
                    return False
                with open(path, "ab") as f:
                    while not stop.is_set():
                        buf = r.read(256 * 1024)
                        if not buf:
                            break
                        f.write(buf)
                        pos += len(buf)
                        prog.add(len(buf))
            attempt = 0
        except Exception:  # noqa: BLE001
            attempt += 1
            if attempt >= 3:
                return False
            time.sleep(1.0 * attempt)
    return pos > end


def human(n):
    for unit in ("B", "KB", "MB", "GB"):
        if abs(n) < 1024:
            return "%.1f %s" % (n, unit)
        n /= 1024.0
    return "%.1f TB" % n


def single_stream(url, args, out):
    """服务端不支持 Range 时的兜底：单连接直下。"""
    print("→ 服务端不支持分段，退回单连接下载（这就是它的速度上限）")
    h = base_headers(args)
    total = 0
    t0 = time.time()
    last = 0.0
    try:
        req = urllib.request.Request(url, headers=h)
        with urllib.request.urlopen(req, timeout=args.timeout) as r, open(out, "wb") as f:
            while True:
                buf = r.read(256 * 1024)
                if not buf:
                    break
                f.write(buf)
                total += len(buf)
                now = time.time()
                if now - last > 1:
                    last = now
                    el = max(now - t0, 0.001)
                    print("\r  %8s  %6.2f MB/s" % (human(total), total / el / 1e6), end="")
    except Exception as e:  # noqa: BLE001
        print("\n! 下载中断：%s" % e)
        return 1
    el = max(time.time() - t0, 0.001)
    print("\n完成：%s，耗时 %.1fs，均速 %.2f MB/s" % (human(total), el, total / el / 1e6))
    return 0


def main():
    ap = argparse.ArgumentParser(description="多连接分段下载（无 aria2 依赖）")
    ap.add_argument("url")
    ap.add_argument("-o", "--out", required=False, help="保存路径")
    ap.add_argument("-x", "--conns", type=int, default=8, help="并发连接数，默认 8，上限 32")
    ap.add_argument("--timeout", type=float, default=30.0)
    ap.add_argument("--referer", default=None)
    ap.add_argument("--cookie", default=None)
    ap.add_argument("--probe-only", action="store_true", help="只探测是否支持分段，不下载")
    args = ap.parse_args()

    args.conns = max(1, min(32, args.conns))

    status, supports_range, size, name = probe(args.url, args)
    print("探测：HTTP %s | 支持分段：%s | 大小：%s" % (
        status, "是" if supports_range else "否",
        human(size) if isinstance(size, int) else "未知"))

    if args.probe_only:
        return 0

    if status in (401, 403):
        print("! 被拒（HTTP %s），需要 --referer / --cookie" % status)
        return 3
    if status == 429:
        print("! 429 限流，等 2~3 分钟再试")
        return 5

    out = args.out or (name or os.path.basename(args.url.split("?")[0]) or "download.bin")
    out = os.path.expanduser(out)

    if not supports_range or not isinstance(size, int) or size <= 0:
        return single_stream(args.url, args, out)

    if os.path.exists(out):
        print("! 目标已存在，拒绝覆盖：%s" % out)
        return 6

    part_dir = out + ".parts"
    os.makedirs(part_dir, exist_ok=True)

    # 按字节均分
    step = size // args.conns
    ranges = []
    for i in range(args.conns):
        s = i * step
        e = size - 1 if i == args.conns - 1 else (i + 1) * step - 1
        ranges.append((s, e, os.path.join(part_dir, "p%03d" % i)))

    prog = Progress(size)
    stop = threading.Event()

    def run(s, e, p):
        fetch_part(args.url, args, s, e, p, prog, stop)

    threads = [threading.Thread(target=run, args=r, daemon=True) for r in ranges]
    t0 = time.time()
    for t in threads:
        t.start()

    last = 0.0
    while any(t.is_alive() for t in threads):
        time.sleep(0.2)
        now = time.time()
        if now - last > 1:
            last = now
            d = prog.snapshot()
            el = max(now - t0, 0.001)
            pct = d * 100.0 / size
            print("\r  %5.1f%%  %8s / %8s  %6.2f MB/s" % (
                pct, human(d), human(size), d / el / 1e6), end="")

    d = prog.snapshot()
    elapsed = max(time.time() - t0, 0.001)
    print("\r  100.0%%  %8s / %8s  %6.2f MB/s" % (
        human(d), human(size), d / elapsed / 1e6))

    if d < size:
        stop.set()
        print("! 未拉满（%s / %s），分片保留在 %s，可重跑续传" % (human(d), human(size), part_dir))
        return 4

    # 合并
    print("→ 合并分片…")
    with open(out, "wb") as w:
        for _, _, p in ranges:
            with open(p, "rb") as r:
                while True:
                    buf = r.read(1024 * 1024)
                    if not buf:
                        break
                    w.write(buf)
            os.remove(p)
    os.rmdir(part_dir)

    got = os.path.getsize(out)
    if got != size:
        print("! 大小校验失败：期望 %d，实际 %d" % (size, got))
        return 4

    print("完成：%s（%s），耗时 %.1fs" % (out, human(got), elapsed))
    return 0


if __name__ == "__main__":
    sys.exit(main())

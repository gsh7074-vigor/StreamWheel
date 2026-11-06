/* 视频拉流加速 · content script
 *
 * 机制（唯一在浏览器侧有真实效果的一种）：
 *   播放器通常一条连接顺序取分片，单连接被封顶时它就只能那个速度。
 *   本脚本把「接下来几段」用多条连接并发拉进浏览器 HTTP 缓存，
 *   播放器随后请求同一批 URL 时命中缓存，等效于用多连接抢带宽。
 *
 * 明确做不到：加宽带、破账号级限速、绕过服务端对单 IP 的总量限制。
 * CDN 若对分片返回 Cache-Control: no-store，预取不产生缓存命中，等于无效——
 * 这种情况下 HUD 会显示「预取无效」，不会装作有效。
 */
(function () {
  'use strict';
  if (window.__SB_LOADED__) return;
  window.__SB_LOADED__ = true;

  var SB = window.SB;
  var host = location.hostname || 'local';
  var SITE_KEY = 'site:' + host;
  var isTop = window === window.top;

  var cfg = {
    enabled: true, depth: 4, conc: 3, hud: true,
    whole: false,          // 「存着慢慢看」：后台缓存整片
    instant: false,        // 「立刻享受」：拖动进度条时优先缓冲目标位置
    maxMB: 150             // 全片预取流量上限，防止一部长片吃爆带宽
  };
  var stats = {
    prefetched: 0, bytes: 0, failed: 0,
    cache: null,            // 服务端声明的缓存策略判定
    lastSegmentUrl: null,   // 供 A/B 计时
    totalSegs: 0,           // 播放列表总分片数
    hitProbe: null,         // 自动命中验证结果
    wholeLimited: false     // 是否因流量上限被截断
  };
  var running = false;
  var tickTimer = null;
  var hud = null;
  var hudTimer = null;
  var mediaPlaylistUrl = null;
  var lastSegments = null;   // 最近一次解析出的分片表，供 seek 时定位
  var boundVideo = null;
  var seen = Object.create(null);
  var seenCount = 0;
  var queue = [];
  var inflight = 0;
  var note = '';
  var playing = false;
  var diag = null;

  /* ---------------- 目标探测 ---------------- */

  /* 选「正在播的那个 video」。
   * 只按面积挑会选到预加载器/占位器/广告位，页面上常同时存在好几个 video，
   * 而真正在播的未必最大。所以优先级是：在播 > 有元数据 > 面积大。 */
  function pickVideo() {
    var list = document.querySelectorAll('video');
    var best = null;
    var bestScore = -1;
    for (var i = 0; i < list.length; i++) {
      var v = list[i];
      var playing = (!v.paused && !v.ended) ? 1 : 0;
      var ready = (v.readyState >= 2) ? 1 : 0;
      var area = (v.offsetWidth || 0) * (v.offsetHeight || 0);
      var score = playing * 1e9 + ready * 1e7 + area;
      if (score > bestScore) { bestScore = score; best = v; }
    }
    return best;
  }

  /* 候选播放列表：可能同时存在多个（变体、预加载、广告轨），按新到旧排 */
  function playlistCandidates() {
    if (mediaPlaylistUrl) return [mediaPlaylistUrl];

    var out = [];
    var v = pickVideo();
    var src = v && (v.currentSrc || v.src || '');
    if (src && SB.isPlaylistUrl(src) && src.indexOf('blob:') !== 0) out.push(src);

    var entries = performance.getEntriesByType ? performance.getEntriesByType('resource') : [];
    for (var i = entries.length - 1; i >= 0 && out.length < 8; i--) {
      var n = entries[i].name || '';
      if (!n || n.indexOf('blob:') === 0) continue;
      if (SB.isPlaylistUrl(n) && out.indexOf(n) < 0) out.push(n);
    }
    return out;
  }

  /* 取播放列表文本。三级兜底，专门治「Failed to fetch」：
   *   1) credentials:'omit' —— 跨域 CDN 返回 Access-Control-Allow-Origin: * 时，
   *      带凭据请求会被浏览器直接拒掉，这是最常见的 Failed to fetch 成因
   *   2) credentials:'include' —— 站点要求带 Cookie 鉴权时用
   *   3) 交给 background service worker 代取 —— SW 有 host_permissions，不受页面 CORS 限制
   * 注意：SW 代取只用于「解析列表」，不用于预取分片，见 pump() 的说明。 */
  function tryFetchText(url, credentials) {
    return fetch(url, { credentials: credentials, cache: 'no-store' }).then(function (r) {
      return r.text().then(function (t) {
        return { ok: r.ok, status: r.status, text: t, via: credentials };
      });
    });
  }

  function proxyFetchText(url) {
    return new Promise(function (resolve, reject) {
      try {
        chrome.runtime.sendMessage({ type: 'fetchText', url: url }, function (r) {
          if (chrome.runtime.lastError) {
            reject(new Error(chrome.runtime.lastError.message));
            return;
          }
          if (!r || !r.text) {
            reject(new Error((r && r.error) || '后台代取无内容'));
            return;
          }
          resolve({ ok: r.ok, status: r.status, text: r.text, via: 'service-worker' });
        });
      } catch (e) {
        reject(e);
      }
    });
  }

  function fetchText(url) {
    return tryFetchText(url, 'omit')
      .catch(function () { return tryFetchText(url, 'include'); })
      .catch(function () { return proxyFetchText(url); })
      .catch(function (e) {
        return {
          ok: false,
          status: 0,
          text: null,
          error: String((e && e.message) || e)
        };
      });
  }

  /* 解析一个候选地址；m3u8 与 mpd 都试。失败时把诊断写进 diag。 */
  function parseOne(url) {
    return fetchText(url).then(function (r) {
      if (!r.text) {
        diag = {
          url: url,
          status: r.status,
          why: '列表请求被浏览器拒绝（跨域或凭据冲突）',
          raw: r.error || '空响应',
          via: r.via || null
        };
        return null;
      }
      if (!r.ok) {
        diag = { url: url, status: r.status, why: 'HTTP ' + r.status + '（可能需要鉴权）' };
        return null;
      }

      var text = r.text;
      var head = text.slice(0, 240);
      var p = null;

      if (text.indexOf('<MPD') >= 0 || /\.mpd(\?|#|$)/i.test(url)) {
        p = SB.parseMpd(text, url);
        if (!p) {
          diag = { url: url, status: r.status, why: 'MPD 解析失败', snippet: head };
          return null;
        }
      }
      if (!p) {
        p = SB.parseM3u8(text, url);
        if (!p) {
          diag = {
            url: url,
            status: r.status,
            why: '内容不是 m3u8/mpd（可能是接口、加密列表或 HTML 错误页）',
            snippet: head
          };
          return null;
        }
      }

      if (p.kind === 'media') return { url: url, segments: p.segments };

      if (p.kind === 'master' && p.variants.length) {
        var child = p.variants[p.variants.length - 1];
        return fetchText(child).then(function (r2) {
          var p2 = r2.text ? SB.parseM3u8(r2.text, child) : null;
          if (!p2 || p2.kind !== 'media') {
            diag = {
              url: child,
              status: r2.status,
              why: '变体列表解析失败',
              snippet: r2.text ? r2.text.slice(0, 240) : null
            };
            return null;
          }
          return { url: child, segments: p2.segments };
        });
      }
      return null;
    });
  }

  /* 依次试候选，直到有一个能解析出分片 */
  function resolveMediaPlaylist(candidates) {
    var i = 0;
    function next() {
      if (i >= candidates.length) return Promise.resolve(null);
      var url = candidates[i++];
      return parseOne(url).then(function (res) {
        if (res) return res;
        return next();
      });
    }
    return next();
  }

  /* ---------------- 并发预取 ---------------- */

  /* 分片预取只走页面侧的 fetch：这样字节才会进「页面」的 HTTP 缓存分区，
   * 播放器随后请求同一 URL 才可能命中。交给 SW 代取虽然能绕过 CORS，
   * 但 SW 与页面缓存分区不共享，等于白拉流量，所以不那样做。 */
  /* ---------------- 缓存策略判定（不用 F12） ----------------
   * Cache-Control / Expires / Pragma 都是 CORS 安全响应头，跨域 fetch 也能读到，
   * 不依赖 Timing-Allow-Origin。判定的是「服务端是否允许缓存」，
   * 这决定预取有没有意义；真正的命中再用 A/B 计时交叉验证。 */
  var LEVEL_RANK = { none: 0, weak: 1, unknown: 2, good: 3 };

  function cacheVerdict(headers) {
    var cc = (headers.get('cache-control') || '').toLowerCase();
    var pragma = (headers.get('pragma') || '').toLowerCase();
    var expires = headers.get('expires') || '';

    if (cc.indexOf('no-store') >= 0) {
      return { ok: false, level: 'none', label: 'no-store',
               desc: '服务端禁止缓存，预取不会命中，建议关闭扩展' };
    }
    var m = /max-age\s*=\s*(\d+)/.exec(cc);
    if (m) {
      return parseInt(m[1], 10) > 0
        ? { ok: true, level: 'good', label: 'max-age=' + m[1], desc: '允许缓存，播放器可命中预取结果' }
        : { ok: false, level: 'weak', label: 'max-age=0', desc: '需回源校验，提速有限' };
    }
    if (cc.indexOf('no-cache') >= 0) {
      return { ok: false, level: 'weak', label: 'no-cache', desc: '需回源校验，提速有限' };
    }
    if (expires) {
      return { ok: true, level: 'good', label: 'Expires', desc: '声明了过期时间，通常可缓存' };
    }
    if (pragma.indexOf('no-cache') >= 0) {
      return { ok: false, level: 'weak', label: 'Pragma no-cache', desc: '旧式禁缓存头，可能不命中' };
    }
    return { ok: true, level: 'unknown', label: '未声明',
             desc: '未声明缓存策略，浏览器多会启发式缓存；建议点「实测命中」确认' };
  }

  function fetchSegment(url) {
    return fetch(url, { credentials: 'omit', cache: 'default' })
      .catch(function () {
        return fetch(url, { credentials: 'include', cache: 'default' });
      })
      .then(function (r) {
        if (!r.ok) throw new Error('HTTP ' + r.status);

        // 保留最差的一档结论，避免个别分片头好而整体误判
        var v = cacheVerdict(r.headers);
        if (!stats.cache || LEVEL_RANK[v.level] < LEVEL_RANK[stats.cache.level]) {
          stats.cache = v;
        }
        stats.lastSegmentUrl = url;
        return r.arrayBuffer();
      });
  }

  /* A/B 计时：强制回源一次，再按默认缓存策略取一次。
   * 第二次显著更快 = 缓存命中 = 预取有效。不依赖任何响应头权限。 */
  function timedFetch(url, cacheMode) {
    var t0 = performance.now();
    return fetch(url, { credentials: 'omit', cache: cacheMode })
      .then(function (r) { return r.arrayBuffer(); })
      .then(function () { return performance.now() - t0; });
  }

  function probeCache(url) {
    return timedFetch(url, 'reload').then(function (cold) {
      return timedFetch(url, 'default').then(function (warm) {
        var ratio = warm / Math.max(cold, 1);
        return {
          ok: true,
          cold: Math.round(cold),
          warm: Math.round(warm),
          ratio: Math.round(ratio * 100) / 100,
          hit: ratio < 0.5
        };
      });
    });
  }

  function pump() {
    while (inflight < cfg.conc && queue.length && running) {
      var u = queue.shift();
      inflight++;
      fetchSegment(u)
        .then(function (b) {
          stats.prefetched++;
          stats.bytes += b.byteLength;
        })
        .catch(function () { stats.failed++; })
        .then(function () {
          inflight--;
          paint();
          pump();
        });
    }
  }

  /* 只入队、立即触发 pump 与否由调用方决定 */
  function markQueue(url, front) {
    if (!url || seen[url]) return false;
    seen[url] = 1;
    seenCount++;
    if (seenCount > 400) { seen = Object.create(null); seenCount = 0; seen[url] = 1; }
    if (front) queue.unshift(url); else queue.push(url);
    if (queue.length > 400) queue.splice(0, queue.length - 400);
    return true;
  }

  function enqueue(url, front) {
    if (markQueue(url, front)) pump();
  }

  /* 把指定 URL 提到队列最前面（含已在队列中的），其余保持原顺序。
   * 关键：全片预取已把所有段标进 seen，光靠 enqueue 会把目标段跳过，
   * 所以必须能重排「已入队但还没下载」的项，否则「立刻享受」是假的。 */
  function prioritize(urls) {
    var wanted = Object.create(null);
    urls.forEach(function (u) { wanted[u] = 1; });

    var picked = [];
    var rest = [];
    for (var i = 0; i < queue.length; i++) {
      (wanted[queue[i]] ? picked : rest).push(queue[i]);
    }

    var ordered = [];
    urls.forEach(function (u) { if (picked.indexOf(u) >= 0) ordered.push(u); });
    picked.forEach(function (u) { if (ordered.indexOf(u) < 0) ordered.push(u); });

    queue = ordered.concat(rest);
    pump();
  }

  /* 全片预取：目标是「拖到任意位置都能直接播」。
   * 顺序：先当前往后若干段（保证连续播放），再从头补齐其余段（保证任意 seek）。
   * 用平均段大小估算总流量，超过 cfg.maxMB 就截断并如实标记。 */
  function queueWhole(segments, idx) {
    var avg = stats.prefetched > 0 ? (stats.bytes / stats.prefetched) : 0;
    var maxSegs = segments.length;
    if (avg > 0) {
      maxSegs = Math.min(maxSegs, Math.max(1, Math.floor(cfg.maxMB * 1e6 / avg)));
    }
    stats.wholeLimited = maxSegs < segments.length;

    var order = [];
    var i;
    for (i = idx + 1; i <= Math.min(segments.length - 1, idx + cfg.depth); i++) order.push(i);
    for (i = 0; i < segments.length; i++) order.push(i);

    var added = 0;
    for (var k = 0; k < order.length; k++) {
      if (seenCount >= maxSegs) break;
      var seg = segments[order[k]];
      if (!seg || seen[seg.url]) continue;
      enqueue(seg.url);
      added++;
    }
    return added;
  }

  /* 「立刻享受」：点/拖进度条到任意位置，把目标附近的分片提到队首优先缓冲 */
  function bindSeek(v) {
    if (boundVideo === v) return;
    boundVideo = v;
    v.addEventListener('seeking', function () {
      if (!running || !cfg.enabled || !cfg.instant) return;
      if (!lastSegments || !lastSegments.length) return;

      var target = SB.indexAt(lastSegments, v.currentTime);
      if (target < 0) return;
      var end = Math.min(lastSegments.length - 1, target + cfg.depth);

      var targets = [];
      for (var i = target; i <= end; i++) {
        var seg = lastSegments[i];
        if (!seg) continue;
        targets.push(seg.url);
        markQueue(seg.url);                 // 只标记入队，暂不 pump
      }
      prioritize(targets);                 // 重排后一次性触发
      note = '立刻享受 · 已优先缓冲目标位置';
      paint();
    });
  }

  /* 开全片预取前先做一次命中验证：不命中就别下载整片，避免白耗几百 MB */
  function ensureHitProbe() {
    if (!cfg.whole || stats.hitProbe || !stats.lastSegmentUrl) return;
    stats.hitProbe = { pending: true };
    probeCache(stats.lastSegmentUrl)
      .then(function (r) { stats.hitProbe = r; paint(); })
      .catch(function (e) { stats.hitProbe = { ok: false, error: String(e && e.message || e) }; });
  }

  /* ---------------- 主循环 ---------------- */

  function tick() {
    if (!running) return;

    var v = pickVideo();
    if (!v) { playing = false; note = '已注入 · 无 video 元素'; paint(); return; }
    playing = !v.paused && !v.ended;
    if (!playing) {
      // 视频未播放时给一个动作指令，而不是含糊的"待触发"
      note = v.ended ? '已注入 · 播放已结束' : '已注入 · 点播放后开始';
      paint();
      return;
    }
    if (document.hidden) return;

    var cands = playlistCandidates();
    if (!cands.length) { note = '已在播 · 未发现分片流'; diag = null; paint(); return; }

    resolveMediaPlaylist(cands).then(function (res) {
      if (!res || !res.segments || !res.segments.length) {
        note = '已在播 · ' + shortWhy(diag);
        paint();
        return;
      }
      mediaPlaylistUrl = res.url;
      lastSegments = res.segments;
      stats.totalSegs = res.segments.length;
      bindSeek(v);
      diag = null;

      var idx = SB.indexAt(res.segments, v.currentTime);
      if (idx < 0) { note = '定位当前分片失败'; paint(); return; }

      var probe = stats.hitProbe;
      var settled = probe && !probe.pending;
      var probeOk = settled && probe.ok === true && probe.hit === true;
      var probeBad = settled && probe.ok === true && probe.hit === false;

      if (cfg.whole && !probeBad) {
        ensureHitProbe();                       // 触发一次验证（异步，需等下一轮）
        if (probeOk) {
          queueWhole(res.segments, idx);        // 验证通过才下载整片
          note = stats.wholeLimited
            ? '存着慢慢看 · 已达流量上限'
            : '存着慢慢看 · 整片缓存中';
        } else {
          queueAhead(res.segments, idx);        // 验证未出结果：只做常规预取
          note = (probe && probe.pending)
            ? '验证缓存命中中 · 暂不下载整片'
            : '准备验证命中 · 先常规预取';
        }
      } else {
        var added = queueAhead(res.segments, idx);
        note = (cfg.whole && probeBad)
          ? '实测未命中 · 已跳过「存着慢慢看」'
          : (added ? '正常预取'
             : (idx >= res.segments.length - 1 ? '已到末尾' : '后续分片已在队列或已缓存'));
      }
      paint();
      report();
    });
  }

  function queueAhead(segments, idx) {
    var end = Math.min(segments.length - 1, idx + cfg.depth);
    var added = 0;
    for (var i = idx + 1; i <= end; i++) {
      var seg = segments[i];
      if (!seg || seen[seg.url]) continue;
      enqueue(seg.url);
      added++;
    }
    return added;
  }

  /* ---------------- HUD ---------------- */

  function fmtBytes(n) {
    if (n < 1024) return n + ' B';
    if (n < 1048576) return (n / 1024).toFixed(0) + ' KB';
    return (n / 1048576).toFixed(1) + ' MB';
  }

  function shortWhy(d) {
    if (!d) return '没有可用分片';
    var w = d.why || '';
    if (d.status === 401 || d.status === 403) return '列表被拒 ' + d.status;
    if (d.status === 429) return '列表被限流 429';
    if (w.indexOf('请求被浏览器拒绝') >= 0) return '列表请求被拒';
    if (/Failed to fetch|NetworkError|TypeError|load failed/i.test(d.raw || w)) return '列表请求被拒';
    if (w.indexOf('MPD') >= 0) return 'MPD 解析失败';
    if (w.indexOf('变体') >= 0) return '变体列表解析失败';
    if (w.indexOf('不是 m3u8') >= 0) return '返回的不是播放列表';
    return w.slice(0, 12) || '未知原因';
  }

  function cacheTag() {
    if (!stats.cache) return '';
    if (stats.cache.level === 'none') return ' · 禁缓存';
    if (stats.cache.level === 'weak') return ' · 缓存弱';
    if (stats.cache.level === 'good') return ' · 可缓存';
    return ' · 缓存未声明';
  }

  function hudText() {
    if (stats.failed > 0 && stats.prefetched === 0) return '预取失败 · 跨域被拦';
    if (!playing) {
      return stats.prefetched > 0
        ? '已暂停 · 预取 ' + stats.prefetched + ' 段' + cacheTag()
        : (note || '已注入 · 待播放');
    }
    if (stats.prefetched > 0) {
      var missed = stats.hitProbe && stats.hitProbe.ok === true && stats.hitProbe.hit === false;
      var head = (cfg.whole && stats.totalSegs)
        ? '全片 ' + Math.min(stats.prefetched, stats.totalSegs) + '/' + stats.totalSegs +
          ' 段 · ' + fmtBytes(stats.bytes)
        : '预取 ' + stats.prefetched + ' 段 · ' + fmtBytes(stats.bytes);
      return head + (missed ? ' · 未命中' : cacheTag());
    }
    return note || '已注入 · 正在识别';
  }

  function paint() {
    if (!isTop) return;
    if (!cfg.enabled || !cfg.hud) { removeHud(); return; }
    if (!hud) {
      hud = document.createElement('div');
      hud.id = '__sb_hud__';
      hud.style.cssText = [
        'position:fixed', 'left:14px', 'bottom:14px', 'z-index:2147483647',
        'padding:4px 9px', 'border-radius:7px',
        'background:rgba(17,17,17,.66)', 'color:#fff',
        'font:600 12px/1.3 -apple-system,BlinkMacSystemFont,"PingFang SC",sans-serif',
        'letter-spacing:.2px', 'pointer-events:none', 'user-select:none',
        'opacity:.75', 'transition:opacity .2s ease'
      ].join(';');
    }
    if (!hud.isConnected) {
      (document.body || document.documentElement).appendChild(hud);
    }
    hud.textContent = hudText();
    hud.title = '视频拉流加速：替播放器并发预取后续分片\n状态：' + (note || '—');
    hud.style.opacity = '0.75';
    clearTimeout(hudTimer);
    hudTimer = setTimeout(function () { if (hud) hud.style.opacity = '0'; }, 4000);
  }

  function removeHud() {
    clearTimeout(hudTimer);
    if (hud) { hud.remove(); hud = null; }
  }

  /* ---------------- 上报 ---------------- */

  var reportTimer = null;
  function report() {
    if (!isTop) return;   // 只让顶层 frame 决定角标，避免 iframe 抢着上报
    clearTimeout(reportTimer);
    reportTimer = setTimeout(function () {
      try {
        chrome.runtime.sendMessage({
          type: 'state',
          active: running && stats.prefetched > 0,
          count: stats.prefetched
        });
      } catch (e) {}
    }, 200);
  }

  /* ---------------- 启停 ---------------- */

  function start() {
    if (running) return;
    running = true;
    note = '等待播放';
    tick();
    tickTimer = setInterval(tick, 2500);
    paint();
  }

  function stop() {
    running = false;
    clearInterval(tickTimer);
    tickTimer = null;
    queue.length = 0;
    removeHud();
    mediaPlaylistUrl = null;
    note = '';
    report();
  }

  /* ---------------- 与 popup 联动 ---------------- */

  chrome.runtime.onMessage.addListener(function (msg, sender, sendResponse) {
    if (!msg) return;
    if (msg.type === 'stats') {
      sendResponse({
        host: host,
        enabled: cfg.enabled,
        depth: cfg.depth,
        conc: cfg.conc,
        hud: cfg.hud,
        whole: cfg.whole,
        instant: cfg.instant,
        maxMB: cfg.maxMB,
        prefetched: stats.prefetched,
        bytes: stats.bytes,
        failed: stats.failed,
        note: note,
        diag: diag,
        cache: stats.cache,
        totalSegs: stats.totalSegs,
        hitProbe: stats.hitProbe,
        wholeLimited: stats.wholeLimited
      });
      return true;
    }
    if (msg.type === 'probeCache') {
      if (!stats.lastSegmentUrl) {
        sendResponse({ ok: false, error: '还没有预取过分片，先播放一会儿' });
        return true;
      }
      probeCache(stats.lastSegmentUrl)
        .then(function (r) { sendResponse(r); })
        .catch(function (e) {
          sendResponse({ ok: false, error: String((e && e.message) || e) });
        });
      return true;   // 异步响应
    }
    if (msg.type === 'reset') {
      stats = {
        prefetched: 0, bytes: 0, failed: 0,
        cache: null, lastSegmentUrl: null,
        totalSegs: 0, hitProbe: null, wholeLimited: false
      };
      seen = Object.create(null);
      seenCount = 0;
      mediaPlaylistUrl = null;
      lastSegments = null;
      paint();
      sendResponse({ ok: true });
      return true;
    }
    return false;
  });

  chrome.storage.onChanged.addListener(function (changes, area) {
    if (area !== 'local') return;

    var dirty = false;
    if (changes.enabled) { cfg.enabled = changes.enabled.newValue !== false; dirty = true; }
    if (changes.depth) { cfg.depth = clamp(Number(changes.depth.newValue), 1, 12, 4); dirty = true; }
    if (changes.conc) { cfg.conc = clamp(Number(changes.conc.newValue), 1, 6, 3); dirty = true; }
    if (changes.hud) { cfg.hud = changes.hud.newValue !== false; dirty = true; }
    if (changes.whole) {
      cfg.whole = changes.whole.newValue === true;
      if (!cfg.whole) stats.hitProbe = null;   // 关掉再开时重新验证
      dirty = true;
    }
    if (changes.instant) { cfg.instant = changes.instant.newValue === true; dirty = true; }
    if (changes.maxMB) { cfg.maxMB = clamp(Number(changes.maxMB.newValue), 20, 1000, 150); dirty = true; }
    if (changes[SITE_KEY]) { cfg.enabled = changes[SITE_KEY].newValue !== false; dirty = true; }

    // 互斥兜底：任何路径导致双开时保留「存着慢慢看」，并回写让弹窗显示一致
    if (cfg.whole && cfg.instant) {
      cfg.instant = false;
      try { chrome.storage.local.set({ instant: false }); } catch (e) {}
      dirty = true;
    }

    if (dirty) {
      if (cfg.enabled) { if (!running) start(); paint(); } else { stop(); }
    }
  });

  function clamp(v, lo, hi, dflt) {
    if (!isFinite(v)) return dflt;
    return Math.min(hi, Math.max(lo, v));
  }

  /* ---------------- 初始化 ---------------- */

  var defaults = {
    enabled: true, depth: 4, conc: 3, hud: true,
    whole: false, instant: false, maxMB: 150
  };
  defaults[SITE_KEY] = true;

  try {
    chrome.storage.local.get(defaults, function (s) {
      cfg.enabled = s.enabled !== false && s[SITE_KEY] !== false;
      cfg.depth = clamp(Number(s.depth), 1, 12, 4);
      cfg.conc = clamp(Number(s.conc), 1, 6, 3);
      cfg.hud = s.hud !== false;
      cfg.whole = s.whole === true;
      cfg.instant = !cfg.whole && s.instant === true;
      // 旧版本残留的双开配置：归一成「存着慢慢看」，并回写
      if (s.whole === true && s.instant === true) {
        try { chrome.storage.local.set({ instant: false }); } catch (e) {}
      }
      cfg.maxMB = clamp(Number(s.maxMB), 20, 1000, 150);
      if (cfg.enabled) start();
    });
  } catch (e) {}
})();

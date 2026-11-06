/* 视频拉流加速 · 纯逻辑层（无 chrome API 依赖，可在 Node 里单测） */
(function (root) {
  'use strict';

  /* 解析 m3u8。返回
   *   { kind: 'master', variants: [url] }
   *   { kind: 'media',  segments: [{url, start, dur}], targetDuration }
   *   null（无法解析）
   */
  function parseM3u8(text, baseUrl) {
    if (!text || text.indexOf('#EXTM3U') < 0) return null;

    var lines = text.split(/\r?\n/);
    var segs = [];
    var variants = [];
    var pendingDur = null;
    var t = 0;
    var targetDuration = 4;

    for (var i = 0; i < lines.length; i++) {
      var s = lines[i].trim();
      if (!s) continue;

      if (s.indexOf('#EXT-X-TARGETDURATION:') === 0) {
        var td = parseFloat(s.slice(22));
        if (!isNaN(td) && td > 0) targetDuration = td;
        continue;
      }

      if (s.indexOf('#EXTINF:') === 0) {
        var d = parseFloat(s.slice(8));
        pendingDur = isNaN(d) ? null : d;
        continue;
      }

      if (s.charAt(0) === '#') continue;

      // 非注释行 = URI
      var abs;
      try { abs = new URL(s, baseUrl).href; } catch (e) { continue; }

      if (pendingDur === null) {
        variants.push(abs);          // master playlist 的变体流
      } else {
        segs.push({ url: abs, start: t, dur: pendingDur });
        t += pendingDur;
        pendingDur = null;
      }
    }

    if (segs.length) return { kind: 'media', segments: segs, targetDuration: targetDuration };
    if (variants.length) return { kind: 'master', variants: variants };
    return null;
  }

  /* 当前播放时间落在第几个分片；找不到返回 -1 */
  function indexAt(segments, time) {
    if (!segments || !segments.length) return -1;
    if (!isFinite(time)) return segments.length - 1;
    for (var i = segments.length - 1; i >= 0; i--) {
      if (time >= segments[i].start - 0.001) return i;
    }
    return 0;
  }

  function isPlaylistUrl(u) {
    return /\.(m3u8|mpd)(\?|#|$)/i.test(u);
  }

  /* ---------- DASH (MPD) ----------
   * 只覆盖主流形态：SegmentTemplate（@duration 或 SegmentTimeline）、SegmentList。
   * 返回与 m3u8 同构的 {url, start, dur} 列表，供上层统一处理。 */
  function parseMpd(xmlText, baseUrl) {
    if (!xmlText || xmlText.indexOf('<MPD') < 0) return null;

    var doc;
    try {
      doc = new DOMParser().parseFromString(xmlText, 'application/xml');
    } catch (e) {
      return null;
    }
    if (!doc || doc.querySelector('parsererror')) return null;

    var mpd = doc.documentElement;
    if (!mpd || mpd.nodeName.toLowerCase() !== 'mpd') return null;

    function txt(el, name) {
      if (!el) return null;
      var c = el.getElementsByTagName(name);
      return c && c.length ? c[0].textContent.trim() : null;
    }

    function joinBase(base, ref) {
      if (!ref) return base;
      try { return new URL(ref, base).href; } catch (e) { return base; }
    }

    var mpdBase = joinBase(baseUrl, txt(mpd, 'BaseURL'));

    var period = mpd.getElementsByTagName('Period')[0];
    var periodBase = joinBase(mpdBase, period ? txt(period, 'BaseURL') : null);

    // 周期时长
    var periodDur = 0;
    if (period && period.getAttribute('duration')) {
      periodDur = parseDuration(period.getAttribute('duration'));
    }
    if (!periodDur && mpd.getAttribute('mediaPresentationDuration')) {
      periodDur = parseDuration(mpd.getAttribute('mediaPresentationDuration'));
    }

    // 找视频轨（没有 mimeType 就取第一个带模板的）
    var reps = mpd.getElementsByTagName('Representation');
    var target = null;
    for (var i = 0; i < reps.length; i++) {
      var r = reps[i];
      var as = r.parentNode;
      var mime = (as && as.getAttribute) ? (as.getAttribute('mimeType') || '') : '';
      var hasTpl = r.getElementsByTagName('SegmentTemplate').length ||
                   (as && as.getElementsByTagName && as.getElementsByTagName('SegmentTemplate').length);
      if (!hasTpl) continue;
      if (!target || mime.indexOf('video') >= 0) { target = r; if (mime.indexOf('video') >= 0) break; }
    }
    if (!target) return null;

    var asEl = target.parentNode;
    var tpl = target.getElementsByTagName('SegmentTemplate')[0] ||
              (asEl && asEl.getElementsByTagName('SegmentTemplate')[0]) ||
              (period && period.getElementsByTagName('SegmentTemplate')[0]);

    var repBase = joinBase(periodBase, txt(target, 'BaseURL'));

    function pad(n, w) {
      var s = String(n);
      while (s.length < w) s = '0' + s;
      return s;
    }

    function subst(str, num, time) {
      if (!str) return null;
      return str
        .replace(/\$RepresentationID\$/g, target.getAttribute('id') || '')
        .replace(/\$Bandwidth\$/g, target.getAttribute('bandwidth') || '')
        .replace(/\$Time(%0(\d+)d)?\$/g, function (m, all, w) {
          return w ? pad(time, parseInt(w, 10)) : String(time);
        })
        .replace(/\$Number(%0(\d+)d)?\$/g, function (m, all, w) {
          return w ? pad(num, parseInt(w, 10)) : String(num);
        });
    }

    // SegmentList 形态
    var list = target.getElementsByTagName('SegmentURL');
    if (list.length) {
      var out = [];
      var t = 0;
      var dflt = tpl ? parseFloat(tpl.getAttribute('duration') || '0') / parseFloat(tpl.getAttribute('timescale') || '1') : 0;
      var tlist = tpl && tpl.getElementsByTagName('SegmentTimeline')[0];
      var durs = [];
      if (tlist) {
        var ss = tlist.getElementsByTagName('S');
        for (var k = 0; k < ss.length; k++) {
          var d = parseFloat(ss[k].getAttribute('d') || '0') / parseFloat(tpl.getAttribute('timescale') || '1');
          var rep = parseInt(ss[k].getAttribute('r') || '0', 10);
          for (var j = 0; j <= rep; j++) durs.push(d);
        }
      }
      for (var n = 0; n < list.length; n++) {
        var m = list[n].getAttribute('media');
        if (!m) continue;
        var dur = durs[n] || dflt || 4;
        out.push({ url: joinBase(repBase, m), start: t, dur: dur });
        t += dur;
      }
      return out.length ? { kind: 'media', segments: out } : null;
    }

    if (!tpl) return null;

    var timescale = parseFloat(tpl.getAttribute('timescale') || '1') || 1;
    var media = tpl.getAttribute('media');
    if (!media) return null;

    var segDur = parseFloat(tpl.getAttribute('duration') || '0') / timescale;
    var startNumber = parseInt(tpl.getAttribute('startNumber') || '1', 10) || 1;
    var timeline = tpl.getElementsByTagName('SegmentTimeline')[0];

    var segments = [];

    if (timeline) {
      var S = timeline.getElementsByTagName('S');
      var time = 0;
      var num = startNumber;
      for (var a = 0; a < S.length; a++) {
        var td = parseFloat(S[a].getAttribute('d') || '0') / timescale;
        var tr = parseInt(S[a].getAttribute('r') || '0', 10);
        if (S[a].getAttribute('t')) time = parseFloat(S[a].getAttribute('t')) / timescale;
        for (var b = 0; b <= tr; b++) {
          var u = subst(media, num, Math.round(time * timescale));
          if (!u) break;
          segments.push({ url: joinBase(repBase, u), start: time, dur: td });
          time += td;
          num++;
        }
      }
    } else {
      if (!segDur) return null;
      var total = periodDur || 0;
      if (!total) return null;
      var count = Math.ceil(total / segDur);
      for (var c = 0; c < count; c++) {
        var u2 = subst(media, startNumber + c, 0);
        if (!u2) break;
        segments.push({ url: joinBase(repBase, u2), start: c * segDur, dur: segDur });
      }
    }

    return segments.length ? { kind: 'media', segments: segments } : null;
  }

  /* ISO 8601 时长 PT1H2M3.5S -> 秒 */
  function parseDuration(s) {
    if (!s) return 0;
    var m = /P(?:(\d+)D)?T?(?:(\d+)H)?(?:(\d+)M)?(?:([\d.]+)S)?/.exec(s);
    if (!m) return 0;
    return (parseInt(m[1] || '0', 10) * 86400) +
           (parseInt(m[2] || '0', 10) * 3600) +
           (parseInt(m[3] || '0', 10) * 60) +
           (parseFloat(m[4] || '0'));
  }

  root.SB = {
    parseM3u8: parseM3u8,
    parseMpd: parseMpd,
    indexAt: indexAt,
    isPlaylistUrl: isPlaylistUrl
  };
})(typeof window !== 'undefined' ? window : globalThis);

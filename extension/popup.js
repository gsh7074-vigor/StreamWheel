/* 视频拉流加速 · popup */

var $ = function (id) { return document.getElementById(id); };
var currentHost = '';
var currentTabId = null;

function fmtBytes(n) {
  if (!n) return '0 B';
  if (n < 1024) return n + ' B';
  if (n < 1048576) return (n / 1024).toFixed(0) + ' KB';
  return (n / 1048576).toFixed(1) + ' MB';
}

function setSwitch(el, on) {
  el.setAttribute('aria-checked', on ? 'true' : 'false');
}

function renderDisabled(disabled) {
  $('stat').classList.toggle('off', disabled);
  $('depth').disabled = disabled;
  $('conc').disabled = disabled;
  if (disabled) {
    $('statMain').textContent = '已关闭';
    $('statSub').textContent = '当前不发起任何预取请求';
  }
}

function renderDiag(d) {
  var box = $('diag');
  if (!box) return;
  box.innerHTML = '';
  box.hidden = !d;
  if (!d) return;

  var head = document.createElement('div');
  var b = document.createElement('b');
  b.textContent = '诊断：';
  head.appendChild(b);
  head.appendChild(document.createTextNode(
    (d.why || '解析失败') +
    (d.status ? '（HTTP ' + d.status + '）' : '') +
    (d.via ? '，取法 ' + d.via : '')));
  box.appendChild(head);

  if (d.url) {
    var u = document.createElement('code');
    u.textContent = d.url;
    box.appendChild(u);
  }
  if (d.raw) {
    var rw = document.createElement('code');
    rw.textContent = d.raw;
    box.appendChild(rw);
  }
  if (d.snippet) {
    var sn = document.createElement('code');
    sn.textContent = d.snippet.replace(/\s+/g, ' ').slice(0, 180);
    box.appendChild(sn);
  }
}

function formatProbe(r) {
  if (!r) return '测量未完成';
  if (!r.ok) return '测量失败：' + (r.error || '未知原因');
  return r.hit
    ? '✓ 命中缓存：回源 ' + r.cold + ' ms，缓存读取 ' + r.warm + ' ms（比值 ' + r.ratio + '）。预取有效。'
    : '✗ 未命中：回源 ' + r.cold + ' ms，二次请求 ' + r.warm +
      ' ms（比值 ' + r.ratio + '）。预取没进缓存，全片预取已跳过，建议关闭扩展。';
}

function renderCache(c) {
  var box = $('cache');
  if (!box) return;
  box.hidden = !c;
  if (!c) return;

  box.classList.remove('bad', 'warn');
  if (c.level === 'none') box.classList.add('bad');
  else if (c.level === 'weak' || c.level === 'unknown') box.classList.add('warn');

  $('cacheLabel').textContent = c.label || '—';
  $('cacheDesc').textContent = c.desc || '—';
}

function render(s) {
  currentHost = s.host || currentHost;
  $('host').textContent = currentHost || '—';
  setSwitch($('toggle'), s.enabled);
  setSwitch($('hud'), s.hud);

  // 双开是旧版本可能残留的状态，展示时也按互斥口径归一
  var whole = s.whole === true;
  var instant = !whole && s.instant === true;
  setSwitch($('whole'), whole);
  setSwitch($('instant'), instant);

  $('depth').value = s.depth;
  $('depthVal').textContent = s.depth;
  $('conc').value = s.conc;
  $('concVal').textContent = s.conc;

  renderDisabled(!s.enabled);
  renderDiag(s.diag);
  renderCache(s.cache);

  // 全片预取会自动跑一次命中验证，把结果直接显示出来，无需用户操作
  if (s.hitProbe && !s.hitProbe.pending) {
    var out = $('probeResult');
    out.hidden = false;
    out.textContent = formatProbe(s.hitProbe);
  }
  if (!s.enabled) return;

  if (s.prefetched > 0) {
    var main = s.whole && s.totalSegs
      ? '全片 ' + Math.min(s.prefetched, s.totalSegs) + '/' + s.totalSegs + ' 段 · ' + fmtBytes(s.bytes)
      : '已预取 ' + s.prefetched + ' 段 · ' + fmtBytes(s.bytes);
    $('statMain').textContent = main;
    $('statSub').textContent = (s.note || '') + (s.failed ? '（失败 ' + s.failed + ' 次）' : '');
  } else {
    $('statMain').textContent = s.note || '等待播放';
    $('statSub').textContent = s.failed
      ? '预取请求被拒 ' + s.failed + ' 次，多半是跨域或鉴权'
      : '开始播放后会自动预取后续分片';
  }
}

function readActiveTab() {
  chrome.tabs.query({ active: true, currentWindow: true }, function (tabs) {
    var tab = tabs && tabs[0];
    if (!tab) return;

    var url = tab.url || '';
    if (!/^https?:/i.test(url)) {
      $('host').textContent = '此页面不支持';
      $('statMain').textContent = '非网页环境';
      $('statSub').textContent = '请在 http/https 页面使用';
      $('toggle').disabled = true;
      $('depth').disabled = true;
      $('conc').disabled = true;
      $('hud').disabled = true;
      return;
    }

    $('host').textContent = new URL(url).hostname;
    currentTabId = tab.id;

    chrome.tabs.sendMessage(tab.id, { type: 'stats' }, function (s) {
      if (chrome.runtime.lastError || !s) {
        $('statMain').textContent = '未注入';
        $('statSub').textContent = '刷新页面后生效';
        chrome.storage.local.get(
          { enabled: true, depth: 4, conc: 3, hud: true, whole: false, instant: false },
          function (v) {
            setSwitch($('toggle'), v.enabled !== false);
            $('depth').value = v.depth; $('depthVal').textContent = v.depth;
            $('conc').value = v.conc; $('concVal').textContent = v.conc;
            setSwitch($('hud'), v.hud !== false);
            var w = v.whole === true;
            setSwitch($('whole'), w);
            setSwitch($('instant'), !w && v.instant === true);
          });
        return;
      }
      render(s);
    });
  });
}

function save(obj, cb) {
  chrome.storage.local.set(obj, function () { if (cb) cb(); });
}

$('toggle').addEventListener('click', function () {
  var on = this.getAttribute('aria-checked') !== 'true';
  setSwitch(this, on);
  renderDisabled(!on);
  save({ enabled: on });
});

$('hud').addEventListener('click', function () {
  var on = this.getAttribute('aria-checked') !== 'true';
  setSwitch(this, on);
  save({ hud: on });
});

$('depth').addEventListener('input', function () {
  $('depthVal').textContent = this.value;
  save({ depth: Number(this.value) });
});

$('conc').addEventListener('input', function () {
  $('concVal').textContent = this.value;
  save({ conc: Number(this.value) });
});

$('probeBtn').addEventListener('click', function () {
  if (currentTabId == null) return;
  var btn = this;
  var out = $('probeResult');
  btn.disabled = true;
  btn.textContent = '测量中…（会额外下载一个分片）';
  out.hidden = false;
  out.textContent = '正在做「强制回源 → 正常请求」两次计时…';

  chrome.tabs.sendMessage(currentTabId, { type: 'probeCache' }, function (r) {
    btn.disabled = false;
    btn.textContent = '实测是否命中';
    if (chrome.runtime.lastError || !r) {
      out.textContent = '测量失败：' + ((chrome.runtime.lastError && chrome.runtime.lastError.message) || '页面未响应，刷新后再试');
      return;
    }
    if (!r.ok) { out.textContent = formatProbe(r); return; }
    out.textContent = formatProbe(r);
  });
});

$('whole').addEventListener('click', function () {
  var on = this.getAttribute('aria-checked') !== 'true';
  setSwitch(this, on);
  setSwitch($('instant'), false);        // 互斥：开它就关另一个
  save({ whole: on, instant: false });   // 一次写两个键，避免中间态
  if (!on) { $('probeResult').hidden = true; }
});

$('instant').addEventListener('click', function () {
  var on = this.getAttribute('aria-checked') !== 'true';
  setSwitch(this, on);
  setSwitch($('whole'), false);          // 互斥：开它就关另一个
  save({ whole: false, instant: on });
  $('probeResult').hidden = true;
});

$('reset').addEventListener('click', function () {
  if (currentTabId == null) return;
  chrome.tabs.sendMessage(currentTabId, { type: 'reset' }, function () {
    readActiveTab();
  });
});

$('hintLink').addEventListener('click', function (e) {
  e.preventDefault();
  var box = $('explain');
  box.hidden = !box.hidden;
  this.textContent = box.hidden ? '能做什么？' : '收起';
});

readActiveTab();

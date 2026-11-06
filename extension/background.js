/* 视频拉流加速 · background
 * 1) 角标
 * 2) 播放列表代取：service worker 持有 <all_urls> 权限，不受页面 CORS 约束。
 *    只代取「列表文本」用于解析；分片预取仍由页面侧 fetch 完成，
 *    否则字节会落在 SW 的缓存分区，播放器命中不到。 */

var BADGE_BG = '#1d1d1f';

chrome.runtime.onInstalled.addListener(function () {
  var defaults = {
    enabled: true, depth: 4, conc: 3, hud: true,
    whole: false, instant: false, maxMB: 150
  };
  chrome.storage.local.get(defaults, function (cur) {
    chrome.storage.local.set(cur);
  });
});

chrome.runtime.onMessage.addListener(function (msg, sender, sendResponse) {
  if (!msg) return;

  // 代取播放列表（异步响应，必须 return true）
  if (msg.type === 'fetchText' && msg.url) {
    var doFetch = function (credentials) {
      return fetch(msg.url, { credentials: credentials, cache: 'no-store' })
        .then(function (r) {
          return r.text().then(function (t) {
            return { ok: r.ok, status: r.status, text: t };
          });
        });
    };
    doFetch('omit')
      .catch(function () { return doFetch('include'); })
      .then(sendResponse)
      .catch(function (e) {
        sendResponse({ ok: false, status: 0, error: String((e && e.message) || e) });
      });
    return true;
  }

  if (msg.type !== 'state' || !sender || !sender.tab || sender.tab.id == null) return;

  var id = sender.tab.id;
  if (msg.active && msg.count > 0) {
    var text = String(Math.min(999, msg.count));
    chrome.action.setBadgeText({ tabId: id, text: text });
    chrome.action.setBadgeBackgroundColor({ tabId: id, color: BADGE_BG });
    chrome.action.setBadgeTextColor({ tabId: id, color: '#ffffff' });
  } else {
    chrome.action.setBadgeText({ tabId: id, text: '' });
  }
});

chrome.tabs.onUpdated.addListener(function (tabId, info) {
  if (info.status === 'loading' || info.status === 'complete') {
    chrome.action.setBadgeText({ tabId: tabId, text: '' });
  }
});

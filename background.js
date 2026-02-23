'use strict';

const DEBUG = true;
let blockedRules = [];
let rulesLoaded = false;
const tabUrls = new Map();

function log() {
  if (DEBUG) {
    console.log.apply(console, ['[HB]'].concat(Array.prototype.slice.call(arguments)));
  }
}

function error() {
  if (DEBUG) {
    console.error.apply(console, ['[HB]'].concat(Array.prototype.slice.call(arguments)));
  }
}

// ── Safe API wrappers ───────────────────────────────────────────────────

function safeBadgeText(tabId, text) {
  try { browser.browserAction.setBadgeText({ text: text, tabId: tabId }); }
  catch(e) { error('setBadgeText error', e); }
}

function safeBadgeBg(tabId, color) {
  try { browser.browserAction.setBadgeBackgroundColor({ color: color, tabId: tabId }); }
  catch(e) {}
}

function safeBadgeTextColor(tabId, color) {
  try {
    if (browser.browserAction.setBadgeTextColor) {
      browser.browserAction.setBadgeTextColor({ color: color, tabId: tabId });
    }
  } catch(e) {}
}

function safeTitle(tabId, title) {
  try { browser.browserAction.setTitle({ title: title, tabId: tabId }); }
  catch(e) {}
}

// ── Storage ─────────────────────────────────────────────────────────────

async function load() {
  try {
    var data = await browser.storage.local.get('blockedSites');
    var raw = data.blockedSites || [];
    var migrated = false;

    blockedRules = raw.map(function(r) {
      if (typeof r === 'string') {
        migrated = true;
        return { pattern: r, addedAt: Date.now() };
      }
      if (!r.addedAt) {
        migrated = true;
        return { pattern: r.pattern, addedAt: Date.now() };
      }
      return r;
    });

    if (migrated) {
      await browser.storage.local.set({ blockedSites: blockedRules });
    }

    rulesLoaded = true;
    log('Loaded', blockedRules.length, 'rules');
  } catch (e) {
    error('Load error:', e);
    blockedRules = [];
    rulesLoaded = true;
  }
}

async function save() {
  try {
    await browser.storage.local.set({ blockedSites: blockedRules });
    log('Saved', blockedRules.length, 'rules');
  } catch (e) {
    error('Save error:', e);
  }
}

// ── Matching ────────────────────────────────────────────────────────────

function matchesPattern(pattern, url) {
  try {
    if (pattern.startsWith('/') && pattern.endsWith('/')) {
      return new RegExp(pattern.slice(1, -1), 'i').test(url);
    }
    var hostname = new URL(url).hostname.toLowerCase();
    var p = pattern.toLowerCase();
    return hostname === p || hostname.endsWith('.' + p);
  } catch (e) {
    return false;
  }
}

function getMatchingRule(url) {
  if (!url) return null;
  for (var i = 0; i < blockedRules.length; i++) {
    if (matchesPattern(blockedRules[i].pattern, url)) {
      return blockedRules[i];
    }
  }
  return null;
}

function extractDomain(url) {
  try { return new URL(url).hostname; }
  catch (e) { return null; }
}

// ── Deletion ────────────────────────────────────────────────────────────

async function tryDeleteUrl(url) {
  var rule = getMatchingRule(url);
  if (!rule) return false;

  try {
    var visits = await browser.history.getVisits({ url: url });

    if (!visits || visits.length === 0) {
      return false;
    }

    var hasOldVisit = false;
    for (var i = 0; i < visits.length; i++) {
      if (visits[i].visitTime < rule.addedAt) {
        hasOldVisit = true;
        break;
      }
    }

    if (hasOldVisit) {
      log('KEEPING (pre-rule visit exists):', url);
      return false;
    }

    await browser.history.deleteUrl({ url: url });
    log('DELETED:', url);
    return true;
  } catch (e) {
    error('Delete error for', url, e);
    try {
      await browser.history.deleteUrl({ url: url });
      return true;
    } catch (e2) {
      return false;
    }
  }
}

async function bulkDeleteForRule(rule) {
  var searchText = rule.pattern.startsWith('/') ? '' : rule.pattern;

  try {
    var results = await browser.history.search({
      text: searchText,
      startTime: rule.addedAt,
      maxResults: 5000
    });

    var deleted = 0;
    for (var i = 0; i < results.length; i++) {
      var item = results[i];
      if (!matchesPattern(rule.pattern, item.url)) continue;

      try {
        var visits = await browser.history.getVisits({ url: item.url });
        var hasOldVisit = false;
        for (var j = 0; j < visits.length; j++) {
          if (visits[j].visitTime < rule.addedAt) {
            hasOldVisit = true;
            break;
          }
        }

        if (!hasOldVisit) {
          await browser.history.deleteUrl({ url: item.url });
          deleted++;
        }
      } catch (e) {
        try {
          await browser.history.deleteUrl({ url: item.url });
          deleted++;
        } catch (e2) {}
      }
    }

    if (deleted > 0) {
      log('Bulk deleted', deleted, 'URLs for', rule.pattern);
    }
  } catch (e) {
    error('Bulk delete error for', rule.pattern, e);
  }
}

// ── Badge ───────────────────────────────────────────────────────────────

function updateBadge(tabId) {
  try {
    browser.tabs.get(tabId).then(function(tab) {
      var url = tab.url || '';
      var isSpecial = !url || url.startsWith('about:') || url.startsWith('moz-') || url.startsWith('chrome:');

      if (isSpecial) {
        safeBadgeText(tabId, '');
        safeTitle(tabId, 'History Blocker');
        return;
      }

      var blocked = !!getMatchingRule(url);
      var domain = extractDomain(url);

      safeBadgeText(tabId, blocked ? 'ON' : '');
      safeBadgeBg(tabId, '#e74c3c');
      safeBadgeTextColor(tabId, '#ffffff');
      safeTitle(tabId, blocked
        ? 'Blocking: ' + domain + ' (click to unblock)'
        : 'Click to block ' + domain
      );
    }).catch(function() {});
  } catch (e) {}
}

function updateAllBadges() {
  try {
    browser.tabs.query({}).then(function(tabs) {
      for (var i = 0; i < tabs.length; i++) {
        updateBadge(tabs[i].id);
      }
    }).catch(function() {});
  } catch (e) {}
}

// ═══════════════════════════════════════════════════════════════════════
//  ALL LISTENERS — synchronous, top level
// ═══════════════════════════════════════════════════════════════════════

// 1. HISTORY VISITED
try {
  browser.history.onVisited.addListener(function(item) {
    if (!rulesLoaded) {
      load().then(function() {
        if (getMatchingRule(item.url)) {
          log('onVisited (late-load):', item.url);
          tryDeleteUrl(item.url);
          setTimeout(function() { tryDeleteUrl(item.url); }, 1500);
          setTimeout(function() { tryDeleteUrl(item.url); }, 4000);
        }
      });
      return;
    }

    var rule = getMatchingRule(item.url);
    if (!rule) return;

    log('onVisited:', item.url);
    tryDeleteUrl(item.url);
    setTimeout(function() { tryDeleteUrl(item.url); }, 1500);
    setTimeout(function() { tryDeleteUrl(item.url); }, 4000);
  });
  log('✓ history.onVisited listener registered');
} catch (e) {
  error('✗ Failed to register history.onVisited:', e);
}

// 2. TAB UPDATED
try {
  browser.tabs.onUpdated.addListener(function(tabId, changeInfo, tab) {
    if (!changeInfo.url && changeInfo.status !== 'complete') return;

    var newUrl = changeInfo.url || tab.url;
    var oldUrl = tabUrls.get(tabId);

    if (newUrl) tabUrls.set(tabId, newUrl);

    if (oldUrl && newUrl) {
      var oldDomain = extractDomain(oldUrl);
      var newDomain = extractDomain(newUrl);

      if (oldDomain && newDomain && oldDomain !== newDomain) {
        var oldRule = getMatchingRule(oldUrl);
        if (oldRule) {
          log('Left blocked domain:', oldDomain, '→', newDomain);
          bulkDeleteForRule(oldRule);
        }
      }
    }

    updateBadge(tabId);
  });
  log('✓ tabs.onUpdated listener registered');
} catch (e) {
  error('✗ Failed to register tabs.onUpdated:', e);
}

// 3. TAB CLOSED
try {
  browser.tabs.onRemoved.addListener(function(tabId) {
    var url = tabUrls.get(tabId);
    tabUrls.delete(tabId);

    if (!url) return;

    var rule = getMatchingRule(url);
    if (!rule) return;

    log('Tab closed on blocked:', extractDomain(url));
    bulkDeleteForRule(rule);
  });
  log('✓ tabs.onRemoved listener registered');
} catch (e) {
  error('✗ Failed to register tabs.onRemoved:', e);
}

// 4. TAB ACTIVATED
try {
  browser.tabs.onActivated.addListener(function(activeInfo) {
    updateBadge(activeInfo.tabId);
  });
  log('✓ tabs.onActivated listener registered');
} catch (e) {
  error('✗ Failed to register tabs.onActivated:', e);
}

// 5. TOOLBAR BUTTON
try {
  browser.browserAction.onClicked.addListener(function(tab) {
    log('Toolbar clicked:', tab.url);

    var url = tab.url;
    if (!url) return;
    if (url.startsWith('about:') || url.startsWith('moz-') || url.startsWith('chrome:')) return;

    var domain = extractDomain(url);
    if (!domain) return;

    var doWork = function() {
      var idx = -1;
      for (var i = 0; i < blockedRules.length; i++) {
        if (blockedRules[i].pattern === domain) {
          idx = i;
          break;
        }
      }

      if (idx !== -1) {
        blockedRules.splice(idx, 1);
        log('Unblocked:', domain);
      } else {
        blockedRules.push({ pattern: domain, addedAt: Date.now() });
        log('Blocked:', domain);
      }

      save().then(function() {
        updateBadge(tab.id);
      });
    };

    if (!rulesLoaded) {
      load().then(doWork);
    } else {
      doWork();
    }
  });
  log('✓ browserAction.onClicked listener registered');
} catch (e) {
  error('✗ Failed to register browserAction.onClicked:', e);
}

// 6. STORAGE CHANGED
try {
  browser.storage.onChanged.addListener(function(changes, area) {
    if (area !== 'local' || !changes.blockedSites) return;

    var raw = changes.blockedSites.newValue || [];
    blockedRules = raw.map(function(r) {
      if (typeof r === 'string') return { pattern: r, addedAt: Date.now() };
      return { pattern: r.pattern, addedAt: r.addedAt || Date.now() };
    });

    log('Storage updated:', blockedRules.length, 'rules');
    rulesLoaded = true;
    updateAllBadges();
  });
  log('✓ storage.onChanged listener registered');
} catch (e) {
  error('✗ Failed to register storage.onChanged:', e);
}

// 7. STARTUP
log('Background script starting...');

load().then(function() {
  log('Startup complete,', blockedRules.length, 'rules loaded');
  updateAllBadges();

  browser.tabs.query({}).then(function(tabs) {
    for (var i = 0; i < tabs.length; i++) {
      if (tabs[i].url) {
        tabUrls.set(tabs[i].id, tabs[i].url);
      }
    }
    log('Tracking', tabUrls.size, 'open tabs');
  }).catch(function(e) {
    error('Tab query error:', e);
  });
}).catch(function(e) {
  error('Startup error:', e);
});

log('Background script loaded (listeners registered)');
// ==UserScript==
// @name         Roblox Creator Asset Tracker
// @namespace    https://www.github.com/annaroblox
// @version      1.3.0
// @description  Collects every asset you view on the Roblox Creator Dashboard, keeps ONE deduped record per Asset ID (name, description, thumbnail, type), sorts assets into Approved / Pending / Moderated, lets you search, sort, inspect, multi-select and bulk-manage assets, manually add pure Asset ID/link lists by paste or file and check/categorize them, periodically re-checks pending assets and refreshes approved metadata/status, can purge or skip moderated assets without relogging them, exports JSON, CSV, or a categorized HTML report, and can open as a live full-page tracker linked to the same logs.
// @author       annaroblox
// @match        https://create.roblox.com/*
// @match        https://www.roblox.com/develop*
// @icon         https://create.roblox.com/favicon.ico
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_addValueChangeListener
// @grant        GM_notification
// @grant        GM_registerMenuCommand
// @grant        GM_openInTab
// @grant        GM_xmlhttpRequest
// @grant        GM_setClipboard
// @grant        unsafeWindow
// @connect      thumbnails.roblox.com
// @connect      economy.roblox.com
// @connect      develop.roblox.com
// @connect      apis.roblox.com
// @connect      itemconfiguration.roblox.com
// @connect      catalog.roblox.com
// @connect      create.roblox.com
// @run-at       document-start
// @noframes
// @license      Apache
// ==/UserScript==

(function () {
  'use strict';

  /* Only run on dashboard-like pages (not create.roblox.com/docs etc.) */
  try {
    var _host = location.hostname;
    var _path = location.pathname;
    if (_host === 'create.roblox.com' && !/^\/(dashboard|store|marketplace|creator|configure)/.test(_path)) return;
  } catch (e) { /* ignore */ }

  /* ============================== CONFIG  ============================== */
  var CONFIG = {
    debug: false,                    // true = verbose console logging, prefix [RCAT]
    thumbnailBatchSize: 20,          // thumbnails API errors above ~20 Image-type ids per call
    thumbnailSize: '420x420',        // high-res enough for cards, details, and HTML exports
    thumbnailWidth: 420,
    eagerThumbnailCount: 12,         // first images load immediately; the rest use the progressive queue
    thumbnailLoadConcurrency: 6,     // max card images decoding/loading at once
    renderBatchSize: 120,            // cards rendered at a time (Load More reveals the next batch)
    scanDebounceMs: 700,
    enrichDelayMs: 350,              // gap between description back-fill requests
    recheckConcurrency: 3,
    approvedRefreshBatchSize: 30,   // stale approved assets refreshed per auto wakeup
    approvedRefreshWakeMinutes: 60, // wake cadence when pending auto-recheck is Off
    bulkOpenLimit: 10,              // avoid accidental tab floods from bulk Open
    manualAddLimit: 5000,           // unique IDs accepted from one manual paste/file
    manualAddFileMaxBytes: 5242880, // 5 MiB list-file safety cap
    maxHistoryEntries: 25,
    defaultRecheckMinutes: 5,
    defaultApprovedRefreshHours: 24
  };

  /* Status keyword lists  — matched against short badge/label texts.
     Order matters: moderated phrases are checked first so that e.g.
     "Not approved" is never read as approved. */
  var MOD_WORDS = [
    'content deleted', 'content_deleted', '[ content deleted ]', 'failed moderation',
    'moderation failed', 'failed review', 'did not pass', 'not approved', 'rejected',
    'moderated', 'blocked', 'declined', 'denied', 'removed by', 'deleted by', 'deleted'
  ];
  var PEN_WORDS = [
    'pending review', 'under review', 'in review', 'reviewing', 'awaiting review',
    'waiting for review', 'in moderation', 'moderation pending', 'not reviewed',
    'pending', 'processing'
  ];
  var APP_WORDS = [
    'passed moderation', 'ready to sell', 'approved'
  ];

  /* Roblox AssetTypeId -> readable name (common types; fallback is "Type N") */
  var ASSET_TYPE_BY_ID = {
    1: 'Image', 2: 'T-Shirt', 3: 'Audio', 4: 'Mesh', 5: 'Lua', 8: 'Hat', 9: 'Place',
    10: 'Model', 11: 'Shirt', 12: 'Pants', 13: 'Decal', 17: 'Head', 18: 'Face', 19: 'Gear',
    21: 'Badge', 24: 'Animation', 25: 'Arms', 26: 'Legs', 27: 'Torso', 32: 'Package',
    38: 'Plugin', 40: 'MeshPart', 41: 'Hair Accessory', 42: 'Face Accessory',
    43: 'Neck Accessory', 44: 'Shoulder Accessory', 45: 'Front Accessory',
    46: 'Back Accessory', 47: 'Waist Accessory', 48: 'Climb Animation',
    49: 'Death Animation', 50: 'Fall Animation', 51: 'Idle Animation',
    52: 'Jump Animation', 53: 'Run Animation', 54: 'Swim Animation',
    55: 'Walk Animation', 56: 'Pose Animation', 61: 'Emote Animation', 62: 'Video',
    64: 'T-Shirt Accessory', 65: 'Shirt Accessory', 66: 'Pants Accessory',
    67: 'Jacket Accessory', 68: 'Sweater Accessory', 69: 'Shorts Accessory',
    70: 'Left Shoe Accessory', 71: 'Right Shoe Accessory', 72: 'Dress/Skirt Accessory'
  };

  /* URL path segment -> asset type  */
  var TYPE_BY_SEGMENT = {
    'decals': 'Decal', 'decal': 'Decal', 'images': 'Image', 'image': 'Image',
    'audio': 'Audio', 'sounds': 'Audio', 'sound': 'Audio', 'videos': 'Video', 'video': 'Video',
    'models': 'Model', 'model': 'Model', 'meshes': 'Mesh', 'mesh': 'Mesh',
    'mesh-parts': 'MeshPart', 'animations': 'Animation', 'animation': 'Animation',
    'plugins': 'Plugin', 'plugin': 'Plugin', 'packages': 'Package', 'package': 'Package',
    'clothing': 'Clothing', 'avatar-items': 'Avatar Item', 'accessories': 'Accessory',
    'experiences': 'Experience', 'places': 'Place', 'badges': 'Badge',
    'passes': 'Pass', 'game-passes': 'Pass', 'developer-products': 'Developer Product',
    't-shirts': 'T-Shirt', 'shirts': 'Shirt', 'pants': 'Pants', 'fonts': 'Font'
  };

  /* Types whose IDs live in a different namespace than the asset thumbnail
     endpoint (badge/pass ids are NOT asset ids), so skip the thumbnail
     stage of a re-check for them. */
  var THUMB_SKIP_TYPES = { 'Badge': 1, 'Pass': 1, 'Developer Product': 1 };

  /* ============================== tiny utils ============================== */
  function log() { if (CONFIG.debug) { try { console.log.apply(console, ['[RCAT]'].concat([].slice.call(arguments))); } catch (e) {} } }
  function sleep(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }
  function debounce(fn, ms) { var t = null; return function () { var a = arguments, c = this; clearTimeout(t); t = setTimeout(function () { fn.apply(c, a); }, ms); }; }
  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }
  function chunk(arr, n) { var out = []; for (var i = 0; i < arr.length; i += n) out.push(arr.slice(i, i + n)); return out; }
  function parseDate(v) {
    if (v == null || v === '') return 0;
    if (typeof v === 'number') return v < 1e12 ? v * 1000 : v;
    var t = Date.parse(String(v));
    return isNaN(t) ? 0 : t;
  }
  function fmtDate(ts) {
    if (!ts) return '—';
    try { return new Date(ts).toLocaleString([], { year: 'numeric', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }); }
    catch (e) { return new Date(ts).toISOString(); }
  }
  function timeAgo(ts) {
    if (!ts) return 'never';
    var s = Math.max(1, Math.floor((Date.now() - ts) / 1000));
    if (s < 60) return s + 's ago';
    var m = Math.floor(s / 60); if (m < 60) return m + 'm ago';
    var h = Math.floor(m / 60); if (h < 24) return h + 'h ago';
    var d = Math.floor(h / 24); if (d < 365) return d + 'd ago';
    return Math.floor(d / 365) + 'y ago';
  }
  function prettyType(raw) {
    if (raw == null) return '';
    var s = String(raw).replace(/^ASSET_TYPE_/i, '').replace(/_/g, ' ').trim();
    if (!s) return '';
    if (s === s.toUpperCase()) s = s.toLowerCase().replace(/\b\w/g, function (c) { return c.toUpperCase(); });
    return s;
  }

  /* ============================== storage ============================== */
  var STORE_KEYS = { db: 'rcat_db_v1', settings: 'rcat_settings_v1' };
  function storageGet(key, fallback) {
    try {
      if (typeof GM_getValue === 'function') {
        var v = GM_getValue(key, undefined);
        if (v != null && !(v && typeof v.then === 'function')) return (typeof v === 'string' ? JSON.parse(v) : v);
      }
    } catch (e) {}
    try { var s = localStorage.getItem(key); if (s) return JSON.parse(s); } catch (e) {}
    return fallback;
  }
  function storageSet(key, val) {
    try { if (typeof GM_setValue === 'function') { GM_setValue(key, JSON.stringify(val)); return; } } catch (e) {}
    try { localStorage.setItem(key, JSON.stringify(val)); } catch (e) {}
  }

  /* ============================== state ============================== */
  var DB = storageGet(STORE_KEYS.db, null);
  if (!DB || typeof DB !== 'object' || !DB.assets || typeof DB.assets !== 'object') {
    DB = { version: 1, assets: {}, ignored: {} };
  }
  if (!DB.ignored) DB.ignored = {};

  var DEFAULT_SETTINGS = {
    recheckMinutes: CONFIG.defaultRecheckMinutes,
    approvedRefreshHours: CONFIG.defaultApprovedRefreshHours,
    autoScan: true,
    notifyDesktop: true,
    enrichDescriptions: true,
    recheckUnknown: true,
    ignoreModerated: false,
    highResThumbnails: true,
    sortBy: 'updated-desc',
    view: 'grid'
  };
  var settings = Object.assign({}, DEFAULT_SETTINGS, storageGet(STORE_KEYS.settings, {}) || {});
  var lastSyncedDB = cloneJSON(DB);
  var lastSyncedSettings = cloneJSON(settings);
  var applyingRemoteSync = false;
  var storageSyncRegistered = false;

  var ui = {
    tab: 'all', search: '', typeFilter: '', panelOpen: false, settingsOpen: false,
    renderLimit: CONFIG.renderBatchSize, detailsId: '', fullPage: false,
    selectedIds: new Set(), lastSelectedId: '', lastRenderedIds: [], manualAddOpen: false
  };
  var lastScanAt = 0, lastRecheckAt = 0, nextRecheckAt = 0;
  var recheckRunning = false, recheckProgress = '';
  var lastScanSignature = '', lastDetailSignature = '';
  var sessionFlags = { itemConfigFails: 0, assetsApiFails: 0, developFails: 0 };
  var pendingChangeNotes = [];

  function cloneJSON(value) {
    try { return JSON.parse(JSON.stringify(value)); } catch (e) { return value; }
  }
  function sameJSON(a, b) {
    try { return JSON.stringify(a == null ? null : a) === JSON.stringify(b == null ? null : b); }
    catch (e) { return a === b; }
  }
  function normalizeStoredDB(value) {
    var db = cloneJSON(value);
    if (!db || typeof db !== 'object') return null;
    if (!db.assets || typeof db.assets !== 'object') db.assets = {};
    if (!db.ignored || typeof db.ignored !== 'object') db.ignored = {};
    if (!db.version) db.version = 1;
    return db;
  }
  function assetActivityAt(a) {
    if (!a) return 0;
    return Math.max(
      Number(a.lastStatusChange || 0), Number(a.statusObservedAt || 0), Number(a.lastChecked || 0),
      Number(a.lastSeen || 0), Number(a.thumbnailCheckedAt || 0),
      Number(a.descCheckedAt || 0), Number(a.updated || 0), Number(a.firstSeen || 0)
    ) || 0;
  }
  function ignoredAt(v) {
    if (typeof v === 'number') return v;
    return (v && typeof v === 'object') ? (Number(v.at || 0) || 0) : 0;
  }
  function mergeRecordMap(baseMap, localMap, remoteMap, timestampFn) {
    var out = {}, keys = {};
    [baseMap || {}, localMap || {}, remoteMap || {}].forEach(function (map) {
      Object.keys(map).forEach(function (k) { keys[k] = true; });
    });
    Object.keys(keys).forEach(function (id) {
      var base = (baseMap || {})[id];
      var local = (localMap || {})[id];
      var remote = (remoteMap || {})[id];
      var chosen;
      if (sameJSON(local, base)) chosen = remote;              // only the other tab changed it (or deleted it)
      else if (sameJSON(remote, base)) chosen = local;        // only this tab changed it
      else if (local && remote) chosen = timestampFn(remote) > timestampFn(local) ? remote : local;
      else chosen = local || remote;                           // changed here vs deleted there: keep data; blocked IDs are pruned below
      if (chosen !== undefined && chosen !== null) out[id] = cloneJSON(chosen);
    });
    return out;
  }

  /* Live cross-tab sync: the side-panel tab and the full-page tab share the
     same storage. A three-way merge (last synced baseline vs this tab vs
     the incoming tab) lets both stay linked without a stale tab blindly
     overwriting newer removals/additions made in the other tab. */
  function mergeStoredDB(remoteInput, options) {
    options = options || {};
    var remote = normalizeStoredDB(remoteInput);
    if (!remote || sameJSON(remote, lastSyncedDB)) return false;
    var base = normalizeStoredDB(lastSyncedDB) || { version: 1, assets: {}, ignored: {} };
    var mergedIgnored = mergeRecordMap(base.ignored, DB.ignored, remote.ignored, ignoredAt);
    var mergedAssets = mergeRecordMap(base.assets, DB.assets, remote.assets, assetActivityAt);
    Object.keys(mergedIgnored).forEach(function (id) { delete mergedAssets[id]; });
    var changed = !sameJSON(DB.assets, mergedAssets) || !sameJSON(DB.ignored, mergedIgnored);
    applyingRemoteSync = true;
    try {
      DB.assets = mergedAssets;
      DB.ignored = mergedIgnored;
      DB.version = remote.version || DB.version || 1;
      lastSyncedDB = cloneJSON(remote);
    } finally { applyingRemoteSync = false; }
    if (changed) {
      if (ui.detailsId && !DB.assets[String(ui.detailsId)]) closeAssetDetails();
      if (shadow) renderAll(); else updateFAB();
      if (!options.skipSave && !sameJSON(DB, lastSyncedDB)) saveDBSoon();
    }
    return changed;
  }
  function syncDBFromStorage(options) {
    return mergeStoredDB(storageGet(STORE_KEYS.db, null), options);
  }
  function mergeStoredSettings(remoteInput, options) {
    options = options || {};
    if (!remoteInput || typeof remoteInput !== 'object') return false;
    var remote = Object.assign({}, DEFAULT_SETTINGS, cloneJSON(remoteInput));
    if (sameJSON(remote, lastSyncedSettings)) return false;
    var base = lastSyncedSettings || {};
    var keys = {}, changed = false;
    [base, settings, remote].forEach(function (obj) {
      Object.keys(obj || {}).forEach(function (k) { keys[k] = true; });
    });
    Object.keys(keys).forEach(function (k) {
      if (sameJSON(settings[k], base[k]) && !sameJSON(settings[k], remote[k])) {
        if (remote[k] === undefined) delete settings[k];
        else settings[k] = cloneJSON(remote[k]);
        changed = true;
      }
    });
    lastSyncedSettings = cloneJSON(remote);
    if (changed) {
      syncSettingsControls();
      scheduleRecheck();
      if (shadow) renderAll();
      if (!options.skipSave && !sameJSON(settings, lastSyncedSettings)) saveSettings();
    }
    return changed;
  }
  function syncSettingsFromStorage(options) {
    return mergeStoredSettings(storageGet(STORE_KEYS.settings, null), options);
  }
  function handleExternalStorageValue(key, newValue, remote) {
    if (remote === false) return;
    var parsed = newValue;
    if (typeof parsed === 'string') {
      try { parsed = JSON.parse(parsed); } catch (e) { return; }
    }
    if (key === STORE_KEYS.db) mergeStoredDB(parsed);
    else if (key === STORE_KEYS.settings) mergeStoredSettings(parsed);
  }
  function registerStorageSync() {
    if (storageSyncRegistered) return;
    storageSyncRegistered = true;
    try {
      if (typeof GM_addValueChangeListener === 'function') {
        GM_addValueChangeListener(STORE_KEYS.db, function (key, oldValue, newValue, remote) {
          handleExternalStorageValue(key, newValue, remote);
        });
        GM_addValueChangeListener(STORE_KEYS.settings, function (key, oldValue, newValue, remote) {
          handleExternalStorageValue(key, newValue, remote);
        });
      }
    } catch (e) { log('GM storage sync unavailable', e); }
    try {
      window.addEventListener('storage', function (e) {
        if (e.key === STORE_KEYS.db || e.key === STORE_KEYS.settings) {
          handleExternalStorageValue(e.key, e.newValue, true);
        }
      });
    } catch (e) {}
    try {
      window.addEventListener('focus', function () { syncDBFromStorage(); syncSettingsFromStorage(); });
      document.addEventListener('visibilitychange', function () {
        if (!document.hidden) { syncDBFromStorage(); syncSettingsFromStorage(); }
      });
    } catch (e) {}
  }

  var saveDBSoon = debounce(function () {
    if (applyingRemoteSync) return;
    syncDBFromStorage({ skipSave: true });
    lastSyncedDB = cloneJSON(DB);
    storageSet(STORE_KEYS.db, DB);
  }, 400);
  function saveDBNow() {
    if (applyingRemoteSync) return;
    syncDBFromStorage({ skipSave: true });
    lastSyncedDB = cloneJSON(DB);
    storageSet(STORE_KEYS.db, DB);
  }
  function saveSettings() {
    if (applyingRemoteSync) return;
    syncSettingsFromStorage({ skipSave: true });
    lastSyncedSettings = cloneJSON(settings);
    storageSet(STORE_KEYS.settings, settings);
  }
  try { window.addEventListener('beforeunload', saveDBNow); } catch (e) {}

  /* ============================== status logic ============================== */
  function statusFromText(text) {
    if (!text) return null;
    var t = ' ' + String(text).toLowerCase().replace(/_/g, ' ') + ' ';
    var i;
    for (i = 0; i < MOD_WORDS.length; i++) if (t.indexOf(MOD_WORDS[i]) !== -1) return 'moderated';
    for (i = 0; i < PEN_WORDS.length; i++) if (t.indexOf(PEN_WORDS[i]) !== -1) return 'pending';
    for (i = 0; i < APP_WORDS.length; i++) if (t.indexOf(APP_WORDS[i]) !== -1) return 'approved';
    return null;
  }

  /* Strict DOM badge parser. Unlike statusFromText (used for structured API
     values), this accepts only a complete short label such as "Under
     review" or "Status: Approved". Sentences/navigation text such as
     "Moderated assets", "Deleted items", or moderation-policy warnings are
     deliberately NOT statuses. This prevents broad configure-page UI copy
     from marking the configured asset moderated. */
  function statusFromBadgeText(text) {
    if (!text) return null;
    var t = String(text).replace(/[_-]+/g, ' ').replace(/\s+/g, ' ').trim().toLowerCase();
    t = t.replace(/^(?:asset\s+)?(?:status|moderation status|review status)\s*:\s*/, '');
    t = t.replace(/^[^\w\[]+/, '').replace(/[.!]+$/, '').trim();
    var MAP = {
      'approved': 'approved', 'passed moderation': 'approved', 'ready to sell': 'approved',
      'review approved': 'approved', 'reviewed approved': 'approved',
      'pending': 'pending', 'pending review': 'pending', 'under review': 'pending',
      'in review': 'pending', 'reviewing': 'pending', 'awaiting review': 'pending',
      'waiting for review': 'pending', 'in moderation': 'pending',
      'moderation pending': 'pending', 'not reviewed': 'pending', 'processing': 'pending',
      'moderated': 'moderated', 'rejected': 'moderated', 'blocked': 'moderated',
      'content deleted': 'moderated', '[content deleted]': 'moderated',
      '[ content deleted ]': 'moderated', 'failed moderation': 'moderated',
      'moderation failed': 'moderated', 'failed review': 'moderated',
      'did not pass': 'moderated', 'not approved': 'moderated',
      'declined': 'moderated', 'denied': 'moderated', 'deleted': 'moderated',
      'removed': 'moderated'
    };
    return MAP[t] || null;
  }

  /* Map any Roblox-ish status string to approved|pending|moderated|null.
     Handles Open Cloud values (MODERATION_STATE_APPROVED / Reviewing /
     Rejected), dashboard strings, and ModerationStatus enum names. */
  function normalizeStatusString(raw) {
    if (raw == null || typeof raw === 'number' || typeof raw === 'boolean') return null;
    var s = String(raw).trim().toUpperCase().replace(/^MODERATION_STATE_/, '').replace(/[\s-]+/g, '_');
    var MAP = {
      APPROVED: 'approved', REVIEWEDAPPROVED: 'approved', REVIEWED_APPROVED: 'approved',
      PASSED: 'approved', SUCCESS: 'approved', COMPLETED: 'approved', COMPLETE: 'approved',
      NOTAPPLICABLE: 'approved', NOT_APPLICABLE: 'approved', OK: 'approved',
      REVIEWING: 'pending', PENDING: 'pending', REVIEWPENDING: 'pending', REVIEW_PENDING: 'pending',
      UNDERREVIEW: 'pending', UNDER_REVIEW: 'pending', INREVIEW: 'pending', IN_REVIEW: 'pending',
      NOTREVIEWED: 'pending', NOT_REVIEWED: 'pending', PROCESSING: 'pending', QUEUED: 'pending',
      AWAITINGREVIEW: 'pending', AWAITING_REVIEW: 'pending',
      REJECTED: 'moderated', REVIEWEDREJECTED: 'moderated', REVIEWED_REJECTED: 'moderated',
      MODERATED: 'moderated', BLOCKED: 'moderated', DELETED: 'moderated',
      CONTENTDELETED: 'moderated', CONTENT_DELETED: 'moderated', REMOVED: 'moderated',
      DENIED: 'moderated', FAILED: 'moderated', FAILURE: 'moderated'
    };
    if (MAP[s]) return MAP[s];
    return statusFromText(String(raw));
  }

  /* Numeric ModerationStatus enum: 1 ReviewedApproved, 2 ReviewedRejected,
     3 NotReviewed, 4 NotApplicable, 5 Invalid */
  function normalizeStatusNumber(n) {
    return { 1: 'approved', 2: 'moderated', 3: 'pending', 4: 'approved' }[n] || null;
  }

  function blankAsset(id) {
    var now = Date.now();
    return {
      id: String(id), name: '', description: '', thumbnail: '', thumbnailWidth: 0, thumbnailCheckedAt: 0,
      type: '', typeId: 0,
      status: 'unknown', rawStatus: '', statusSource: '', statusConfidence: 0,
      created: 0, updated: 0, creatorName: '', creatorId: '', isArchived: false,
      pageUrl: '', firstSeen: now, lastSeen: now, lastChecked: 0, lastStatusChange: 0,
      statusObservedAt: 0, descCheckedAt: 0, unseenChange: false, statusHistory: []
    };
  }

  var flushChangeNotes = debounce(function () {
    if (!pendingChangeNotes.length) return;
    var notes = pendingChangeNotes.slice();
    pendingChangeNotes = [];
    var msg;
    if (notes.length === 1) {
      var n = notes[0];
      var icon = n.to === 'approved' ? '✅' : (n.to === 'moderated' ? '⛔' : '🔄');
      msg = icon + ' "' + (n.name || ('Asset ' + n.id)) + '" is now ' + n.to.toUpperCase() + ' (was ' + n.from + ')';
    } else {
      msg = '🔔 ' + notes.length + ' assets changed status: ' +
        notes.slice(0, 4).map(function (x) { return '"' + (x.name || x.id) + '" → ' + x.to; }).join(', ') +
        (notes.length > 4 ? '…' : '');
    }
    toast(msg, 8000);
    if (settings.notifyDesktop) {
      try { if (typeof GM_notification === 'function') GM_notification({ title: 'Roblox Creator Asset Tracker', text: msg, timeout: 9000 }); } catch (e) {}
    }
    log(msg);
  }, 1200);

  function queueChangeNote(asset, from, to) {
    pendingChangeNotes.push({ id: asset.id, name: asset.name, from: from, to: to });
    flushChangeNotes();
  }

  /* Core merge rule for a new status observation.
     confidence: 5 explicit moderation field, 4 dashboard badge / blocked
     thumbnail, 2 thumbnail pending/completed, 1 weak inference. */
  function applyStatus(asset, status, confidence, source, raw) {
    if (!status || status === 'unknown') return false;
    confidence = confidence || 0;
    var now = Date.now();
    var old = asset.status || 'unknown';
    if (status === old) {
      asset.statusObservedAt = now;
      if (confidence > (asset.statusConfidence || 0)) {
        asset.statusConfidence = confidence; asset.statusSource = source || asset.statusSource;
        if (raw) asset.rawStatus = String(raw);
      }
      return false;
    }
    var freshApiSignal = /^api:/.test(String(source || ''));
    var accept = false;
    if (old === 'unknown') accept = true;
    else if (status === 'pending' && (old === 'approved' || old === 'moderated') && confidence < 5) accept = false; // stale page guard
    else if (old === 'pending') accept = confidence >= 2;   // pending is transient: fresh signals win
    // Approved/moderated are not immutable forever. During an explicit API
    // recheck, a fresh strong signal (explicit state, Blocked thumbnail, or
    // [Content Deleted] economy name) may correct an older resolved status
    // even if that older observation had confidence 5.
    else if (freshApiSignal && confidence >= 4 && (status === 'approved' || status === 'moderated')) accept = true;
    else accept = confidence >= (asset.statusConfidence || 0);
    if (!accept) return false;

    asset.status = status;
    asset.statusConfidence = confidence;
    asset.statusSource = source || '';
    if (raw) asset.rawStatus = String(raw);
    asset.statusObservedAt = now;
    asset.lastStatusChange = now;
    asset.statusHistory = asset.statusHistory || [];
    asset.statusHistory.push({ s: status, at: now, src: source || '' });
    if (asset.statusHistory.length > CONFIG.maxHistoryEntries) asset.statusHistory = asset.statusHistory.slice(-CONFIG.maxHistoryEntries);
    if (old !== 'unknown') { asset.unseenChange = true; queueChangeNote(asset, old, status); }
    return true;
  }

  /* Thumbnail quality is tracked so a small image scraped from a dashboard
     card cannot replace a larger 420px thumbnail returned by Roblox's API. */
  function guessThumbnailWidth(url, partial) {
    if (partial) {
      var explicit = Number(partial.thumbnailWidth || 0);
      if (explicit > 0) return explicit;
      if (partial.thumbnailSize) {
        var sm = String(partial.thumbnailSize).match(/^(\d+)x(\d+)$/i);
        if (sm) return Number(sm[1]) || 0;
      }
      if (partial.thumbnailCompleted) return 250; // completed API render, exact size unknown
    }
    var s = String(url || '');
    var m = s.match(/(?:^|[/?&_\-])(30|42|50|60|75|110|140|150|160|250|256|300|304|384|396|420|480|512|576|700|728|768)x\d+(?=$|[/?&_\-])/i) ||
      s.match(/[?&](?:width|w|size)=(\d{2,4})(?:x\d+)?(?:&|$)/i);
    return m ? (Number(m[1]) || 0) : 0;
  }

  function needsHighResThumbnail(a) {
    if (!a || THUMB_SKIP_TYPES[a.type]) return false;
    if (!a.thumbnail) return true;
    var width = Number(a.thumbnailWidth || 0) || guessThumbnailWidth(a.thumbnail, null);
    if (width > 0 && width < CONFIG.thumbnailWidth) return true;
    // Older records have no width metadata. Refresh each such asset once;
    // thumbnailCheckedAt is set by our 420px API request afterwards.
    return !a.thumbnailCheckedAt;
  }

  /* Removed-list helpers. DB.ignored[id] may be a legacy timestamp number
     or { at, reason }; only truthiness blocks (re)logging. */
  function blockAsset(id, reason) {
    DB.ignored[String(id)] = { at: Date.now(), reason: reason || 'removed' };
  }
  function ignoredReason(v) { return (v && typeof v === 'object') ? String(v.reason || '') : ''; }
  function blockedModeratedCount() {
    var n = 0;
    Object.keys(DB.ignored).forEach(function (k) {
      if (ignoredReason(DB.ignored[k]).indexOf('moderated') === 0) n++;
    });
    return n;
  }

  /* Multi-selection is session/UI state, not DB state. IDs are pruned
     whenever records disappear (purge, cross-tab removal, clear DB, etc.). */
  function pruneSelection() {
    if (!ui.selectedIds || typeof ui.selectedIds.forEach !== 'function') ui.selectedIds = new Set();
    ui.selectedIds.forEach(function (id) { if (!DB.assets[String(id)]) ui.selectedIds.delete(id); });
    if (ui.lastSelectedId && !DB.assets[String(ui.lastSelectedId)]) ui.lastSelectedId = '';
    return ui.selectedIds;
  }
  function selectedAssetIds() {
    pruneSelection();
    var out = [], seen = {};
    function add(id) {
      id = String(id);
      if (!seen[id] && DB.assets[id] && ui.selectedIds.has(id)) { seen[id] = true; out.push(id); }
    }
    try { visibleAssets().forEach(function (a) { add(a.id); }); } catch (e) {}
    ui.selectedIds.forEach(add);
    return out;
  }
  function setAssetSelected(id, on) {
    id = String(id);
    pruneSelection();
    if (on) {
      if (!DB.assets[id]) return false;
      ui.selectedIds.add(id);
    } else ui.selectedIds.delete(id);
    ui.lastSelectedId = id;
    syncSelectionUI();
    return ui.selectedIds.has(id);
  }
  function clearSelection() {
    pruneSelection();
    ui.selectedIds.clear();
    ui.lastSelectedId = '';
    syncSelectionUI();
  }

  /* Shared manual/bulk removal: delete records and persistently block IDs
     just like the single-card ✕ action. */
  function removeAssetsByIds(ids, reason, options) {
    options = options || {};
    var seen = {}, unique = [];
    (ids || []).forEach(function (rawId) {
      var id = String(rawId);
      if (!seen[id] && DB.assets[id]) { seen[id] = true; unique.push(id); }
    });
    if (!unique.length) return 0;
    unique.forEach(function (id) {
      delete DB.assets[id];
      blockAsset(id, reason || 'removed-manual-bulk');
      if (ui.selectedIds) ui.selectedIds.delete(id);
    });
    try {
      if (Array.isArray(enrichQueue)) {
        for (var i = enrichQueue.length - 1; i >= 0; i--) {
          if (unique.indexOf(String(enrichQueue[i])) !== -1) enrichQueue.splice(i, 1);
        }
      }
    } catch (e) {}
    try {
      if (Array.isArray(highResQueue)) {
        for (var j = highResQueue.length - 1; j >= 0; j--) {
          if (unique.indexOf(String(highResQueue[j])) !== -1) highResQueue.splice(j, 1);
        }
      }
      if (highResQueued) unique.forEach(function (id) { delete highResQueued[id]; });
    } catch (e) {}
    if (ui.detailsId && unique.indexOf(String(ui.detailsId)) !== -1) closeAssetDetails();
    pruneSelection();
    saveDBNow();
    renderAll();
    if (!options.quiet) {
      toast('Removed ' + unique.length + ' selected asset' + (unique.length === 1 ? '' : 's') +
        ' and added their IDs to the removed list (Settings can reset it).');
    }
    log('removed assets:', unique.length, 'reason:', reason || 'removed-manual-bulk');
    return unique.length;
  }
  function removeSelectedAssetsWithConfirm() {
    var ids = selectedAssetIds();
    if (!ids.length) { toast('No assets are selected.'); return 0; }
    if (!window.confirm('Remove ' + ids.length + ' selected asset(s) from the tracker?\n\n' +
      'Their Asset IDs go onto the removed list, so rescanning the dashboard will NOT log them again.\n' +
      'Your actual Roblox assets are not changed.\n\n' +
      '(To undo later: Settings → Reset removed list, then rescan.)')) return 0;
    return removeAssetsByIds(ids, 'removed-manual-bulk');
  }

  /* Remove ONLY moderated assets, then block their IDs persistently so a
     later scan of the same dashboard page cannot relog them. */
  function removeModeratedAssets(reason) {
    var ids = Object.keys(DB.assets).filter(function (id) { return DB.assets[id].status === 'moderated'; });
    if (!ids.length) return 0;
    ids.forEach(function (id) { delete DB.assets[id]; blockAsset(id, reason || 'moderated-purge'); });
    if (typeof enrichQueue !== 'undefined' && Array.isArray(enrichQueue)) {
      for (var i = enrichQueue.length - 1; i >= 0; i--) {
        if (ids.indexOf(enrichQueue[i]) !== -1) enrichQueue.splice(i, 1);
      }
    }
    if (ui.detailsId && ids.indexOf(String(ui.detailsId)) !== -1) closeAssetDetails();
    saveDBNow();
    renderAll();
    toast('⛔ Removed ' + ids.length + ' moderated asset' + (ids.length === 1 ? '' : 's') +
      '. Their IDs are on the removed list, so they won’t be logged again.');
    log('removed moderated assets:', ids.length, 'reason:', reason || 'moderated-purge');
    return ids.length;
  }

  function purgeModeratedWithConfirm() {
    var n = countByStatus().moderated;
    if (!n) { toast('No moderated assets are currently tracked.'); return; }
    if (window.confirm('Remove ' + n + ' moderated asset(s) from the tracker?\n\n' +
      'Approved, Pending and Unknown assets are NOT touched.\n' +
      'Removed IDs go onto the removed list, so scanning the dashboard will NOT log them again.\n' +
      '(To undo later: Settings → Reset removed list, then rescan.)')) {
      removeModeratedAssets('moderated-purge');
    }
  }

  /* Merge a partial observation into the DB. Returns true if new/changed. */
  function upsertAsset(p, source) {
    if (!p || p.id == null) return false;
    var id = String(p.id);
    if (!/^\d{4,}$/.test(id)) return false;
    if (DB.ignored[id]) return false;
    var isNew = !DB.assets[id];

    // "Don't log moderated assets": a brand-new asset whose first signal is
    // moderated is never created. Blocking its ID makes later scans skip it.
    if (settings.ignoreModerated && isNew) {
      var incomingName = (p.name != null) ? String(p.name) : '';
      if (p.status === 'moderated' || /\[?\s*content deleted\s*\]?/i.test(incomingName)) {
        blockAsset(id, 'moderated-skipped');
        saveDBSoon();
        log('not logging moderated asset (toggle on):', id, incomingName || p.rawStatus || '');
        return false;
      }
    }

    var a = DB.assets[id] || blankAsset(id);
    var changed = isNew;
    var becameModerated = false; // only when THIS observation transitions into moderated

    if (p.name != null && String(p.name).trim() !== '') {
      var nm = String(p.name).trim();
      if (/\[?\s*content deleted\s*\]?/i.test(nm)) {
        if (applyStatus(a, 'moderated', 4, source || 'name', nm)) { changed = true; becameModerated = true; }
        if (!a.name) { a.name = '[Content Deleted]'; changed = true; } // keep a previously seen real name
      } else if (nm !== a.name) { a.name = nm; changed = true; }
    }
    if (p.description != null && String(p.description).trim() !== '' && String(p.description) !== a.description) {
      a.description = String(p.description); changed = true;
    }
    if (p.thumbnail && String(p.thumbnail).indexOf('http') === 0) {
      var newThumb = String(p.thumbnail);
      var newThumbWidth = guessThumbnailWidth(newThumb, p);
      var oldThumbWidth = Number(a.thumbnailWidth || 0) || guessThumbnailWidth(a.thumbnail, null);
      var shouldUseThumb = !a.thumbnail || newThumbWidth > oldThumbWidth ||
        oldThumbWidth === 0 || (newThumbWidth === oldThumbWidth && p.thumbnailCompleted);
      if (shouldUseThumb && a.thumbnail !== newThumb) {
        a.thumbnail = newThumb;
        changed = true;
      }
      if (shouldUseThumb && newThumbWidth > (Number(a.thumbnailWidth || 0))) {
        a.thumbnailWidth = newThumbWidth;
        changed = true;
      }
    }
    if (p.thumbnailCheckedAt) {
      var thumbChecked = parseDate(p.thumbnailCheckedAt) || Number(p.thumbnailCheckedAt) || 0;
      if (thumbChecked > (Number(a.thumbnailCheckedAt || 0))) {
        a.thumbnailCheckedAt = thumbChecked;
        changed = true;
      }
    }
    if (p.typeId) {
      var tid = parseInt(p.typeId, 10);
      if (tid && tid !== a.typeId) { a.typeId = tid; changed = true; if (!p.type) a.type = ASSET_TYPE_BY_ID[tid] || ('Type ' + tid); }
    }
    if (p.type) { var pt = prettyType(p.type); if (pt && pt !== a.type) { a.type = pt; changed = true; } }
    if (p.created) { var cd = parseDate(p.created); if (cd && (!a.created || cd < a.created)) { a.created = cd; changed = true; } }
    if (p.updated) { var ud = parseDate(p.updated); if (ud && ud > (a.updated || 0)) { a.updated = ud; changed = true; } }
    if (p.creatorName && p.creatorName !== a.creatorName) { a.creatorName = String(p.creatorName); changed = true; }
    if (p.creatorId && String(p.creatorId) !== a.creatorId) { a.creatorId = String(p.creatorId); changed = true; }
    if (p.isArchived === true && !a.isArchived) { a.isArchived = true; changed = true; }
    if (p.isArchived === false && a.isArchived) { a.isArchived = false; changed = true; }
    if (p.url && /(create\.roblox\.com|roblox\.com\/(library|catalog))/.test(String(p.url))) {
      var u = String(p.url);
      if (!a.pageUrl || (u.indexOf('create.roblox.com') !== -1 && a.pageUrl.indexOf('create.roblox.com') === -1)) {
        if (a.pageUrl !== u) changed = true;
        a.pageUrl = u;
      }
    }
    if (p.status) {
      if (applyStatus(a, p.status, p.statusConfidence || 0, source || '', p.rawStatus)) {
        changed = true;
        if (p.status === 'moderated') becameModerated = true;
      }
    }

    // "Don't log moderated assets": an already-tracked asset that just
    // flipped to moderated is dropped (and ID-blocked) immediately. The
    // change notification was already queued inside applyStatus, so the
    // user still hears about it. Assets that were ALREADY moderated when
    // the toggle was switched on are not touched here (no transition), so
    // choosing "keep them for now" at toggle-time is respected until the
    // user purges them manually.
    if (settings.ignoreModerated && becameModerated) {
      delete DB.assets[id]; // no-op for a just-created record not yet stored
      blockAsset(id, isNew ? 'moderated-skipped' : 'moderated-auto');
      if (String(ui.detailsId || '') === id) closeAssetDetails();
      saveDBSoon();
      log('auto-removed newly moderated asset (toggle on):', id, a.name || '');
      return true;
    }

    a.lastSeen = Date.now();
    DB.assets[id] = a;
    if (isNew || !a.name || !a.description) queueEnrich(id);
    return changed;
  }

  /* ============================== generic JSON harvest ============================== */
  function isUserOrGroupObject(keys) {
    return keys.username !== undefined || keys.hasverifiedbadge !== undefined ||
      keys.friendshipstatus !== undefined || keys.membercount !== undefined ||
      keys.shout !== undefined;
  }

  /* Turn one arbitrary JSON object into a partial asset record, or null. */
  function extractAssetRecord(obj) {
    if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return null;
    var keys = {};
    for (var k in obj) { try { keys[String(k).toLowerCase().replace(/[^a-z0-9]/g, '')] = obj[k]; } catch (e) {} }
    if (isUserOrGroupObject(keys)) return null;
    // Badge objects carry their own id namespace (icon is a separate asset) — skip in JSON harvest.
    if (keys.iconimageid !== undefined && (keys.awarder !== undefined || keys.statistics !== undefined)) return null;

    function pick(names) { for (var i = 0; i < names.length; i++) if (keys[names[i]] !== undefined) return keys[names[i]]; return undefined; }

    var name = pick(['name', 'displayname', 'title', 'assetname', 'itemname']);
    var desc = pick(['description']);
    var typeRaw = pick(['assettype', 'assettypename', 'typename']);
    var typeId = pick(['assettypeid']);
    var created = pick(['created', 'createdat', 'creationtime', 'createddate', 'datecreated', 'revisioncreatetime']);
    var updated = pick(['updated', 'updatedat', 'lastmodified', 'updateddate']);
    var creatorObj = (keys.creator && typeof keys.creator === 'object') ? keys.creator : null;
    var creatorName = pick(['creatorname']) || (creatorObj ? (creatorObj.name || creatorObj.displayName || creatorObj.Name) : '');
    var creatorId = pick(['creatorid', 'creatortargetid']) || (creatorObj ? (creatorObj.id || creatorObj.userId || creatorObj.groupId || creatorObj.Id) : '');

    // Universe/experience objects: register by root place id as an Experience.
    if (keys.rootplaceid && (keys.playing !== undefined || keys.visits !== undefined || keys.universeid !== undefined || keys.maxplayers !== undefined)) {
      var rp = String(keys.rootplaceid);
      if (/^\d{4,}$/.test(rp)) {
        return { id: rp, name: name || '', description: desc || '', type: 'Experience', created: created, updated: updated, creatorName: creatorName || '', creatorId: creatorId || '' };
      }
      return null;
    }

    var id = pick(['assetid', 'itemid', 'placeid', 'id']);
    var isThumbEntry = false;
    if (id === undefined && keys.targetid !== undefined && (keys.imageurl !== undefined || keys.state !== undefined)) {
      id = keys.targetid; isThumbEntry = true;
    }
    if (id === undefined && typeof keys.path === 'string') {
      var m = keys.path.match(/assets\/(\d{4,})/); if (m) id = m[1];
    }
    if (id === undefined || id === null || !/^\d+$/.test(String(id)) || Number(id) < 1000) return null;

    var thumb = pick(['thumbnailurl', 'imageurl', 'iconurl', 'thumbnail', 'image', 'icon']);
    if (typeof thumb !== 'string' || thumb.indexOf('http') !== 0) thumb = '';

    var type = prettyType(typeRaw);
    if (!type && typeof keys.type === 'string' &&
      (/ASSET_TYPE_/i.test(keys.type) || /^(decal|image|audio|video|model|mesh|meshpart|animation|plugin|package|place|shirt|pants|t-shirt|accessory|hat|face|head|gear|badge|pass)$/i.test(keys.type))) {
      type = prettyType(keys.type);
    }
    if (!type && typeId !== undefined && ASSET_TYPE_BY_ID[Number(typeId)]) type = ASSET_TYPE_BY_ID[Number(typeId)];
    if (!type && pick(['placeid']) !== undefined && id === pick(['placeid'])) type = 'Place';

    // ---- status ----
    var status = null, conf = 0, raw = '';
    var modResult = (keys.moderationresult && typeof keys.moderationresult === 'object') ? keys.moderationresult : null;
    var modVal = pick(['moderationstate', 'moderationstatus', 'reviewstate', 'reviewstatus', 'auditstatus']);
    if (modVal === undefined && modResult) modVal = modResult.moderationState || modResult.ModerationState || modResult.state || modResult.status;
    if (modVal !== undefined) {
      status = (typeof modVal === 'number') ? normalizeStatusNumber(modVal) : normalizeStatusString(modVal);
      if (status) { conf = 5; raw = String(modVal); }
    }
    if (!status) {
      if (keys.ismoderated === true || keys.moderated === true) { status = 'moderated'; conf = 5; raw = 'moderated=true'; }
      else if (keys.isapproved === true) { status = 'approved'; conf = 5; raw = 'approved=true'; }
      else if (keys.ispending === true || keys.pendingreview === true) { status = 'pending'; conf = 5; raw = 'pending=true'; }
    }
    if (!status) {
      var sv = pick(['status', 'state', 'itemstatus']);
      if (Array.isArray(sv)) { status = statusFromText(sv.join(' ')); if (status) { conf = 4; raw = sv.join(','); } }
      else if (sv !== undefined && sv !== null && sv !== '') {
        if (isThumbEntry) {
          var ts = String(sv);
          if (/blocked/i.test(ts)) { status = 'moderated'; conf = 4; }
          else if (/pending/i.test(ts)) { status = 'pending'; conf = 2; }
          else if (/completed/i.test(ts)) { status = 'approved'; conf = 2; }
          if (status) raw = 'thumbnail:' + ts;
        } else {
          status = (typeof sv === 'number') ? null : normalizeStatusString(sv);
          if (status) { conf = 4; raw = String(sv); }
        }
      }
    }

    // Must look asset-ish (avoid registering random id-bearing objects).
    if (!name && !desc && !type && typeId === undefined && !thumb && !status) return null;
    if (typeof name !== 'string') name = name == null ? '' : String(name);
    if (typeof desc !== 'string') desc = desc == null ? '' : String(desc);

    return {
      id: String(id), name: name, description: desc, type: type,
      typeId: typeId !== undefined ? Number(typeId) || 0 : 0,
      thumbnail: thumb, thumbnailCompleted: isThumbEntry && status === 'approved' && !!thumb,
      status: status, statusConfidence: conf, rawStatus: raw,
      created: created, updated: updated,
      creatorName: creatorName || '', creatorId: creatorId || '',
      isArchived: keys.isarchived === true || keys.archived === true ? true : (keys.isarchived === false ? false : undefined)
    };
  }

  function extractAll(json) {
    var out = [];
    var seen = (typeof WeakSet !== 'undefined') ? new WeakSet() : null;
    (function walk(node, depth) {
      if (!node || typeof node !== 'object' || depth > 9) return;
      if (seen) { if (seen.has(node)) return; seen.add(node); }
      if (Array.isArray(node)) {
        for (var i = 0; i < node.length && i < 3000; i++) walk(node[i], depth + 1);
        return;
      }
      var rec = extractAssetRecord(node);
      if (rec) out.push(rec);
      for (var k in node) { try { var v = node[k]; if (v && typeof v === 'object') walk(v, depth + 1); } catch (e) {} }
    })(json, 0);
    return out;
  }

  function harvestFromJSON(json, sourceUrl, sourceLabel) {
    // Dashboard network capture is automatic collection, so it must obey
    // the Auto-scan setting exactly like DOM scanning. Direct/manual API
    // harvest calls with another label remain available for tests/tools.
    if (!settings.autoScan && sourceLabel === 'dashboard-api') return 0;
    var recs = extractAll(json);
    var changed = 0;
    for (var i = 0; i < recs.length; i++) if (upsertAsset(recs[i], sourceLabel || 'dashboard-api')) changed++;
    if (recs.length) log('harvest', sourceUrl || '', 'records:', recs.length, 'changed:', changed);
    if (changed) afterDBChange();
    return changed;
  }

  /* ============================== network capture ============================== */
  var pageWin = (typeof unsafeWindow !== 'undefined' && unsafeWindow) ? unsafeWindow : window;
  var recentNet = new Set();

  /* This function is stringified and injected into the page. It must be
     fully self-contained (no references to userscript-scope variables). */
  function __rcatPageInterceptor() {
    if (window.__rcatIntercepted) return;
    window.__rcatIntercepted = true;
    var TAG = '__rcat_net_v1';
    function send(url, body) {
      try {
        if (!body || body.length > 3000000) return;
        var first = body.replace(/^\s+/, '').charAt(0);
        if (first !== '{' && first !== '[') return;
        window.postMessage({ tag: TAG, url: String(url || ''), body: body }, window.location.origin);
      } catch (e) {}
    }
    var of = window.fetch;
    if (of) {
      window.fetch = function () {
        var args = arguments;
        var p = of.apply(this, args);
        try {
          p.then(function (resp) {
            try {
              var u = (args[0] && args[0].url) || args[0] || (resp && resp.url) || '';
              var ct = resp && resp.headers && resp.headers.get ? resp.headers.get('content-type') : '';
              if (ct && ct.indexOf('json') === -1 && ct.indexOf('text') === -1) return;
              resp.clone().text().then(function (t) { send(u, t); }).catch(function () {});
            } catch (e) {}
          }).catch(function () {});
        } catch (e) {}
        return p;
      };
    }
    var OX = window.XMLHttpRequest;
    if (OX) {
      var oo = OX.prototype.open, os = OX.prototype.send;
      OX.prototype.open = function (m, u) { try { this.__rcatUrl = u; } catch (e) {} return oo.apply(this, arguments); };
      OX.prototype.send = function () {
        var xhr = this;
        try {
          xhr.addEventListener('load', function () {
            try {
              if (xhr.responseType === '' || xhr.responseType === 'text') send(xhr.__rcatUrl, xhr.responseText);
              else if (xhr.responseType === 'json' && xhr.response) send(xhr.__rcatUrl, JSON.stringify(xhr.response));
            } catch (e) {}
          });
        } catch (e) {}
        return os.apply(this, arguments);
      };
    }
  }

  function patchNetwork() {
    // 1) Inject into the page (most reliable where CSP allows).
    try {
      var s = document.createElement('script');
      s.textContent = '(' + __rcatPageInterceptor.toString() + ')();';
      (document.documentElement || document.head || document.body).appendChild(s);
      s.remove();
    } catch (e) { log('inject failed', e); }
    // 2) Fallback: patch via unsafeWindow if injection was blocked.
    try {
      if (pageWin && !pageWin.__rcatIntercepted && pageWin.fetch) {
        pageWin.__rcatIntercepted = true;
        var of = pageWin.fetch;
        pageWin.fetch = function () {
          var args = arguments;
          var p = of.apply(this, args);
          try {
            p.then(function (resp) {
              try {
                var u = (args[0] && args[0].url) || String(args[0] || '');
                resp.clone().text().then(function (t) {
                  try { pageWin.postMessage({ tag: '__rcat_net_v1', url: u, body: t }, pageWin.location.origin); } catch (e) {}
                }).catch(function () {});
              } catch (e) {}
            }).catch(function () {});
          } catch (e) {}
          return p;
        };
        log('patched page fetch via unsafeWindow fallback');
      }
    } catch (e) { log('unsafeWindow patch failed', e); }

    window.addEventListener('message', function (e) {
      try {
        if (e.origin !== location.origin) return;
        var d = e.data;
        if (!d || d.tag !== '__rcat_net_v1' || typeof d.body !== 'string') return;
        if (!settings.autoScan) return; // browsing must not collect via network when Auto-scan is OFF
        var h = d.url + '|' + d.body.length + '|' + d.body.slice(0, 100);
        if (recentNet.has(h)) return;
        recentNet.add(h);
        if (recentNet.size > 400) recentNet.clear();
        if (/analytics|telemetry|metrics|tracking|presence\.|friends\./i.test(d.url) && !/asset/i.test(d.url)) return;
        var json;
        try { json = JSON.parse(d.body); } catch (err) { return; }
        harvestFromJSON(json, d.url, 'dashboard-api');
      } catch (err) {}
    });
  }

  /* ============================== Roblox API layer ============================== */
  function gmGetJSON(url) {
    return new Promise(function (res) {
      try {
        GM_xmlhttpRequest({
          method: 'GET', url: url, headers: { 'Accept': 'application/json' }, anonymous: false,
          onload: function (r) {
            var j = null; try { j = JSON.parse(r.responseText); } catch (e) {}
            res({ ok: r.status >= 200 && r.status < 300, status: r.status, json: j, text: r.responseText });
          },
          onerror: function () { res({ ok: false, status: 0, json: null }); },
          ontimeout: function () { res({ ok: false, status: 0, json: null }); }
        });
      } catch (e) { res({ ok: false, status: 0, json: null }); }
    });
  }

  async function apiGetJSON(url) {
    try {
      var r = await fetch(url, { credentials: 'include', headers: { 'Accept': 'application/json' } });
      var text = await r.text();
      var json = null; try { json = JSON.parse(text); } catch (e) {}
      return { ok: r.ok, status: r.status, json: json, text: text };
    } catch (e) {
      if (typeof GM_xmlhttpRequest === 'function') return gmGetJSON(url);
      return { ok: false, status: 0, json: null, error: String(e) };
    }
  }

  async function fetchThumbChunk(ids) {
    var url = 'https://thumbnails.roblox.com/v1/assets?assetIds=' + ids.join(',') +
      '&size=' + CONFIG.thumbnailSize + '&format=Png&isCircular=false';
    var r = await apiGetJSON(url);
    if (!r.ok || !r.json) {
      if (ids.length > 1) {
        var mid = ids.length >> 1;
        await fetchThumbChunk(ids.slice(0, mid));
        await fetchThumbChunk(ids.slice(mid));
      }
      return;
    }
    var data = r.json.data || [];
    for (var i = 0; i < data.length; i++) {
      var rec = extractAssetRecord(data[i]);
      if (rec) {
        rec.thumbnailWidth = CONFIG.thumbnailWidth;
        rec.thumbnailSize = CONFIG.thumbnailSize;
        rec.thumbnailCheckedAt = Date.now();
        upsertAsset(rec, 'api:thumbnail-420');
      }
      var a = DB.assets[String(data[i].targetId)];
      if (a) a.lastChecked = Date.now();
    }
  }

  async function fetchThumbnails(ids, onProgress) {
    var usable = ids.filter(function (id) { var a = DB.assets[id]; return !a || !THUMB_SKIP_TYPES[a.type]; });
    var chunks = chunk(usable, CONFIG.thumbnailBatchSize);
    var done = 0;
    for (var i = 0; i < chunks.length; i++) {
      await fetchThumbChunk(chunks[i]);
      done += chunks[i].length;
      if (onProgress) onProgress(done, usable.length);
      await sleep(150);
    }
  }

  /* Background high-resolution thumbnail refresh. The panel queues only
     rendered assets, one batch after another, instead of letting hundreds
     of small dashboard thumbnails remain blurry or firing unbounded work. */
  var highResQueue = [];
  var highResQueued = {};
  var highResAttemptedAt = {};
  var highResRunning = false;

  function queueHighResThumbnails(assetsOrIds) {
    if (!settings.highResThumbnails || !assetsOrIds || !assetsOrIds.length) return;
    var added = false;
    var now = Date.now();
    assetsOrIds.forEach(function (item) {
      var id = String((item && typeof item === 'object') ? item.id : item);
      var a = DB.assets[id];
      // A failed/missing thumbnail is retried at most once every 10 minutes,
      // preventing a render -> retry -> render loop.
      if (!a || highResQueued[id] || (highResAttemptedAt[id] && now - highResAttemptedAt[id] < 600000) || !needsHighResThumbnail(a)) return;
      highResQueued[id] = true;
      highResAttemptedAt[id] = now;
      highResQueue.push(id);
      added = true;
    });
    if (added) processHighResQueue();
  }

  async function processHighResQueue() {
    if (highResRunning) return;
    highResRunning = true;
    while (highResQueue.length) {
      var batch = highResQueue.splice(0, CONFIG.thumbnailBatchSize);
      try { await fetchThumbnails(batch); } catch (e) { log('high-res thumbnail batch failed', e); }
      batch.forEach(function (id) { delete highResQueued[id]; });
      saveDBSoon();
      if (ui.panelOpen) renderSoon();
      if (ui.detailsId) refreshOpenAssetDetails();
      await sleep(200);
    }
    highResRunning = false;
  }

  var detailRefreshInFlight = {};
  async function refreshAssetDetails(id) {
    id = String(id);
    if (!DB.assets[id] || detailRefreshInFlight[id]) return;
    detailRefreshInFlight[id] = true;
    try {
      var a = DB.assets[id];
      var jobs = [];
      if (needsHighResThumbnail(a)) jobs.push(fetchThumbnails([id]));
      if (!a.description || !a.created || !a.name) jobs.push(fetchEconomyDetails(id));
      if (jobs.length) await Promise.all(jobs);
      var b = DB.assets[id];
      if (b) b.lastChecked = Date.now();
      saveDBSoon();
      if (ui.panelOpen) renderSoon();
      if (String(ui.detailsId || '') === id) refreshOpenAssetDetails();
    } catch (e) {
      log('asset detail refresh failed', id, e);
    } finally {
      delete detailRefreshInFlight[id];
    }
  }

  async function fetchEconomyDetails(id) {
    var r = await apiGetJSON('https://economy.roblox.com/v2/assets/' + encodeURIComponent(id) + '/details');
    if (!r.ok || !r.json) return false;
    var rec = extractAssetRecord(r.json);
    if (!rec || rec.id !== String(id)) {
      // Economy shape fallback: build manually from well-known fields.
      var j = r.json;
      rec = {
        id: String(id), name: j.Name || '', description: j.Description || '',
        typeId: j.AssetTypeId || 0, type: ASSET_TYPE_BY_ID[j.AssetTypeId] || '',
        created: j.Created || 0, updated: j.Updated || 0,
        creatorName: (j.Creator && j.Creator.Name) || '', creatorId: (j.Creator && j.Creator.Id) || ''
      };
    }
    // Reachable details + a real name only weakly implies "approved":
    // apply only when we currently know nothing (pending needs conf >= 2).
    var cur = DB.assets[String(id)];
    if (cur && cur.status === 'unknown' && rec.name && !/content deleted/i.test(rec.name)) {
      rec.status = 'approved'; rec.statusConfidence = 1; rec.rawStatus = 'economy:ok';
    }
    upsertAsset(rec, 'api:economy');
    return true;
  }

  /* Batched attempt at the creations details endpoint. Returns the set of
     ids for which an explicit (confidence 5) status was found. */
  async function batchExplicitCheck(ids) {
    var done = {};
    if (sessionFlags.itemConfigFails >= 2 || !ids.length) return done;
    var groups = chunk(ids, 50);
    for (var g = 0; g < groups.length; g++) {
      var r = await apiGetJSON('https://itemconfiguration.roblox.com/v1/creations/get-asset-details?assetIds=' + groups[g].join(','));
      if (!r.ok || !r.json) {
        if ([400, 401, 403, 404, 410].indexOf(r.status) !== -1) sessionFlags.itemConfigFails++;
        continue;
      }
      var recs = extractAll(r.json);
      for (var i = 0; i < recs.length; i++) {
        upsertAsset(recs[i], 'api:itemconfiguration');
        if (recs[i].status && (recs[i].statusConfidence || 0) >= 5) done[recs[i].id] = true;
      }
    }
    return done;
  }

  async function fetchExplicitDetails(id) {
    var tries = [
      { key: 'assetsApi', url: 'https://apis.roblox.com/assets/v1/assets/' + encodeURIComponent(id), label: 'api:assets' },
      { key: 'develop', url: 'https://develop.roblox.com/v1/assets/' + encodeURIComponent(id), label: 'api:develop' }
    ];
    for (var i = 0; i < tries.length; i++) {
      var t = tries[i];
      if (sessionFlags[t.key + 'Fails'] >= 2) continue;
      var r = await apiGetJSON(t.url);
      if (!r.ok || !r.json) {
        if ([400, 401, 403, 404, 410].indexOf(r.status) !== -1) sessionFlags[t.key + 'Fails']++;
        continue;
      }
      var recs = extractAll(r.json);
      for (var j = 0; j < recs.length; j++) {
        if (recs[j].id === String(id)) {
          upsertAsset(recs[j], t.label);
          if (recs[j].status && (recs[j].statusConfidence || 0) >= 5) return true;
        }
      }
    }
    return false;
  }

  function runPool(items, concurrency, worker, onProgress) {
    return new Promise(function (resolve) {
      var idx = 0, done = 0, active = 0;
      if (!items.length) { resolve(); return; }
      function next() {
        while (active < concurrency && idx < items.length) {
          (function (item) {
            active++;
            Promise.resolve().then(function () { return worker(item); }).catch(function () {}).then(async function () {
              active--; done++;
              if (onProgress) onProgress(done, items.length);
              await sleep(120);
              if (done >= items.length) resolve(); else next();
            });
          })(items[idx++]);
        }
      }
      next();
    });
  }

  /* ============================== re-check engine ============================== */
  async function recheckAssets(ids, reason, options) {
    options = options || {};
    if (recheckRunning) {
      if (!options.quiet) toast('A re-check is already running…');
      return 0;
    }
    ids = (ids || []).filter(function (id) { return !!DB.assets[id]; });
    if (!ids.length) { if (reason === 'manual') toast('Nothing to re-check.'); return 0; }
    recheckRunning = true;
    updateRecheckUI();
    log('recheck start (' + reason + ') for', ids.length, 'assets');
    try {
      await fetchThumbnails(ids, function (d, t) { recheckProgress = 'Thumbnails ' + d + '/' + t; updateStatusBar(); });
      var explicitDone = await batchExplicitCheck(ids);
      await runPool(ids, CONFIG.recheckConcurrency, async function (id) {
        var a = DB.assets[id]; if (!a) return;
        var explicit = !!explicitDone[id];
        if (!explicit) explicit = await fetchExplicitDetails(id);
        var b = DB.assets[id];
        // Approved/manual refreshes deliberately fetch economy details even
        // when fields already exist, so later name/description edits and a
        // [Content Deleted] name are noticed instead of only filling blanks.
        if (b && (options.refreshMetadata || !explicit || !b.description || !b.created || !b.name)) await fetchEconomyDetails(id);
        var c = DB.assets[id]; if (c) c.lastChecked = Date.now();
      }, function (d, t) { recheckProgress = 'Checking ' + d + '/' + t; updateStatusBar(); });
      lastRecheckAt = Date.now();
    } catch (e) { log('recheck error', e); }
    recheckRunning = false;
    recheckProgress = '';
    saveDBNow();
    afterDBChange();
    updateRecheckUI();
    scheduleRecheck();
    log('recheck done');
    return ids.length;
  }

  function pendingIds() {
    return Object.keys(DB.assets).filter(function (id) {
      var s = DB.assets[id].status;
      return s === 'pending' || (settings.recheckUnknown && s === 'unknown');
    }).sort(function (a, b) { return (DB.assets[a].lastChecked || 0) - (DB.assets[b].lastChecked || 0); });
  }

  function approvedIdsOldestFirst() {
    return Object.keys(DB.assets).filter(function (id) {
      return DB.assets[id].status === 'approved';
    }).sort(function (a, b) {
      var av = DB.assets[a].lastChecked || DB.assets[a].statusObservedAt || 0;
      var bv = DB.assets[b].lastChecked || DB.assets[b].statusObservedAt || 0;
      return av - bv;
    });
  }

  function staleApprovedIds(limit) {
    var hours = Number(settings.approvedRefreshHours) || 0;
    if (hours <= 0) return [];
    var cutoff = Date.now() - hours * 3600000;
    var ids = approvedIdsOldestFirst().filter(function (id) {
      var a = DB.assets[id];
      return (a.lastChecked || a.statusObservedAt || 0) <= cutoff;
    });
    return (limit && limit > 0) ? ids.slice(0, limit) : ids;
  }

  function refreshApprovedAssets(reason, options) {
    options = options || {};
    var ids;
    if (options.forceAll) ids = approvedIdsOldestFirst();
    else if (options.forceBatch) ids = approvedIdsOldestFirst().slice(0, options.limit || 100);
    else ids = staleApprovedIds(options.limit || CONFIG.approvedRefreshBatchSize);
    if (!ids.length) {
      if (options.manual) {
        toast(approvedIdsOldestFirst().length
          ? 'Approved assets are already within their refresh interval.'
          : 'No approved assets are currently tracked.');
      }
      return Promise.resolve(0);
    }
    if (options.announce) {
      toast('Refreshing ' + ids.length + ' approved asset(s), oldest-checked first, for current status/name/description…');
    }
    return recheckAssets(ids, reason || 'approved-refresh', {
      refreshMetadata: true,
      quiet: !!options.quiet
    });
  }

  async function recheckPending(reason) {
    var isAuto = /^auto/.test(String(reason || ''));
    var ids = pendingIds();
    if (ids.length) {
      await recheckAssets(ids, reason);
    } else {
      if (reason === 'manual') toast('No pending assets to re-check 🎉');
      scheduleRecheck();
    }
    // Approved records can later be removed/re-moderated or renamed. On the
    // normal auto wakeups, refresh only a bounded oldest-first stale batch;
    // recheckAssets reschedules the timer when this second pass finishes.
    if (isAuto && !recheckRunning) {
      var stale = staleApprovedIds(CONFIG.approvedRefreshBatchSize);
      if (stale.length) {
        await recheckAssets(stale, 'approved-auto', { refreshMetadata: true, quiet: true });
      }
    }
  }

  var recheckTimer = null;
  function scheduleRecheck() {
    if (recheckTimer) { clearTimeout(recheckTimer); recheckTimer = null; }
    nextRecheckAt = 0;
    var mins = Number(settings.recheckMinutes) || 0;
    var delayMins = mins > 0
      ? mins
      : (((Number(settings.approvedRefreshHours) || 0) > 0) ? CONFIG.approvedRefreshWakeMinutes : 0);
    if (delayMins <= 0) { updateStatusBar(); return; }
    nextRecheckAt = Date.now() + delayMins * 60000;
    recheckTimer = setTimeout(function () { recheckPending('auto'); }, delayMins * 60000);
    updateStatusBar();
  }

  /* ============================== description back-fill ============================== */
  var enrichQueue = [];
  var enrichRunning = false;
  function queueEnrich(id) {
    if (!settings.enrichDescriptions) return;
    var a = DB.assets[id]; if (!a) return;
    var needName = !a.name;
    var needDesc = !a.description && (!a.descCheckedAt || Date.now() - a.descCheckedAt > 86400000);
    if (!needName && !needDesc) return;
    if (enrichQueue.indexOf(id) === -1) enrichQueue.push(id);
    processEnrich();
  }
  async function processEnrich() {
    if (enrichRunning) return;
    enrichRunning = true;
    while (enrichQueue.length) {
      if (recheckRunning) { await sleep(1000); continue; }
      var id = enrichQueue.shift();
      var a = DB.assets[id];
      if (a && (!a.name || !a.description)) {
        await fetchEconomyDetails(id);
        var b = DB.assets[id]; if (b) b.descCheckedAt = Date.now();
        saveDBSoon();
      }
      await sleep(CONFIG.enrichDelayMs);
    }
    enrichRunning = false;
    afterDBChange();
  }

  /* ============================== DOM scanning patterns) ============================== */
  function typeFromPath(path) {
    var segs = String(path || '').toLowerCase().split('/').filter(Boolean);
    for (var i = segs.length - 1; i >= 0; i--) if (TYPE_BY_SEGMENT[segs[i]]) return TYPE_BY_SEGMENT[segs[i]];
    return '';
  }

  function extractIdFromHref(href) {
    if (!href) return null;
    var u;
    try { u = new URL(href, location.origin); } catch (e) { return null; }
    if (u.hostname.indexOf('roblox.com') === -1) return null;
    var path = u.pathname;
    if (/^\/(docs|learn|settings|account|notifications|users|profile|groups|search|home)\b/i.test(path)) return null;
    var full = path + u.search;
    var m;
    if ((m = full.match(/(?:library|catalog|store\/asset|assets?)\/(\d{4,})/i))) return { id: m[1], hintType: typeFromPath(path) };
    if ((m = u.search.match(/(?:assetId|itemId|asset_id)=([0-9]{4,})/))) return { id: m[1], hintType: typeFromPath(path) };
    if ((m = path.match(/\/places\/(\d{4,})/i))) return { id: m[1], hintType: 'Place' };
    if ((m = path.match(/\/(\d{5,})\/(?:configure|overview|details|edit|permissions|analytics|manage|store)\b/i))) return { id: m[1], hintType: typeFromPath(path) };
    if (/\/(creations|marketplace|development-items|avatar-items|configure)/i.test(path)) {
      var nums = [];
      var re = /\/(\d{5,})(?=\/|$)/g, mm;
      while ((mm = re.exec(path)) !== null) nums.push(mm[1]);
      if (nums.length) return { id: nums[nums.length - 1], hintType: typeFromPath(path) };
    }
    return null;
  }

  function guessPageType() {
    try {
      var u = new URL(location.href);
      var tab = u.searchParams.get('activeTab');
      if (tab) return prettyType(tab);
      var p = typeFromPath(u.pathname);
      if (p) return p;
    } catch (e) {}
    try {
      var el = document.querySelector('[aria-selected="true"], .Mui-selected, [data-selected="true"]');
      if (el) {
        var t = (el.textContent || '').trim().toLowerCase();
        if (TYPE_BY_SEGMENT[t]) return TYPE_BY_SEGMENT[t];
        if (/^(decal|image|audio|video|model|mesh|animation|plugin)s?$/.test(t)) return prettyType(t.replace(/s$/, ''));
      }
    } catch (e) {}
    return '';
  }

  function findCard(el) {
    var node = el, best = el, depth = 0;
    while (node && node.parentElement && depth < 8) {
      node = node.parentElement; depth++;
      var links = node.querySelectorAll ? node.querySelectorAll('a[href]') : [];
      var ids = {};
      for (var i = 0; i < links.length; i++) { var ex = extractIdFromHref(links[i].href); if (ex) ids[ex.id] = 1; }
      if (Object.keys(ids).length > 1) break;           // container of many cards — stop
      if ((node.innerText || '').length > 900) break;
      if (node.querySelector && node.querySelector('img')) best = node;
    }
    return best;
  }

  function scanStatusIn(root) {
    var approvedHit = null;
    var els = [root];
    try { els = els.concat([].slice.call(root.querySelectorAll('*'), 0, 200)); } catch (e) {}
    for (var i = 0; i < els.length; i++) {
      var el = els[i];
      if (!el || el.nodeType !== 1) continue;
      var texts = [];
      if (el.children && el.children.length === 0) texts.push((el.textContent || '').trim());
      if (el.getAttribute) {
        texts.push(el.getAttribute('aria-label') || '');
        texts.push(el.getAttribute('title') || '');
      }
      for (var j = 0; j < texts.length; j++) {
        var t = texts[j];
        if (!t || t.length > 48) continue;
        // Exact badge labels only. Do NOT substring-search arbitrary UI copy
        // or class names: words in navigation/help/warnings are not the
        // status of this specific asset.
        var s = statusFromBadgeText(t);
        if (s === 'moderated' || s === 'pending') return { status: s, raw: t };
        if (s === 'approved' && !approvedHit) approvedHit = { status: s, raw: t };
      }
    }
    return approvedHit;
  }

  function nameFromCard(card, anchor, img) {
    var GENERIC = { 'thumbnail': 1, 'asset thumbnail': 1, 'image': 1, 'asset image': 1, 'icon': 1 };
    function ok(t) {
      if (!t) return false;
      t = String(t).trim();
      if (t.length < 2 || t.length > 140) return false;
      if (/^\d+$/.test(t)) return false;
      if (GENERIC[t.toLowerCase()]) return false;
      if (statusFromBadgeText(t)) return false;
      return true;
    }
    var cands = [];
    if (img) cands.push(img.getAttribute('alt') || '');
    if (anchor && anchor.getAttribute) { cands.push(anchor.getAttribute('aria-label') || ''); cands.push(anchor.getAttribute('title') || ''); }
    var sel = card.querySelectorAll ? card.querySelectorAll('h1,h2,h3,h4,strong,b,[class*="title" i],[class*="name" i]') : [];
    for (var i = 0; i < sel.length && i < 8; i++) if (!sel[i].children.length) cands.push(sel[i].textContent || '');
    if (anchor) cands.push((anchor.textContent || '').split('\n')[0] || '');
    var lines = (card.innerText || '').split('\n');
    for (var l = 0; l < lines.length && l < 6; l++) cands.push(lines[l]);
    for (var c = 0; c < cands.length; c++) if (ok(cands[c])) return String(cands[c]).trim();
    return '';
  }

  /* Choose the largest URL an <img> advertises. React dashboards often put
     a tiny file in src while larger variants live in srcset. */
  function bestImageFromImg(img) {
    if (!img) return { url: '', width: 0 };
    var bestUrl = '', bestScore = -1;
    function consider(url, score) {
      if (!url || String(url).indexOf('data:') === 0) return;
      var clean = String(url).trim();
      if (!clean) return;
      var value = Number(score) || guessThumbnailWidth(clean, null) || 0;
      if (value > bestScore || (!bestUrl && value === bestScore)) { bestUrl = clean; bestScore = value; }
    }
    try {
      var srcset = img.getAttribute && (img.getAttribute('srcset') || img.getAttribute('data-srcset') || '');
      if (srcset) {
        srcset.split(',').forEach(function (part) {
          var bits = part.trim().split(/\s+/);
          var u = bits[0] || '';
          var descriptor = bits[1] || '';
          var score = 0;
          var wm = descriptor.match(/^(\d+)w$/i);
          var xm = descriptor.match(/^([\d.]+)x$/i);
          if (wm) score = Number(wm[1]);
          else if (xm) score = Number(xm[1]) * 250;
          consider(u, score);
        });
      }
    } catch (e) {}
    consider(img.currentSrc || '', img.naturalWidth || 0);
    consider(img.src || '', img.naturalWidth || 0);
    try {
      consider(img.getAttribute('src') || '', img.naturalWidth || 0);
      consider(img.getAttribute('data-src') || '', 0);
      consider(img.getAttribute('data-original') || '', 0);
    } catch (e) {}
    return { url: bestUrl, width: bestScore > 0 ? bestScore : (img.naturalWidth || 0) };
  }

  function extractFromCard(card, cand, pageType) {
    var img = null;
    if (card.querySelector) {
      img = card.querySelector('img[src*="rbxcdn"]') || card.querySelector('img[src]');
    }
    var bestThumb = bestImageFromImg(img);
    var st = scanStatusIn(card);
    return {
      id: cand.id,
      name: nameFromCard(card, cand.el, img),
      thumbnail: bestThumb.url,
      thumbnailWidth: bestThumb.width,
      type: cand.hintType || pageType || '',
      status: st ? st.status : null,
      statusConfidence: st ? 4 : 0,
      rawStatus: st ? st.raw : '',
      url: cand.el && cand.el.href ? cand.el.href : ''
    };
  }

  function currentDetailAssetId() {
    if (!/(configure|overview|details|edit|store\/asset|\/library\/|\/catalog\/)/i.test(location.pathname)) return '';
    var ex = extractIdFromHref(location.href);
    return ex ? String(ex.id) : '';
  }

  function scanCards(force) {
    var cands = [];
    var anchors = document.querySelectorAll('a[href]');
    var i;
    for (i = 0; i < anchors.length; i++) {
      var ex = extractIdFromHref(anchors[i].href);
      if (ex) cands.push({ el: anchors[i], id: ex.id, hintType: ex.hintType });
    }
    var dataEls = document.querySelectorAll('[data-asset-id],[data-item-id],[data-assetid],[data-itemid]');
    for (i = 0; i < dataEls.length; i++) {
      var el = dataEls[i];
      var did = el.getAttribute('data-asset-id') || el.getAttribute('data-item-id') || el.getAttribute('data-assetid') || el.getAttribute('data-itemid') || '';
      if (/^\d{4,}$/.test(did)) cands.push({ el: el, id: did, hintType: '' });
    }
    var sig = cands.map(function (c) { return c.id; }).join(',') + '@' + location.pathname + location.search;
    if (!force && sig === lastScanSignature) return 0;
    lastScanSignature = sig;
    var pageType = guessPageType();
    var detailId = currentDetailAssetId();
    var seen = {}, changed = 0;
    for (i = 0; i < cands.length; i++) {
      if (seen[cands[i].id]) continue;
      seen[cands[i].id] = 1;
      // On a configure/detail page, scanDetailPage below is authoritative
      // for the page's own asset. Generic card-context extraction around a
      // breadcrumb/self link can pick up unrelated moderation UI copy.
      if (detailId && String(cands[i].id) === detailId) continue;
      var card = findCard(cands[i].el);
      if (upsertAsset(extractFromCard(card, cands[i], pageType), 'page')) changed++;
    }
    if (cands.length) log('DOM scan candidates:', cands.length, 'changed:', changed, 'pageType:', pageType);
    return changed;
  }

  function scanDetailPage() {
    var detailId = currentDetailAssetId();
    if (!detailId) return 0;
    var ex = extractIdFromHref(location.href) || { id: detailId, hintType: '' };
    var main = document.querySelector('main') || document.body;
    if (!main) return 0;
    var name = '', desc = '';
    var inputs = main.querySelectorAll('input');
    for (var i = 0; i < inputs.length; i++) {
      var inp = inputs[i];
      var type = (inp.getAttribute('type') || 'text').toLowerCase();
      if (['text', ''].indexOf(type) === -1) continue;
      if (!inp.value || inp.value.length < 2) continue;
      var lab = '';
      try {
        if (inp.labels && inp.labels[0]) lab = inp.labels[0].textContent || '';
        else if (inp.closest) { var w = inp.closest('div,label'); lab = w ? (w.textContent || '').slice(0, 60) : ''; }
      } catch (e) {}
      var aria = (inp.getAttribute('aria-label') || '') + ' ' + (inp.getAttribute('placeholder') || '') + ' ' + lab;
      if (/name|title/i.test(aria)) { name = inp.value; break; }
      if (!name) name = inp.value; // first text input on configure pages is usually Name
    }
    var tas = main.querySelectorAll('textarea');
    if (tas.length && tas[0].value) desc = tas[0].value;
    if (!desc) {
      var dEl = main.querySelector('[class*="description" i]');
      if (dEl && (dEl.textContent || '').trim().length > 3) desc = dEl.textContent.trim().slice(0, 2000);
    }
    var detailImgs = main.querySelectorAll('img[src*="rbxcdn"],img[srcset*="rbxcdn"]');
    var bestDetailThumb = { url: '', width: 0 };
    for (var di = 0; di < detailImgs.length && di < 40; di++) {
      var candidateThumb = bestImageFromImg(detailImgs[di]);
      if (candidateThumb.width > bestDetailThumb.width) bestDetailThumb = candidateThumb;
      if (!bestDetailThumb.url && candidateThumb.url) bestDetailThumb = candidateThumb;
    }
    // IMPORTANT: do not infer moderation status from a configure/detail
    // page's DOM. Those pages contain navigation labels, deletion controls,
    // and policy/help text with words like "moderated" and "deleted" that
    // do not describe this asset. Status here comes from structured
    // dashboard/API data and rechecks; this scan only merges the actual
    // Name, Description, type, URL, and thumbnail fields. (The one
    // exception is inherent to upsertAsset: if the asset's actual Name
    // field itself is "[Content Deleted]", that is a real signal.)
    var sig = ex.id + '|' + name + '|' + desc.length + '|' + bestDetailThumb.url;
    if (sig === lastDetailSignature) return 0;
    lastDetailSignature = sig;
    var changed = upsertAsset({
      id: ex.id, name: name, description: desc,
      thumbnail: bestDetailThumb.url, thumbnailWidth: bestDetailThumb.width,
      type: ex.hintType || guessPageType(),
      status: null, statusConfidence: 0, rawStatus: '',
      url: location.href
    }, 'detail-page');
    return changed ? 1 : 0;
  }

  function scanPage(reason, force) {
    if (!document.body) return 0;
    // Central Auto-scan guard: all browsing/init/navigation/observer scans
    // stop when OFF, even if a future caller forgets to check the setting.
    // Explicit user actions pass force=true or reason='manual'.
    if (!settings.autoScan && !force && reason !== 'manual') return 0;
    lastScanAt = Date.now();
    var changed = 0;
    try { changed += scanCards(force); } catch (e) { log('scanCards error', e); }
    try { changed += scanDetailPage(); } catch (e) { log('scanDetail error', e); }
    if (changed) afterDBChange(); else updateStatusBar();
    if (reason === 'manual') toast(changed ? ('Scan found ' + changed + ' new/changed asset(s). Total tracked: ' + Object.keys(DB.assets).length) : 'Scan complete — no new assets on this page.');
    return changed;
  }

  /* ============================== export / import ============================== */
  function downloadFile(name, text, mime) {
    var blob = new Blob([text], { type: mime || 'application/json' });
    var u = URL.createObjectURL(blob);
    var a = document.createElement('a');
    a.href = u; a.download = name;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(function () { URL.revokeObjectURL(u); }, 4000);
  }
  function stamp() {
    var d = new Date(), p = function (n) { return String(n).padStart(2, '0'); };
    return d.getFullYear() + p(d.getMonth() + 1) + p(d.getDate()) + '-' + p(d.getHours()) + p(d.getMinutes());
  }
  function assetsForExport(ids) {
    var wanted = null;
    if (Array.isArray(ids)) {
      wanted = {};
      ids.forEach(function (id) { wanted[String(id)] = true; });
    }
    return Object.keys(DB.assets)
      .filter(function (id) { return !wanted || wanted[id]; })
      .map(function (id) { return DB.assets[id]; })
      .sort(function (a, b) { return Number(a.id) - Number(b.id); });
  }
  function countsForAssets(list) {
    var c = { all: 0, approved: 0, pending: 0, moderated: 0, unknown: 0 };
    (list || []).forEach(function (a) {
      c.all++;
      var s = a.status || 'unknown';
      if (c[s] === undefined) c[s] = 0;
      c[s]++;
    });
    return c;
  }
  function exportJSON(ids) {
    var selectedOnly = Array.isArray(ids);
    var list = assetsForExport(ids);
    downloadFile('roblox-asset-tracker' + (selectedOnly ? '-selected' : '') + '-' + stamp() + '.json',
      JSON.stringify({ exportedAt: new Date().toISOString(), version: 1, counts: countsForAssets(list), assets: list }, null, 2));
    toast('Exported ' + list.length + (selectedOnly ? ' selected' : '') + ' assets as JSON');
    return list.length;
  }
  function csvCell(v) { return '"' + String(v == null ? '' : v).replace(/"/g, '""') + '"'; }
  function exportCSV(ids) {
    var selectedOnly = Array.isArray(ids);
    var list = assetsForExport(ids);
    var rows = [['id', 'name', 'type', 'status', 'rawStatus', 'description', 'thumbnail', 'url', 'creator', 'created', 'firstSeen', 'lastSeen', 'lastChecked', 'lastStatusChange'].join(',')];
    list.forEach(function (a) {
      rows.push([a.id, a.name, a.type, a.status, a.rawStatus, a.description, a.thumbnail, openUrl(a), a.creatorName,
        a.created ? new Date(a.created).toISOString() : '', new Date(a.firstSeen).toISOString(),
        new Date(a.lastSeen).toISOString(), a.lastChecked ? new Date(a.lastChecked).toISOString() : '',
        a.lastStatusChange ? new Date(a.lastStatusChange).toISOString() : ''].map(csvCell).join(','));
    });
    downloadFile('roblox-asset-tracker' + (selectedOnly ? '-selected' : '') + '-' + stamp() + '.csv', rows.join('\r\n'), 'text/csv');
    toast('Exported ' + list.length + (selectedOnly ? ' selected' : '') + ' assets as CSV');
    return list.length;
  }
  var htmlExportRunning = false;

  function reportAssetCardHTML(a, index, displayThumbnail) {
    var statusText = { approved: '✔ Approved', pending: '⏳ Pending', moderated: '⛔ Moderated', unknown: '? Unknown' }[a.status] || '? Unknown';
    var searchText = (a.id + ' ' + (a.name || '') + ' ' + (a.description || '') + ' ' + (a.type || '') + ' ' + (a.creatorName || ''))
      .toLowerCase().replace(/\s+/g, ' ');
    var shownThumbnail = displayThumbnail || a.thumbnail || '';
    var img = shownThumbnail
      ? '<img src="' + esc(shownThumbnail) + '" alt="' + esc(a.name || ('Asset ' + a.id)) + ' thumbnail" width="420" height="420" ' +
        (index < 24 ? 'loading="eager" fetchpriority="high"' : 'loading="lazy" fetchpriority="low"') +
        ' decoding="async" referrerpolicy="no-referrer">'
      : '<div class="noimg" aria-label="No thumbnail available">🖼️</div>';
    return '<article class="asset" data-search="' + esc(searchText) + '">' +
      '<figure>' + img + '<span class="badge b-' + esc(a.status || 'unknown') + '">' + esc(statusText) + '</span>' +
      (a.isArchived ? '<span class="archived">Archived</span>' : '') + '</figure>' +
      '<div class="body">' +
        '<h3>' + esc(a.name || ('Asset ' + a.id)) + '</h3>' +
        '<div class="idrow"><span>Asset ID</span><code>' + esc(a.id) + '</code>' +
        '<button type="button" data-copy="' + esc(a.id) + '">Copy ID</button>' +
        '<button type="button" data-copy="rbxassetid://' + esc(a.id) + '">Copy rbxassetid</button></div>' +
        '<div class="desc">' + (a.description ? esc(a.description) : '<em>No description tracked.</em>') + '</div>' +
        '<dl>' +
          (a.type ? '<div><dt>Type</dt><dd>' + esc(a.type) + (a.typeId ? ' (#' + esc(a.typeId) + ')' : '') + '</dd></div>' : '') +
          (a.creatorName ? '<div><dt>Creator</dt><dd>' + esc(a.creatorName) + (a.creatorId ? ' (' + esc(a.creatorId) + ')' : '') + '</dd></div>' : '') +
          (a.created ? '<div><dt>Created</dt><dd>' + esc(fmtDate(a.created)) + '</dd></div>' : '') +
          (a.lastStatusChange ? '<div><dt>Status changed</dt><dd>' + esc(fmtDate(a.lastStatusChange)) + '</dd></div>' : '') +
          (a.rawStatus ? '<div><dt>Raw status</dt><dd>' + esc(a.rawStatus) + (a.statusSource ? ' · ' + esc(a.statusSource) : '') + '</dd></div>' : '') +
        '</dl>' +
        '<p class="links"><a href="' + esc(openUrl(a)) + '" target="_blank" rel="noopener">Open asset ↗</a>' +
        (a.thumbnail ? ' <a href="' + esc(a.thumbnail) + '" target="_blank" rel="noopener">Open thumbnail ↗</a>' : '') + '</p>' +
      '</div></article>';
  }

  function buildHTMLReport(thumbnailOverrides, ids) {
    var categories = [
      { key: 'approved', title: '✔ Approved' },
      { key: 'pending', title: '⏳ Pending' },
      { key: 'moderated', title: '⛔ Moderated' },
      { key: 'unknown', title: '? Unknown' }
    ];
    var all = assetsForExport(ids);
    var sorter = (typeof SORTERS !== 'undefined' && SORTERS[settings.sortBy]) || function (a, b) { return Number(a.id) - Number(b.id); };
    all.sort(sorter);
    var counts = countsForAssets(all);
    var css = [
      ':root{color-scheme:dark;--bg:#11141a;--panel:#1b202a;--card:#222936;--line:#354052;--text:#f3f6fa;--muted:#a9b5c5;--blue:#00a2ff}',
      '*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--text);font-family:"Segoe UI",system-ui,-apple-system,Arial,sans-serif}',
      'header{position:sticky;top:0;z-index:5;background:rgba(17,20,26,.96);border-bottom:1px solid var(--line);padding:18px clamp(14px,3vw,36px)}',
      'h1{margin:0 0 6px;font-size:clamp(22px,3vw,34px)}h2{font-size:24px;margin:0 0 14px}h3{font-size:16px;margin:0;line-height:1.35}',
      '.muted{color:var(--muted)}nav{display:flex;gap:8px;flex-wrap:wrap;margin-top:12px}nav a{color:var(--text);background:var(--panel);border:1px solid var(--line);padding:7px 11px;border-radius:999px;text-decoration:none;font-weight:650}',
      '#q{margin-top:12px;width:min(620px,100%);padding:10px 12px;border-radius:8px;border:1px solid var(--line);background:#0d1015;color:var(--text)}',
      'main{padding:24px clamp(14px,3vw,36px) 48px}section{margin:0 0 38px;scroll-margin-top:150px}.grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(265px,1fr));gap:14px}',
      '.asset{background:var(--card);border:1px solid var(--line);border-radius:12px;overflow:hidden;display:flex;flex-direction:column;min-width:0}',
      'figure{position:relative;margin:0;background:#090b0f;aspect-ratio:1/1;display:flex;align-items:center;justify-content:center;overflow:hidden}',
      'figure img{width:100%;height:100%;display:block;object-fit:contain}.noimg{font-size:54px;opacity:.45}',
      '.badge{position:absolute;left:9px;top:9px;color:white;font-weight:750;font-size:12px;padding:4px 8px;border-radius:999px}.b-approved{background:#16864b}.b-pending{background:#b97a08}.b-moderated{background:#b42318}.b-unknown{background:#5d6d7e}.archived{position:absolute;right:9px;top:9px;background:#000b;padding:3px 7px;border-radius:5px;font-size:11px}',
      '.body{padding:12px;display:flex;flex-direction:column;gap:10px;min-width:0}.idrow{display:flex;align-items:center;gap:6px;flex-wrap:wrap;color:var(--muted);font-size:12px}code{background:#10131a;color:#9fd8ff;padding:3px 6px;border-radius:5px;overflow-wrap:anywhere}',
      'button{background:#2b3444;color:var(--text);border:1px solid var(--line);border-radius:6px;padding:5px 7px;cursor:pointer}button:hover{border-color:var(--blue)}',
      '.desc{font-size:13px;line-height:1.5;white-space:pre-wrap;overflow-wrap:anywhere;color:#d7e0ea}.desc em{color:var(--muted)}',
      'dl{margin:0;display:grid;gap:5px;font-size:12px}dl div{display:grid;grid-template-columns:105px 1fr;gap:7px}dt{color:var(--muted)}dd{margin:0;overflow-wrap:anywhere}.links{margin:auto 0 0}.links a{color:#65c7ff;margin-right:12px}.empty{border:1px dashed var(--line);border-radius:10px;padding:22px;color:var(--muted)}',
      '@media print{header{position:static}#q,button{display:none}body{background:#fff;color:#111}.asset{break-inside:avoid}}'
    ].join('\n');
    var nav = categories.map(function (c) {
      return '<a href="#' + c.key + '">' + esc(c.title) + ' (' + (counts[c.key] || 0) + ')</a>';
    }).join('');
    var globalIndex = 0;
    var embeddedCount = 0;
    if (thumbnailOverrides) {
      all.forEach(function (a) { if (a.thumbnail && thumbnailOverrides[a.thumbnail]) embeddedCount++; });
    }
    var sections = categories.map(function (c) {
      var items = all.filter(function (a) { return (a.status || 'unknown') === c.key; });
      var cards = items.map(function (a) {
        return reportAssetCardHTML(a, globalIndex++, thumbnailOverrides && a.thumbnail ? thumbnailOverrides[a.thumbnail] : '');
      }).join('');
      return '<section id="' + c.key + '"><h2>' + esc(c.title) + ' <span class="muted">(' + items.length + ')</span></h2>' +
        (items.length ? '<div class="grid">' + cards + '</div>' : '<div class="empty">No assets in this category.</div>') + '</section>';
    }).join('\n');
    var reportScript = '<script>document.addEventListener("click",function(e){var b=e.target.closest("[data-copy]");if(!b)return;var t=b.getAttribute("data-copy"),old=b.textContent;function done(){b.textContent="Copied";setTimeout(function(){b.textContent=old},1200)}if(navigator.clipboard&&navigator.clipboard.writeText)navigator.clipboard.writeText(t).then(done).catch(done);else done()});var q=document.getElementById("q");if(q)q.addEventListener("input",function(){var v=q.value.trim().toLowerCase();document.querySelectorAll(".asset").forEach(function(c){c.style.display=(!v||c.getAttribute("data-search").indexOf(v)!==-1)?"":"none"})});</' + 'script>';
    return '<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">' +
      '<title>Roblox Creator Asset Tracker Report</title><style>' + css + '</style></head><body>' +
      '<header><h1>🗂️ Roblox Creator Asset Tracker Report</h1>' +
      '<div class="muted">Generated ' + esc(fmtDate(Date.now())) + ' · ' + counts.all + (Array.isArray(ids) ? ' selected' : ' unique') + ' assets · ' +
      counts.approved + ' approved · ' + counts.pending + ' pending · ' + counts.moderated + ' moderated · ' + counts.unknown + ' unknown</div>' +
      '<div class="muted">Grouped by moderation category. Within each category, assets use the tracker\'s currently selected sort order. ' +
      (embeddedCount ? embeddedCount + ' thumbnail(s) are embedded directly in this HTML file; any remaining thumbnails load from Roblox\'s CDN.' : 'Thumbnails load from Roblox\'s CDN, so an internet connection is required for images.') + '</div>' +
      '<nav>' + nav + '</nav><input id="q" type="search" placeholder="Filter this report by name, description, type, or Asset ID…"></header>' +
      '<main>' + sections + '</main>' + reportScript + '</body></html>';
  }

  var htmlExportProgress = '';

  function blobToDataUrl(blob) {
    return new Promise(function (resolve) {
      try {
        var reader = new FileReader();
        reader.onload = function () { resolve(String(reader.result || '')); };
        reader.onerror = function () { resolve(''); };
        reader.readAsDataURL(blob);
      } catch (e) { resolve(''); }
    });
  }

  async function normalizeImageBlob(blob) {
    if (!blob || !blob.size || blob.size > 2500000) return null;
    var type = String(blob.type || '').toLowerCase();
    if (type.indexOf('image/') === 0) return blob;
    try {
      var headBuffer = await blob.slice(0, 12).arrayBuffer();
      var h = new Uint8Array(headBuffer);
      if (h.length >= 8 && h[0] === 137 && h[1] === 80 && h[2] === 78 && h[3] === 71) type = 'image/png';
      else if (h.length >= 3 && h[0] === 255 && h[1] === 216 && h[2] === 255) type = 'image/jpeg';
      else if (h.length >= 6 && h[0] === 71 && h[1] === 73 && h[2] === 70) type = 'image/gif';
      else if (h.length >= 12 && h[0] === 82 && h[1] === 73 && h[2] === 70 && h[3] === 70 && h[8] === 87 && h[9] === 69 && h[10] === 66 && h[11] === 80) type = 'image/webp';
      else return null;
      return new Blob([blob], { type: type });
    } catch (e) {
      return null;
    }
  }

  function gmFetchBlob(url) {
    return new Promise(function (resolve) {
      try {
        GM_xmlhttpRequest({
          method: 'GET', url: url, responseType: 'blob', anonymous: true,
          headers: { 'Accept': 'image/avif,image/webp,image/png,image/jpeg,image/*,*/*' },
          onload: function (r) { resolve((r.status >= 200 && r.status < 300) ? r.response : null); },
          onerror: function () { resolve(null); },
          ontimeout: function () { resolve(null); }
        });
      } catch (e) { resolve(null); }
    });
  }

  async function fetchThumbnailDataUrl(url) {
    if (!url) return '';
    if (String(url).indexOf('data:image/') === 0) return String(url);
    var blob = null;
    try {
      var response = await fetch(url, { credentials: 'omit', referrerPolicy: 'no-referrer', headers: { 'Accept': 'image/avif,image/webp,image/png,image/jpeg,image/*,*/*' } });
      if (response.ok) blob = await response.blob();
    } catch (e) {}
    if (!blob && typeof GM_xmlhttpRequest === 'function') blob = await gmFetchBlob(url);
    blob = await normalizeImageBlob(blob);
    return blob ? blobToDataUrl(blob) : '';
  }

  async function exportHTML(ids) {
    if (htmlExportRunning) { toast('An HTML export is already being prepared…'); return; }
    var selectedOnly = Array.isArray(ids);
    ids = assetsForExport(ids).map(function (a) { return a.id; });
    if (!ids.length) { toast(selectedOnly ? 'No selected assets to export.' : 'No assets to export yet.'); return; }
    htmlExportRunning = true;
    htmlExportProgress = 'Preparing HTML export…';
    updateStatusBar();
    try {
      if (settings.highResThumbnails) {
        var needIds = ids.filter(function (id) { return needsHighResThumbnail(DB.assets[id]); });
        if (needIds.length) {
          toast('Preparing HTML export: loading ' + needIds.length + ' high-resolution thumbnail(s)…');
          await fetchThumbnails(needIds, function (done, total) {
            htmlExportProgress = 'HTML export: high-resolution thumbnails ' + done + '/' + total;
            updateStatusBar();
          });
          saveDBNow();
          afterDBChange();
        }
      }

      // Embed each distinct thumbnail directly into the HTML when it can be
      // fetched safely. A per-image/total cap prevents an enormous report;
      // anything not embedded keeps its normal Roblox CDN URL as fallback.
      var thumbUrls = [];
      var seenThumbUrls = {};
      ids.forEach(function (id) {
        var u = DB.assets[id] && DB.assets[id].thumbnail;
        if (u && !seenThumbUrls[u]) { seenThumbUrls[u] = true; thumbUrls.push(u); }
      });
      var overrides = {};
      var embeddedChars = 0;
      var embeddedUrls = 0;
      if (thumbUrls.length) {
        htmlExportProgress = 'HTML export: embedding thumbnails 0/' + thumbUrls.length;
        updateStatusBar();
        await runPool(thumbUrls, 4, async function (url) {
          if (embeddedChars >= 60000000) return;
          var dataUrl = await fetchThumbnailDataUrl(url);
          if (dataUrl && dataUrl.indexOf('data:image/') === 0 && embeddedChars + dataUrl.length <= 60000000) {
            overrides[url] = dataUrl;
            embeddedChars += dataUrl.length;
            embeddedUrls++;
          }
        }, function (done, total) {
          htmlExportProgress = 'HTML export: embedding thumbnails ' + done + '/' + total;
          updateStatusBar();
        });
      }

      htmlExportProgress = 'HTML export: building report…';
      updateStatusBar();
      downloadFile('roblox-asset-tracker-report' + (selectedOnly ? '-selected' : '') + '-' + stamp() + '.html', buildHTMLReport(overrides, selectedOnly ? ids : undefined), 'text/html;charset=utf-8');
      toast('Exported categorized HTML report with ' + ids.length + (selectedOnly ? ' selected' : '') + ' assets' +
        (embeddedUrls ? ' (' + embeddedUrls + ' thumbnail image(s) embedded; others use Roblox CDN fallback)' : ''));
    } catch (e) {
      log('HTML export failed', e);
      toast('HTML export failed — see console/[RCAT] debug log.');
    } finally {
      htmlExportRunning = false;
      htmlExportProgress = '';
      updateStatusBar();
    }
  }

  function importJSON(text) {
    var data;
    try { data = JSON.parse(text); } catch (e) { toast('Import failed: invalid JSON'); return; }
    var list = Array.isArray(data) ? data : (Array.isArray(data.assets) ? data.assets : (data.assets ? Object.keys(data.assets).map(function (k) { return data.assets[k]; }) : []));
    var n = 0;
    list.forEach(function (r) {
      if (!r || !r.id) return;
      if (upsertAsset({
        id: r.id, name: r.name || '', description: r.description || '', thumbnail: r.thumbnail || '',
        thumbnailWidth: r.thumbnailWidth || 0, thumbnailCheckedAt: r.thumbnailCheckedAt || 0,
        type: r.type || '', typeId: r.typeId || 0, created: r.created || 0, updated: r.updated || 0,
        creatorName: r.creatorName || '', creatorId: r.creatorId || '', isArchived: r.isArchived,
        status: ['approved', 'pending', 'moderated'].indexOf(r.status) !== -1 ? r.status : null,
        statusConfidence: r.statusConfidence || 3, rawStatus: r.rawStatus || 'import', url: r.pageUrl || ''
      }, 'import')) n++;
    });
    saveDBNow(); afterDBChange();
    toast('Imported/updated ' + n + ' asset(s) from ' + list.length + ' records.');
  }

  /* ============================== manual ID/link add ============================== */
  function normalizeManualAssetId(value) {
    if (typeof value === 'number') {
      if (!isFinite(value) || Math.floor(value) !== value || value <= 0) return '';
      value = String(value);
    }
    var s = String(value == null ? '' : value).trim();
    if (!/^\d+$/.test(s)) return '';
    s = s.replace(/^0+(?=\d)/, '');
    return (s.length >= 4 && s.length <= 20 && !/^0+$/.test(s)) ? s : '';
  }

  function cleanManualToken(token) {
    var s = String(token == null ? '' : token).trim().replace(/&amp;/gi, '&');
    try { if (/%3a%2f%2f/i.test(s)) s = decodeURIComponent(s); } catch (e) {}
    s = s.replace(/^[{\[(<"'`]+/, '').replace(/[}\])>"'`]+$/, '');
    s = s.replace(/[.,;:]+$/, '');
    s = s.replace(/^[{\[(<"'`]+/, '').replace(/[}\])>"'`]+$/, '');
    return s.trim();
  }

  function extractManualAssetFromLink(raw) {
    var original = cleanManualToken(raw);
    if (!original) return null;
    var rbx = original.match(/rbxassetid:\/\/(\d{1,20})/i);
    if (rbx) {
      var rbxId = normalizeManualAssetId(rbx[1]);
      return rbxId ? { id: rbxId, url: '', type: '', kind: 'rbxassetid', sourceText: original } : null;
    }

    var href = original;
    if (/^www\./i.test(href)) href = 'https://' + href;
    else if (/^(create|www|apis|assetdelivery|economy|thumbnails|itemconfiguration)\.roblox\.com\//i.test(href)) href = 'https://' + href;
    else if (/^roblox\.com\//i.test(href)) href = 'https://www.' + href;

    var u;
    try { u = new URL(href, location.origin); } catch (e) { return null; }
    var host = String(u.hostname || '').toLowerCase();
    var isPathOnly = original.charAt(0) === '/';
    if (!isPathOnly && host !== 'roblox.com' && !/\.roblox\.com$/.test(host)) return null;

    var path = u.pathname || '';
    try {
      var existing = extractIdFromHref(u.href);
      if (existing) {
        var existingId = normalizeManualAssetId(existing.id);
        if (existingId) {
          return {
            id: existingId, url: u.href, type: existing.hintType || typeFromPath(path),
            kind: 'link', sourceText: original
          };
        }
      }
    } catch (e) {}

    var segs = path.split('/').filter(Boolean).map(function (seg) {
      try { return decodeURIComponent(seg); } catch (e) { return seg; }
    });
    var lower = segs.map(function (seg) { return String(seg).toLowerCase(); });
    var badSegments = {
      users: 1, user: 1, profile: 1, groups: 1, group: 1, communities: 1,
      friends: 1, docs: 1, learn: 1, settings: 1, account: 1,
      notifications: 1, search: 1, home: 1
    };
    if (lower.some(function (seg) { return !!badSegments[seg]; })) return null;

    var queryId = '';
    try {
      var wanted = { assetid: 1, itemid: 1, targetid: 1, asset_id: 1, item_id: 1 };
      u.searchParams.forEach(function (val, key) {
        if (!queryId && wanted[String(key).toLowerCase()]) queryId = normalizeManualAssetId(val);
      });
      if (!queryId) {
        var genericId = u.searchParams.get('id');
        if (genericId && /(asset|catalog|library|item|store|creations|marketplace|configure|avatar|assetdelivery)/i.test(path + ' ' + host)) {
          queryId = normalizeManualAssetId(genericId);
        }
      }
    } catch (e) {}
    if (queryId) {
      return { id: queryId, url: u.href, type: typeFromPath(path), kind: 'link', sourceText: original };
    }

    var assetSegments = {
      asset: 1, assets: 1, catalog: 1, library: 1, item: 1, items: 1,
      place: 1, places: 1, game: 1, games: 1
    };
    for (var i = 0; i < lower.length - 1; i++) {
      var nextId = normalizeManualAssetId(segs[i + 1]);
      if (!nextId) continue;
      if (assetSegments[lower[i]] || TYPE_BY_SEGMENT[lower[i]]) {
        return {
          id: nextId, url: u.href,
          type: (lower[i] === 'game' || lower[i] === 'games' || lower[i] === 'place' || lower[i] === 'places')
            ? 'Place' : (TYPE_BY_SEGMENT[lower[i]] || typeFromPath(path)),
          kind: 'link', sourceText: original
        };
      }
    }

    if (/(dashboard|creations|marketplace|avatar-items|development-items|configure|store|catalog|library|asset|item)/i.test(path)) {
      for (var j = segs.length - 1; j >= 0; j--) {
        var segId = normalizeManualAssetId(segs[j]);
        if (segId && !/^v\d+$/i.test(segs[j - 1] || '')) {
          return { id: segId, url: u.href, type: typeFromPath(path), kind: 'link', sourceText: original };
        }
      }
    }
    return null;
  }

  function manualEntryFromToken(token) {
    var s = cleanManualToken(token);
    if (!s) return null;
    var pureId = normalizeManualAssetId(s);
    if (pureId) return { id: pureId, url: '', type: '', kind: 'id', sourceText: s };

    var rbx = s.match(/rbxassetid:\/\/(\d{1,20})/i);
    if (rbx) {
      var rbxId = normalizeManualAssetId(rbx[1]);
      return rbxId ? { id: rbxId, url: '', type: '', kind: 'rbxassetid', sourceText: s } : null;
    }

    var labelled = s.match(/^(?:asset\s*id|item\s*id|assetid|itemid|targetid|asset_id|item_id|id)\s*[:=#-]?\s*(\d{1,20})$/i);
    if (labelled) {
      var labelledId = normalizeManualAssetId(labelled[1]);
      return labelledId ? { id: labelledId, url: '', type: '', kind: 'id', sourceText: s } : null;
    }

    if (/^(https?:)?\/\//i.test(s) || /^www\./i.test(s) || /(^|\.)roblox\.com\//i.test(s) || s.charAt(0) === '/' || /\//.test(s)) {
      return extractManualAssetFromLink(s);
    }
    return null;
  }

  function createManualParseState() {
    return {
      entries: [], byId: {}, candidateCount: 0, duplicateCount: 0,
      invalidCount: 0, invalidExamples: [], inputTruncated: false
    };
  }

  function addManualParsedEntry(state, entry, raw) {
    state.candidateCount++;
    var id = entry ? normalizeManualAssetId(entry.id) : '';
    if (!id) {
      state.invalidCount++;
      if (state.invalidExamples.length < 8 && raw != null && String(raw).trim()) {
        state.invalidExamples.push(String(raw).slice(0, 120));
      }
      return false;
    }
    var existing = state.byId[id];
    if (existing) {
      state.duplicateCount++;
      if (!existing.url && entry.url) existing.url = String(entry.url);
      if (!existing.type && entry.type) existing.type = String(entry.type);
      if (existing.kind === 'id' && entry.kind && entry.kind !== 'id') existing.kind = String(entry.kind);
      return false;
    }
    var clean = {
      id: id,
      url: entry.url ? String(entry.url) : '',
      type: entry.type ? String(entry.type) : '',
      kind: entry.kind ? String(entry.kind) : 'id',
      sourceText: entry.sourceText ? String(entry.sourceText) : String(raw == null ? id : raw)
    };
    state.byId[id] = clean;
    state.entries.push(clean);
    return true;
  }

  function addManualCandidate(state, raw) {
    return addManualParsedEntry(state, manualEntryFromToken(raw), raw);
  }

  function finishManualParse(state, format) {
    var entries = state.entries.map(function (e) { return Object.assign({}, e); });
    return {
      entries: entries,
      ids: entries.map(function (e) { return e.id; }),
      candidateCount: state.candidateCount,
      duplicateCount: state.duplicateCount,
      invalidCount: state.invalidCount,
      invalidExamples: state.invalidExamples.slice(),
      inputTruncated: !!state.inputTruncated,
      format: format || 'text'
    };
  }

  function manualJSONKey(key) {
    return String(key || '').toLowerCase().replace(/[^a-z0-9]/g, '');
  }

  function collectManualJSONValue(value, state, depth) {
    if (depth > 12 || value == null) return;
    if (typeof value === 'number' || typeof value === 'string') {
      addManualCandidate(state, value);
      return;
    }
    if (Array.isArray(value)) {
      value.forEach(function (item) { collectManualJSONValue(item, state, depth + 1); });
      return;
    }
    if (typeof value !== 'object') return;

    var keyMap = {};
    Object.keys(value).forEach(function (k) { keyMap[manualJSONKey(k)] = value[k]; });

    if (keyMap.assets !== undefined) {
      var assetsValue = keyMap.assets;
      if (Array.isArray(assetsValue)) {
        collectManualJSONValue(assetsValue, state, depth + 1);
      } else if (assetsValue && typeof assetsValue === 'object') {
        Object.keys(assetsValue).forEach(function (k) {
          var rec = assetsValue[k];
          if (rec && typeof rec === 'object' && !Array.isArray(rec)) {
            var before = state.candidateCount;
            collectManualJSONValue(rec, state, depth + 1);
            if (state.candidateCount === before) addManualCandidate(state, k);
          } else addManualCandidate(state, k);
        });
      }
      return;
    }

    var idVal;
    ['assetid', 'itemid', 'targetid', 'id'].forEach(function (k) {
      if (idVal === undefined && keyMap[k] !== undefined) idVal = keyMap[k];
    });
    var urlVal;
    ['pageurl', 'asseturl', 'url', 'link', 'href'].forEach(function (k) {
      if (urlVal === undefined && typeof keyMap[k] === 'string') urlVal = keyMap[k];
    });
    if (idVal !== undefined || urlVal !== undefined) {
      var fromUrl = urlVal ? manualEntryFromToken(urlVal) : null;
      var jsonId = normalizeManualAssetId(idVal) || (fromUrl ? fromUrl.id : '');
      var typeVal = keyMap.type || keyMap.assettype || keyMap.assettypename || '';
      addManualParsedEntry(state, jsonId ? {
        id: jsonId,
        url: urlVal || (fromUrl ? fromUrl.url : ''),
        type: typeVal ? prettyType(typeVal) : (fromUrl ? fromUrl.type : ''),
        kind: urlVal ? 'link' : 'id',
        sourceText: urlVal || jsonId
      } : null, urlVal !== undefined ? urlVal : idVal);
      return;
    }

    var objectKeys = Object.keys(value);
    var idKeys = objectKeys.filter(function (k) { return !!normalizeManualAssetId(k); });
    if (idKeys.length && idKeys.length >= Math.ceil(objectKeys.length / 2)) {
      idKeys.forEach(function (k) { addManualCandidate(state, k); });
      return;
    }

    var foundList = false;
    ['ids', 'assetids', 'itemids', 'links', 'urls', 'data', 'items', 'results', 'records'].forEach(function (k) {
      if (keyMap[k] !== undefined) {
        foundList = true;
        collectManualJSONValue(keyMap[k], state, depth + 1);
      }
    });
    if (foundList) return;

    objectKeys.forEach(function (k) {
      var nk = manualJSONKey(k);
      if (['creator', 'owner', 'user', 'group', 'counts', 'count'].indexOf(nk) !== -1) return;
      var child = value[k];
      if (child && typeof child === 'object') collectManualJSONValue(child, state, depth + 1);
    });
  }

  function parseDelimitedRows(text, delimiter) {
    var rows = [], row = [], field = '', inQuotes = false;
    function endField() { row.push(field); field = ''; }
    function endRow() {
      endField();
      if (row.some(function (cell) { return String(cell).trim() !== ''; })) rows.push(row);
      row = [];
    }
    for (var i = 0; i < text.length; i++) {
      var ch = text.charAt(i);
      if (inQuotes) {
        if (ch === '"') {
          if (text.charAt(i + 1) === '"') { field += '"'; i++; }
          else inQuotes = false;
        } else field += ch;
      } else if (ch === '"' && field === '') {
        inQuotes = true;
      } else if (ch === delimiter) {
        endField();
      } else if (ch === '\n') {
        endRow();
      } else if (ch !== '\r') {
        field += ch;
      }
    }
    if (field !== '' || row.length) endRow();
    return rows;
  }

  function manualEntriesFromDelimitedTable(text, state) {
    var firstLine = '';
    String(text).split(/\r?\n/).some(function (line) {
      if (String(line).trim()) { firstLine = String(line); return true; }
      return false;
    });
    if (!firstLine) return false;
    var delimiter = firstLine.indexOf('\t') !== -1 ? '\t' :
      ((firstLine.split(';').length > firstLine.split(',').length) ? ';' : ',');
    if (firstLine.indexOf(delimiter) === -1) return false;
    var rows = parseDelimitedRows(String(text), delimiter);
    if (rows.length < 2) return false;
    var headers = rows[0].map(manualJSONKey);
    function findHeader(names) {
      for (var i = 0; i < headers.length; i++) if (names.indexOf(headers[i]) !== -1) return i;
      return -1;
    }
    var idIdx = findHeader(['id', 'assetid', 'itemid', 'targetid']);
    var urlIdx = findHeader(['url', 'link', 'href', 'pageurl', 'asseturl']);
    if (idIdx === -1 && urlIdx === -1) return false;
    rows.slice(1).forEach(function (row) {
      var rawId = idIdx >= 0 ? row[idIdx] : '';
      var rawUrl = urlIdx >= 0 ? row[urlIdx] : '';
      var entry = manualEntryFromToken(rawId) || manualEntryFromToken(rawUrl);
      addManualParsedEntry(state, entry, rawId || rawUrl);
    });
    return true;
  }

  function parseManualTextList(text, state) {
    String(text).split(/\r?\n/).forEach(function (rawLine) {
      var line = String(rawLine || '').trim();
      if (!line) return;
      if (/^(?:asset\s*id|item\s*id|assetid|itemid|assetids|id|links?|urls?)\s*:?$/i.test(line)) return;

      var urlPattern = /(?:rbxassetid:\/\/\d{1,20}|https?:\/\/[^\s<>"',;]+|www\.[^\s<>"',;]+|(?:create|www|assetdelivery)\.roblox\.com\/[^\s<>"',;]+)/gi;
      var urls = line.match(urlPattern) || [];
      urls.forEach(function (u) { addManualCandidate(state, u); });
      urlPattern.lastIndex = 0;
      var rest = line.replace(urlPattern, ' ');

      var labelledPattern = /(?:asset\s*id|item\s*id|assetid|itemid|targetid|asset_id|item_id)\s*[:=#-]?\s*(\d{1,20})/gi;
      rest = rest.replace(labelledPattern, function (_m, id) {
        addManualCandidate(state, id);
        return ' ';
      });

      rest.split(/[\s,;|]+/).forEach(function (tok) {
        if (tok) addManualCandidate(state, tok);
      });
    });
  }

  function parseManualAssetEntries(input, options) {
    options = options || {};
    var state = createManualParseState();

    if (Array.isArray(input)) {
      input.forEach(function (item) {
        if (item && typeof item === 'object') collectManualJSONValue(item, state, 0);
        else if (typeof item === 'string' && /[\r\n,;]/.test(item)) parseManualTextList(item, state);
        else addManualCandidate(state, item);
      });
      return finishManualParse(state, 'array');
    }
    if (input && typeof input === 'object') {
      collectManualJSONValue(input, state, 0);
      return finishManualParse(state, 'json');
    }

    var text = input == null ? '' : String(input);
    var maxChars = Number(options.maxChars) || CONFIG.manualAddFileMaxBytes || 5242880;
    if (maxChars > 0 && text.length > maxChars) {
      text = text.slice(0, maxChars);
      state.inputTruncated = true;
    }

    var trimmed = text.trim();
    if (trimmed.charAt(0) === '{' || trimmed.charAt(0) === '[') {
      try {
        collectManualJSONValue(JSON.parse(trimmed), state, 0);
        return finishManualParse(state, 'json');
      } catch (e) {
        // A bracketed hand-written list can still be parsed as text below.
      }
    }
    if (manualEntriesFromDelimitedTable(text, state)) return finishManualParse(state, 'delimited');
    parseManualTextList(text, state);
    return finishManualParse(state, 'text');
  }

  function manualAddSummaryText(result) {
    if (!result) return 'No assets were added.';
    var bits = [];
    if (result.newIds && result.newIds.length) bits.push('Added ' + result.newIds.length + ' new');
    if (result.existingIds && result.existingIds.length) bits.push(result.existingIds.length + ' already tracked');
    if (result.checkedCount) bits.push('checked ' + result.checkedCount);
    if (result.checkedCount && result.categoryCounts) {
      var cats = [];
      if (result.categoryCounts.approved) cats.push(result.categoryCounts.approved + ' approved');
      if (result.categoryCounts.pending) cats.push(result.categoryCounts.pending + ' pending');
      if (result.categoryCounts.moderated) cats.push(result.categoryCounts.moderated + ' moderated');
      if (result.categoryCounts.unknown) cats.push(result.categoryCounts.unknown + ' unknown');
      if (cats.length) bits.push('Categories: ' + cats.join(', '));
    }
    if (result.removedDuringCheckIds && result.removedDuringCheckIds.length) {
      bits.push(result.removedDuringCheckIds.length + ' removed by “Don’t log moderated assets”');
    }
    if (result.blockedIds && result.blockedIds.length) bits.push('skipped ' + result.blockedIds.length + ' on removed list');
    if (result.unblockedIds && result.unblockedIds.length) bits.push('re-added ' + result.unblockedIds.length + ' from removed list');
    if (result.parsed && result.parsed.duplicateCount) bits.push(result.parsed.duplicateCount + ' duplicate(s) ignored');
    if (result.parsed && result.parsed.invalidCount) bits.push(result.parsed.invalidCount + ' unrecognized entr' + (result.parsed.invalidCount === 1 ? 'y' : 'ies'));
    if (result.truncatedCount) bits.push(result.truncatedCount + ' beyond the per-add limit were not processed');
    if (result.parsed && result.parsed.inputTruncated) bits.push('input was truncated at the safety limit');
    return bits.length ? bits.join(' · ') + '.' : 'No recognized asset IDs or Roblox asset links were found.';
  }

  async function addManualAssets(input, options) {
    options = options || {};
    var parsed = parseManualAssetEntries(input, options);
    var limit = Number(options.limit) || CONFIG.manualAddLimit || 5000;
    if (!(limit > 0)) limit = CONFIG.manualAddLimit || 5000;
    var entries = parsed.entries.slice(0, limit);
    var result = {
      parsed: parsed,
      parsedUniqueCount: parsed.entries.length,
      truncatedCount: Math.max(0, parsed.entries.length - entries.length),
      acceptedIds: [], newIds: [], existingIds: [], blockedIds: [],
      unblockedIds: [], skippedIds: [], checkedCount: 0,
      stillTrackedIds: [], removedDuringCheckIds: [],
      categoryCounts: { all: 0, approved: 0, pending: 0, moderated: 0, unknown: 0 }
    };
    result.counts = result.categoryCounts;

    if (!entries.length) {
      if (options.announce !== false) toast('No recognized asset IDs or Roblox asset links were found.');
      result.summary = manualAddSummaryText(result);
      return result;
    }

    entries.forEach(function (entry) {
      var id = String(entry.id);
      if (DB.ignored[id]) {
        if (options.includeBlocked) {
          delete DB.ignored[id];
          result.unblockedIds.push(id);
        } else {
          result.blockedIds.push(id);
          return;
        }
      }
      var before = DB.assets[id];
      var existed = !!before;
      upsertAsset({
        id: id,
        url: entry.url || '',
        type: (before && before.type) ? '' : (entry.type || '')
      }, options.source || 'manual:add');
      if (DB.assets[id]) {
        result.acceptedIds.push(id);
        if (existed) result.existingIds.push(id);
        else result.newIds.push(id);
      } else {
        result.skippedIds.push(id);
      }
    });

    saveDBNow();
    renderAll();

    if (options.selectAdded && result.acceptedIds.length) {
      pruneSelection();
      result.acceptedIds.forEach(function (id) { ui.selectedIds.add(String(id)); });
      ui.lastSelectedId = result.acceptedIds[result.acceptedIds.length - 1];
      syncSelectionUI();
    }

    if (options.check !== false && result.acceptedIds.length) {
      while (recheckRunning) await sleep(300);
      result.checkedCount = await recheckAssets(result.acceptedIds.slice(), options.reason || 'manual-add', {
        refreshMetadata: true,
        quiet: !!options.quietRecheck
      });
    }

    result.stillTrackedIds = result.acceptedIds.filter(function (id) { return !!DB.assets[id]; });
    result.removedDuringCheckIds = result.acceptedIds.filter(function (id) { return !DB.assets[id]; });
    result.categoryCounts = countsForAssets(assetsForExport(result.stillTrackedIds));
    result.counts = result.categoryCounts;
    result.summary = manualAddSummaryText(result);
    if (options.announce !== false) toast(result.summary, 9000);
    log('manual add:', result.summary, 'accepted:', result.acceptedIds.length, 'checked:', result.checkedCount);
    return result;
  }

  async function copyText(t, label) {
    var done = false;
    try { await navigator.clipboard.writeText(t); done = true; } catch (e) {}
    if (!done) {
      try { if (typeof GM_setClipboard === 'function') { GM_setClipboard(t); done = true; } } catch (e) {}
    }
    if (!done) {
      try {
        var ta = document.createElement('textarea');
        ta.value = t; ta.style.position = 'fixed'; ta.style.opacity = '0';
        document.body.appendChild(ta); ta.select();
        document.execCommand('copy'); ta.remove(); done = true;
      } catch (e) {}
    }
    toast(done ? (label || 'Copied to clipboard') : 'Copy failed');
  }

  /* ============================== derived data ============================== */
  function countByStatus() {
    var c = { all: 0, approved: 0, pending: 0, moderated: 0, unknown: 0 };
    Object.keys(DB.assets).forEach(function (id) {
      c.all++;
      var s = DB.assets[id].status || 'unknown';
      if (c[s] === undefined) c[s] = 0;
      c[s]++;
    });
    return c;
  }
  function openUrl(a) {
    return a.pageUrl || ('https://www.roblox.com/library/' + a.id + '/-');
  }
  var SORTERS = {
    'updated-desc': function (a, b) { return (b.lastStatusChange || b.lastSeen) - (a.lastStatusChange || a.lastSeen); },
    'created-desc': function (a, b) { return ((b.created || b.firstSeen) - (a.created || a.firstSeen)); },
    'created-asc': function (a, b) { return ((a.created || a.firstSeen) - (b.created || b.firstSeen)); },
    'name-asc': function (a, b) { return (a.name || a.id).localeCompare(b.name || b.id); },
    'name-desc': function (a, b) { return (b.name || b.id).localeCompare(a.name || a.id); },
    'id-desc': function (a, b) { return Number(b.id) - Number(a.id); },
    'id-asc': function (a, b) { return Number(a.id) - Number(b.id); },
    'status': function (a, b) {
      var order = { pending: 0, moderated: 1, unknown: 2, approved: 3 };
      var d = (order[a.status] || 9) - (order[b.status] || 9);
      return d !== 0 ? d : (b.lastStatusChange || 0) - (a.lastStatusChange || 0);
    },
    'type': function (a, b) { var d = (a.type || '').localeCompare(b.type || ''); return d !== 0 ? d : (a.name || '').localeCompare(b.name || ''); },
    'checked-asc': function (a, b) { return (a.lastChecked || 0) - (b.lastChecked || 0); }
  };
  function visibleAssets() {
    var q = (ui.search || '').trim().toLowerCase();
    var list = Object.keys(DB.assets).map(function (k) { return DB.assets[k]; }).filter(function (a) {
      if (ui.tab !== 'all' && (a.status || 'unknown') !== ui.tab) return false;
      if (ui.typeFilter && (a.type || '') !== ui.typeFilter) return false;
      if (q) {
        var hay = (a.id + ' ' + (a.name || '') + ' ' + (a.description || '') + ' ' + (a.type || '')).toLowerCase();
        if (hay.indexOf(q) === -1) return false;
      }
      return true;
    });
    list.sort(SORTERS[settings.sortBy] || SORTERS['updated-desc']);
    return list;
  }

  /* ============================== UI ============================== */
  var host = null, shadow = null, els = {};

  var CSS = [
    ':host{all:initial}',
    '*{box-sizing:border-box;font-family:"Segoe UI",system-ui,-apple-system,Arial,sans-serif}',
    '#fab{position:fixed;right:18px;bottom:18px;z-index:2147483000;background:#00a2ff;color:#fff;border:0;border-radius:999px;padding:11px 16px;font-size:13px;font-weight:600;cursor:pointer;box-shadow:0 6px 22px rgba(0,0,0,.45);display:flex;gap:8px;align-items:center}',
    '#fab:hover{background:#1cb0ff}',
    '#fab .pend{background:#f5b041;color:#1a1a1a;border-radius:999px;padding:1px 8px;font-size:12px}',
    '#fab .dot{width:9px;height:9px;border-radius:50%;background:#ff4757;box-shadow:0 0 0 3px rgba(255,71,87,.3)}',
    '#panel{position:fixed;top:0;right:0;height:100dvh;width:min(880px,100vw);background:#1b1e24;color:#f2f4f5;z-index:2147483001;display:flex;flex-direction:column;box-shadow:-12px 0 40px rgba(0,0,0,.55);border-left:1px solid #343b4a}',
    '#panel.hidden{display:none}',
    '#panel.fullpage{left:0;right:0;width:100vw;height:100dvh;border-left:0;box-shadow:none}',
    '#panel.fullpage header{padding-left:max(14px,calc((100vw - 1560px)/2));padding-right:max(14px,calc((100vw - 1560px)/2))}',
    '#panel.fullpage .tabs{padding-left:max(14px,calc((100vw - 1560px)/2));padding-right:max(14px,calc((100vw - 1560px)/2))}',
    '#panel.fullpage .controls{padding-left:max(14px,calc((100vw - 1560px)/2));padding-right:max(14px,calc((100vw - 1560px)/2))}',
    '#panel.fullpage .bulkbar{padding-left:max(14px,calc((100vw - 1560px)/2));padding-right:max(14px,calc((100vw - 1560px)/2))}',
    '#panel.fullpage .loadmorebar{padding-left:max(14px,calc((100vw - 1560px)/2));padding-right:max(14px,calc((100vw - 1560px)/2))}',
    '#panel.fullpage #settings{padding-left:max(14px,calc((100vw - 1560px)/2));padding-right:max(14px,calc((100vw - 1560px)/2))}',
    '#panel.fullpage #list{padding:14px max(14px,calc((100vw - 1560px)/2))}',
    '#panel.fullpage #list.grid{grid-template-columns:repeat(auto-fill,minmax(275px,1fr));gap:14px}',
    '#panel.fullpage footer{padding-left:max(14px,calc((100vw - 1560px)/2));padding-right:max(14px,calc((100vw - 1560px)/2))}',
    '#panel.fullpage .hrow h1:after{content:" · Full page";color:#a7b0be;font-size:12px;font-weight:500}',
    'header{background:#232833;border-bottom:1px solid #343b4a;padding:12px 14px}',
    '.hrow{display:flex;align-items:center;gap:8px;flex-wrap:wrap}',
    '.hrow h1{font-size:16px;margin:0;font-weight:700}',
    '.sub{font-size:12px;color:#a7b0be;margin-top:3px}',
    '.sp{flex:1}',
    'button.btn,select.sel,input.inp{background:#2b313e;color:#f2f4f5;border:1px solid #3d4657;border-radius:6px;padding:7px 10px;font-size:12.5px;cursor:pointer}',
    'button.btn:hover{background:#343d4f}',
    'button.btn:disabled{opacity:.55;cursor:wait}',
    'button.primary{background:#00a2ff;border-color:#00a2ff;color:#fff;font-weight:600}',
    'button.primary:hover{background:#1cb0ff}',
    'button.danger{background:#4a2326;border-color:#7a2e35}',
    'input.inp{cursor:text;min-width:180px;flex:1}',
    '.tabs{display:flex;gap:6px;padding:10px 14px 0;flex-wrap:wrap}',
    '.tab{background:#2b313e;border:1px solid #3d4657;color:#dbe3ec;border-radius:999px;padding:6px 12px;font-size:12.5px;cursor:pointer;font-weight:600}',
    '.tab.on{color:#fff;border-color:#00a2ff;background:#12344d}',
    '.tab .n{opacity:.85;font-weight:400}',
    '.tab.t-approved.on{background:#14351f;border-color:#2ecc71}',
    '.tab.t-pending.on{background:#3d2f10;border-color:#f5b041}',
    '.tab.t-moderated.on{background:#3d1616;border-color:#e74c3c}',
    '.controls{display:flex;gap:6px;padding:10px 14px;flex-wrap:wrap;align-items:center;border-bottom:1px solid #343b4a}',
    '.bulkbar{display:flex;gap:6px;padding:8px 14px;flex-wrap:wrap;align-items:center;background:#172a3a;border-bottom:1px solid #24587a;color:#e8f6ff;font-size:12.5px}',
    '.bulkbar[hidden]{display:none}',
    '.bulkbar .bulkcount{font-weight:800;color:#8fd8ff;margin-right:2px}',
    '.bulkbar .btn,.bulkbar .sel{padding:6px 8px;font-size:12px}',
    '#settings{display:none;background:#20242d;border-bottom:1px solid #343b4a;padding:10px 14px;font-size:12.5px}',
    '#settings.open{display:block}',
    '#settings label{display:inline-flex;gap:6px;align-items:center;margin:4px 12px 4px 0;cursor:pointer}',
    '#settings .help{color:#a7b0be;line-height:1.5;margin-top:8px;max-width:70ch}',
    '#list{flex:1 1 auto;overflow-y:auto;padding:12px 14px;scrollbar-gutter:stable;min-height:0}',
    '#list.grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(258px,1fr));gap:10px;align-content:start;align-items:start;grid-auto-rows:max-content}',
    '#list.rows{display:flex;flex-direction:column;gap:8px}',
    '.card{background:#242833;border:1px solid #343b4a;border-radius:10px;overflow:hidden;display:flex;flex-direction:column;min-width:0;min-height:0;height:max-content}',
    '.card.changed{outline:2px solid #00a2ff}',
    '.card.selected{outline:3px solid #8fd8ff;outline-offset:-3px;border-color:#8fd8ff}',
    '.cardtop{display:flex;align-items:center;gap:7px;min-width:0}',
    '.cardtop .aname{flex:1 1 auto;min-width:0}',
    '.selectwrap{display:inline-flex;align-items:center;gap:4px;flex:none;background:#171a20;border:1px solid #46536a;border-radius:999px;padding:3px 7px 3px 5px;color:#cfeaff;font-size:10.5px;font-weight:700;cursor:pointer;user-select:none}',
    '.selectwrap:hover{border-color:#8fd8ff}',
    '.asset-select{width:15px;height:15px;margin:0;accent-color:#00a2ff;cursor:pointer;flex:none}',
    '.thumbwrap{position:relative;background:#14161a;width:100%;height:auto;min-height:0;display:block;overflow:hidden;flex:0 0 auto;align-self:stretch}',
    '.thumbsizer{display:block;width:100%;height:0;padding-top:100%;pointer-events:none}',
    'button.thumbwrap{border:0;padding:0;margin:0;cursor:zoom-in;text-align:inherit;color:inherit;-webkit-appearance:none;appearance:none}',
    'button.thumbwrap:hover{outline:2px solid #00a2ff;outline-offset:-2px}',
    'button.thumbwrap:focus-visible{outline:3px solid #7bdcff;outline-offset:-3px}',
    '.rows .card{flex-direction:row;flex:none}',
    '.rows .thumbwrap{width:118px;min-width:118px;height:118px;flex:0 0 118px;align-self:flex-start}',
    '.thumbwrap img.thumbimg{position:absolute;left:0;top:0;width:100%;height:100%;max-width:none;max-height:none;display:block;object-fit:contain;object-position:center;opacity:0;transition:opacity .18s ease-in}',
    '.thumbwrap img.thumbimg.is-loaded{opacity:1}',
    '.thumbwrap img.thumbimg.is-error{opacity:0}',
    '.thumbplaceholder{position:absolute;left:0;top:0;right:0;bottom:0;display:flex;align-items:center;justify-content:center;font-size:38px;opacity:.42;pointer-events:none}',
    '.thumbstate{position:absolute;right:8px;bottom:8px;background:#000a;color:#dbeafe;font-size:10px;padding:2px 6px;border-radius:999px;pointer-events:none}',
    '.viewdetails{position:absolute;left:8px;bottom:8px;background:#00a2ffee;color:#fff;font-size:10px;font-weight:700;padding:3px 7px;border-radius:999px;opacity:0;transition:opacity .15s;pointer-events:none}',
    'button.thumbwrap:hover .viewdetails,button.thumbwrap:focus-visible .viewdetails{opacity:1}',
    '.loadmore{grid-column:1/-1;display:flex;align-items:center;justify-content:center;gap:8px;flex-wrap:wrap;background:#20242d;border:1px solid #343b4a;border-radius:10px;padding:14px;color:#a7b0be;font-size:12.5px;width:100%}',
    '.loadmorebar{display:flex;gap:7px;padding:8px 14px;flex-wrap:wrap;align-items:center;justify-content:center;background:#20242d;border-top:1px solid #343b4a;color:#c8d1dc;font-size:12.5px;flex:none}',
    '.loadmorebar[hidden]{display:none}',
    '.loadmorebar .btn{padding:6px 10px;font-size:12px}',
    '.badge{position:absolute;top:8px;left:8px;font-size:11px;font-weight:700;padding:3px 8px;border-radius:999px;color:#fff;text-shadow:0 1px 2px rgba(0,0,0,.4)}',
    '.st-approved{background:#1e9e57}.st-pending{background:#d18d12}.st-moderated{background:#c0392b}.st-unknown{background:#5d6d7e}',
    '.st-pending.pulse{animation:pulse 1.6s ease-in-out infinite}',
    '@keyframes pulse{50%{opacity:.55}}',
    '.arch{position:absolute;top:8px;right:8px;font-size:10px;background:#000c;color:#ccc;padding:2px 7px;border-radius:4px}',
    '.newtag{position:absolute;bottom:8px;right:8px;font-size:10px;background:#00a2ff;color:#fff;padding:2px 7px;border-radius:4px;font-weight:700}',
    '.cbody{padding:9px 10px;display:flex;flex-direction:column;gap:5px;min-width:0;flex:1}',
    '.aname{font-size:13.5px;font-weight:700;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}',
    '.ameta{font-size:11.5px;color:#a7b0be;display:flex;gap:6px;align-items:center;flex-wrap:wrap}',
    'code.id{font-family:ui-monospace,Consolas,monospace;background:#171a20;padding:2px 6px;border-radius:4px;color:#9fd8ff;font-size:11px}',
    '.chip{background:#171a20;border:1px solid #343b4a;border-radius:999px;padding:1px 8px;font-size:10.5px}',
    '.adesc{font-size:12px;color:#c8d1dc;line-height:1.45;display:-webkit-box;-webkit-line-clamp:3;-webkit-box-orient:vertical;overflow:hidden;cursor:pointer;white-space:pre-wrap;word-break:break-word}',
    '.adesc.exp{-webkit-line-clamp:unset}',
    '.adesc.none{color:#6e7a89;font-style:italic;cursor:default}',
    '.adates{font-size:10.5px;color:#7e8a99;line-height:1.5}',
    '.aacts{margin-top:auto;display:flex;gap:5px;flex-wrap:wrap;padding-top:4px}',
    '.aacts .btn,.aacts a.btn{padding:5px 8px;font-size:11.5px;text-decoration:none;display:inline-block}',
    '.empty{color:#a7b0be;font-size:13px;line-height:1.6;padding:24px 6px;max-width:62ch}',
    'footer{background:#232833;border-top:1px solid #343b4a;padding:8px 14px;font-size:11.5px;color:#a7b0be;display:flex;gap:14px;flex-wrap:wrap}',
    '#toasts{position:fixed;right:18px;bottom:64px;z-index:2147483002;display:flex;flex-direction:column;gap:6px;max-width:min(420px,92vw)}',
    '.toast{background:#232833;color:#f2f4f5;border:1px solid #3d4657;border-left:4px solid #00a2ff;border-radius:8px;padding:9px 12px;font-size:12.5px;box-shadow:0 8px 24px rgba(0,0,0,.5)}',
    '.overlay{position:fixed;inset:0;z-index:2147483003;background:rgba(5,8,12,.78);display:flex;align-items:center;justify-content:center;padding:18px}',
    '.overlay.hidden{display:none}',
    '.detailsCard{width:min(980px,96vw);max-height:92dvh;overflow:auto;background:#20242d;color:#f2f4f5;border:1px solid #46536a;border-radius:14px;box-shadow:0 24px 70px rgba(0,0,0,.65);padding:16px}',
    '.detailsHead{display:flex;align-items:flex-start;gap:10px;margin-bottom:12px}.detailsHead h2{font-size:20px;line-height:1.3;margin:0;flex:1;min-width:0;overflow-wrap:anywhere}',
    '.detailsGrid{display:grid;grid-template-columns:minmax(260px,420px) minmax(0,1fr);gap:16px}.detailsThumb{position:relative;background:#0b0d10;border:1px solid #343b4a;border-radius:10px;overflow:hidden;display:block}',
    '.detailsThumb img{position:absolute;left:0;top:0;width:100%;height:100%;object-fit:contain;display:block}',
    '.detailBadge{display:inline-block;color:#fff;font-size:11px;font-weight:700;padding:3px 8px;border-radius:999px;margin-top:6px}',
    '.detailsDesc{white-space:pre-wrap;overflow-wrap:anywhere;line-height:1.55;font-size:13px;color:#dce6f1;background:#171a20;border:1px solid #343b4a;border-radius:9px;padding:10px;max-height:230px;overflow:auto}',
    '.detailsMeta{display:grid;grid-template-columns:repeat(auto-fit,minmax(180px,1fr));gap:7px;margin:10px 0}.metaItem{background:#171a20;border:1px solid #343b4a;border-radius:8px;padding:7px 9px;min-width:0}.metaItem span{display:block;color:#8fa0b4;font-size:10px;text-transform:uppercase;letter-spacing:.05em}.metaItem b{font-size:12px;overflow-wrap:anywhere}',
    '.history{font-size:12px;color:#bac7d6;line-height:1.5;background:#171a20;border:1px solid #343b4a;border-radius:9px;padding:9px 10px}.history h3{margin:0 0 5px;font-size:12px;color:#fff}.history ul{margin:0;padding-left:18px}',
    '.detailsActions{display:flex;gap:6px;flex-wrap:wrap;margin:12px 0}.detailsActions .btn{text-decoration:none}',
    '.manualCard{width:min(780px,96vw);max-height:92dvh;overflow:auto;background:#20242d;color:#f2f4f5;border:1px solid #46536a;border-radius:14px;box-shadow:0 24px 70px rgba(0,0,0,.65);padding:16px}',
    '.manualCard.dragover{border-color:#00a2ff;box-shadow:0 0 0 3px rgba(0,162,255,.35),0 24px 70px rgba(0,0,0,.65)}',
    '.manualHead{display:flex;gap:10px;align-items:flex-start;margin-bottom:8px}.manualHead h2{font-size:19px;line-height:1.3;margin:0;flex:1}',
    '.manualHelp{color:#a7b0be;font-size:12.5px;line-height:1.55;margin:6px 0 10px}.manualHelp code{background:#171a20;color:#9fd8ff;padding:1px 5px;border-radius:4px}',
    '.manualLabel{display:block;font-size:12px;font-weight:700;color:#dbe3ec;margin:8px 0 5px}',
    '.manualInput{width:100%;min-height:190px;resize:vertical;background:#0d1015;color:#f2f4f5;border:1px solid #3d4657;border-radius:9px;padding:10px;font:12.5px/1.5 ui-monospace,Consolas,monospace;outline:none}',
    '.manualInput:focus{border-color:#00a2ff;box-shadow:0 0 0 2px rgba(0,162,255,.22)}.manualInput:disabled{opacity:.65;cursor:wait}',
    '.manualMeta{display:flex;gap:8px;flex-wrap:wrap;align-items:center;margin-top:7px;color:#a7b0be;font-size:12px}.manualMeta .fileName{color:#8fd8ff;overflow-wrap:anywhere}',
    '.manualOptions{display:flex;gap:7px 14px;flex-wrap:wrap;margin:11px 0;color:#dbe3ec;font-size:12.5px}.manualOptions label{display:inline-flex;gap:6px;align-items:center;cursor:pointer}.manualOptions input{accent-color:#00a2ff;width:15px;height:15px}',
    '.manualActions{display:flex;gap:6px;flex-wrap:wrap;align-items:center;margin-top:10px}.manualActions .sp{flex:1}',
    '.manualStatus{margin-top:10px;background:#171a20;border:1px solid #343b4a;border-radius:8px;padding:8px 10px;color:#bac7d6;font-size:12px;line-height:1.5;white-space:pre-wrap;overflow-wrap:anywhere}.manualStatus:empty{display:none}',
    '@media(max-width:720px){.detailsGrid{grid-template-columns:1fr}.detailsCard,.manualCard{padding:12px}.detailsHead h2,.manualHead h2{font-size:17px}.manualInput{min-height:160px}}'
  ].join('\n');

  function syncSettingsControls() {
    if (!els.sortSel) return;
    els.sortSel.value = settings.sortBy;
    if (els.setInterval) els.setInterval.value = String(settings.recheckMinutes);
    if (els.setApprovedRefresh) els.setApprovedRefresh.value = String(settings.approvedRefreshHours);
    if (els.setAutoScan) els.setAutoScan.checked = !!settings.autoScan;
    if (els.setNotify) els.setNotify.checked = !!settings.notifyDesktop;
    if (els.setEnrich) els.setEnrich.checked = !!settings.enrichDescriptions;
    if (els.setRecheckUnknown) els.setRecheckUnknown.checked = !!settings.recheckUnknown;
    if (els.setIgnoreModerated) els.setIgnoreModerated.checked = !!settings.ignoreModerated;
    if (els.setHighResThumbnails) els.setHighResThumbnails.checked = !!settings.highResThumbnails;
    if (els.list) els.list.className = settings.view === 'rows' ? 'rows' : 'grid';
    if (els.viewBtn) els.viewBtn.textContent = settings.view === 'rows' ? '▦ Grid' : '☰ List';
  }

  function buildUI() {
    if (host) return;
    host = document.createElement('div');
    host.id = 'rcat-host';
    document.body.appendChild(host);
    shadow = host.attachShadow({ mode: 'open' });
    var style = document.createElement('style');
    style.textContent = CSS;
    shadow.appendChild(style);
    var wrap = document.createElement('div');
    wrap.innerHTML =
      '<button id="fab" title="Open Roblox Creator Asset Tracker">🗂️ Asset Tracker <span id="fabCount">0</span><span class="pend" id="fabPend" style="display:none"></span><span class="dot" id="fabDot" style="display:none"></span></button>' +
      '<section id="panel" class="hidden">' +
        '<header>' +
          '<div class="hrow"><h1>🗂️ Creator Asset Tracker</h1><span class="sp"></span>' +
            '<button class="btn" data-action="scan">🔍 Scan page</button>' +
            '<button class="btn" data-action="open-manual-add" title="Manually add pure Asset IDs or Roblox asset links by pasting a list or choosing a list file">＋ Add IDs/links</button>' +
            '<button class="btn primary" id="recheckBtn" data-action="recheck-all">↻ Recheck pending</button>' +
            '<select class="sel" id="exportSel" title="Export"><option value="">⬇ Export…</option><option value="json">JSON</option><option value="csv">CSV</option><option value="html">HTML report (categories + thumbnails)</option><option value="copyids">Copy filtered IDs</option><option value="import">Import JSON…</option></select>' +
            '<button class="btn" id="fullPageBtn" data-action="open-fullpage" title="Open the live Asset Tracker as a full page in a new tab (same saved logs and controls)">⛶ Full page</button>' +
            '<button class="btn" data-action="toggle-settings">⚙️</button>' +
            '<button class="btn" data-action="close">✕</button>' +
          '</div>' +
          '<div class="sub" id="subCounts"></div>' +
          '<div id="settings">' +
            '<label>Auto re-check pending every <select class="sel" id="setInterval">' +
              '<option value="0">Off</option><option value="1">1 min</option><option value="2">2 min</option><option value="5">5 min</option><option value="10">10 min</option><option value="15">15 min</option><option value="30">30 min</option><option value="60">60 min</option>' +
            '</select></label>' +
            '<label>Refresh approved every <select class="sel" id="setApprovedRefresh">' +
              '<option value="0">Off</option><option value="6">6 hours</option><option value="12">12 hours</option><option value="24">24 hours</option><option value="72">3 days</option><option value="168">7 days</option>' +
            '</select></label>' +
            '<label><input type="checkbox" id="setAutoScan"> Auto-scan pages/dashboard data as I browse</label>' +
            '<label><input type="checkbox" id="setNotify"> Desktop notifications</label>' +
            '<label><input type="checkbox" id="setEnrich"> Fetch missing descriptions</label>' +
            '<label><input type="checkbox" id="setRecheckUnknown"> Also recheck “Unknown”</label>' +
            '<label><input type="checkbox" id="setIgnoreModerated"> Don’t log moderated assets</label>' +
            '<label><input type="checkbox" id="setHighResThumbnails"> Load high-resolution (420px) thumbnails</label>' +
            '<div style="margin-top:8px;display:flex;gap:6px;flex-wrap:wrap">' +
              '<button class="btn" data-action="refresh-approved" title="Refresh the oldest-checked approved assets for status, name, and description changes">↻ Refresh approved now</button>' +
              '<button class="btn danger" data-action="purge-moderated" title="Remove only moderated assets and block their IDs from being logged again">⛔ Remove all moderated <span data-mod-count></span></button>' +
              '<button class="btn" data-action="reset-ignored" id="resetIgnoredBtn">Reset removed list</button>' +
              '<button class="btn danger" data-action="clear-db">🗑 Clear all tracked assets</button>' +
            '</div>' +
            '<div class="help">Assets are collected automatically from the dashboard\u2019s own data and from the cards on screen, then stored once per Asset ID in your browser. ' +
            'Pending assets are re-checked on the timer above (thumbnails state + asset details endpoints). Roblox has no public moderation-status API, so a status is a best-effort merge of those signals — hover a card\u2019s badge to see the raw status and its source. ' +
            'Removing a card also adds it to a “removed” list so it is not re-collected (reset it above to undo).<br><br>' +
            '<b>Selection:</b> use each card’s Select checkbox (Shift-click selects a range), or the toolbar’s Select shown / Select filtered buttons. The blue bulk bar can recheck, copy, open, export, or remove all selected assets together.<br><br>' +
            '<b>Manual add:</b> “＋ Add IDs/links” accepts a pasted list or a .txt/.csv/.json file of pure Asset IDs, rbxassetid values, or Roblox asset/configure links. It dedupes the list and, with “Check and categorize now” enabled, checks each accepted asset for status, name, description, type, dates, and thumbnail.<br><br>' +
            '<b>Approved refresh:</b> approved assets become stale after the interval above and are refreshed oldest-first in small batches during auto-recheck wakeups, including name/description changes.<br><br>' +
            '<b>Auto-scan OFF</b> stops both page-card scanning and dashboard network-data collection while browsing. Manual Scan page and rechecks still work when you explicitly run them.<br><br>' +
            '<b>Live full-page view:</b> “⛶ Full page” opens this tracker in a new Creator Dashboard tab with #rcat-fullpage appended. It uses the same saved logs and keeps every live scan, recheck, details, settings, and export function; use “↘ Side panel” there to shrink it back into the side drawer.<br><br>' +
            '<b>Moderated assets:</b> “Remove all moderated” deletes only moderated records and blocks their IDs on the removed list, so rescanning cannot log them again. ' +
            'With “Don’t log moderated assets” ON, new moderated assets are skipped on sight, and a tracked asset that becomes moderated is removed right after its notification. ' +
            'Turning that toggle OFF does not unblock IDs — use “Reset removed list”.<br><br>' +
            'Click a thumbnail to inspect an asset. High-resolution thumbnails are loaded progressively (six at a time) in a fixed square frame to avoid tiny, stretched, or jumping images in large collections.</div>' +
            '<div class="help" id="modBlockInfo"></div>' +
          '</div>' +
        '</header>' +
        '<div class="tabs" id="tabs"></div>' +
        '<div class="controls">' +
          '<input class="inp" id="searchInp" type="search" placeholder="Search name, description or ID…">' +
          '<select class="sel" id="typeSel" title="Filter by type"><option value="">All types</option></select>' +
          '<select class="sel" id="sortSel" title="Sort by">' +
            '<option value="updated-desc">Sort: Recently changed</option>' +
            '<option value="created-desc">Sort: Newest first</option>' +
            '<option value="created-asc">Sort: Oldest first</option>' +
            '<option value="name-asc">Sort: Name A → Z</option>' +
            '<option value="name-desc">Sort: Name Z → A</option>' +
            '<option value="id-desc">Sort: ID high → low</option>' +
            '<option value="id-asc">Sort: ID low → high</option>' +
            '<option value="status">Sort: Status (pending first)</option>' +
            '<option value="type">Sort: Type A → Z</option>' +
            '<option value="checked-asc">Sort: Least recently checked</option>' +
          '</select>' +
          '<button class="btn" data-action="view" id="viewBtn" title="Toggle grid/list view">☰ List</button>' +
          '<button class="btn" data-action="select-rendered" title="Select every asset currently rendered below">☑ Select shown</button>' +
          '<button class="btn" data-action="select-filtered" title="Select every asset matching the current tab/search/type filters, including ones not rendered yet">☑ Select filtered</button>' +
          '<button class="btn danger" data-action="purge-moderated" id="purgeModBtn" style="display:none" title="Remove only moderated assets and block their IDs so they are not logged again">⛔ Remove moderated <span data-mod-count></span></button>' +
        '</div>' +
        '<div class="bulkbar" id="bulkBar" hidden>' +
          '<span class="bulkcount" id="bulkCount">0 selected</span>' +
          '<button class="btn primary" data-action="bulk-recheck">↻ Recheck selected</button>' +
          '<button class="btn" data-action="bulk-copy-ids">⧉ Copy IDs</button>' +
          '<button class="btn" data-action="bulk-copy-rbx">⧉ Copy rbxassetids</button>' +
          '<button class="btn" data-action="bulk-open">Open selected ↗</button>' +
          '<button class="btn" data-action="bulk-details">Details</button>' +
          '<select class="sel" id="bulkExportSel" title="Export only selected assets"><option value="">⬇ Export selected…</option><option value="json">JSON</option><option value="csv">CSV</option><option value="html">HTML report</option></select>' +
          '<button class="btn danger" data-action="bulk-remove">Remove selected</button>' +
          '<button class="btn" data-action="clear-selection">Clear selection</button>' +
        '</div>' +
        '<div id="list"></div>' +
        '<div class="loadmorebar" id="loadMoreBar" hidden>' +
          '<span id="loadMoreText"></span>' +
          '<button class="btn primary" id="loadMoreBtn" data-action="show-more">Load more</button>' +
          '<button class="btn" data-action="show-all">Show all</button>' +
        '</div>' +
        '<footer id="statusbar"></footer>' +
        '<input type="file" id="importFile" accept="application/json,.json" style="display:none">' +
        '<input type="file" id="manualAddFile" accept=".txt,.text,.csv,.tsv,.json,.md,text/plain,text/csv,text/tab-separated-values,application/json" style="display:none">' +
      '</section>' +
      '<div id="detailsOverlay" class="overlay hidden" role="dialog" aria-modal="true" aria-label="Asset details">' +
        '<div class="detailsCard"><div id="detailsContent"></div></div>' +
      '</div>' +
      '<div id="manualAddOverlay" class="overlay hidden" role="dialog" aria-modal="true" aria-labelledby="manualAddTitle">' +
        '<div class="manualCard" id="manualAddCard">' +
          '<div class="manualHead"><h2 id="manualAddTitle">＋ Add asset IDs or links</h2>' +
            '<button class="btn" data-action="close-manual-add" title="Close">✕</button></div>' +
          '<div class="manualHelp">Paste one entry per line, or separate entries with commas, semicolons, or spaces. Accepts pure IDs such as <code>123456789</code>, <code>rbxassetid://123456789</code>, Creator Dashboard configure links, and Roblox library/catalog/store links. You can also choose or drop a <b>.txt</b>, <b>.csv</b>, <b>.tsv</b>, <b>.json</b>, or <b>.md</b> list file. Duplicates are merged into the existing one-record-per-ID database.</div>' +
          '<label class="manualLabel" for="manualAddInput">Asset IDs or links</label>' +
          '<textarea class="manualInput" id="manualAddInput" spellcheck="false" placeholder="123456789&#10;987654321, 555555555&#10;rbxassetid://123456789&#10;https://create.roblox.com/dashboard/creations/decals/123456789/configure&#10;https://www.roblox.com/library/987654321/Asset-Name"></textarea>' +
          '<div class="manualMeta"><span class="fileName" id="manualAddFileName"></span><span id="manualAddPreview">No IDs or links entered yet.</span></div>' +
          '<div class="manualOptions">' +
            '<label><input type="checkbox" id="manualAddCheck" checked> Check and categorize now</label>' +
            '<label><input type="checkbox" id="manualAddBlocked"> Include IDs on removed list</label>' +
            '<label><input type="checkbox" id="manualAddSelect" checked> Select accepted assets</label>' +
          '</div>' +
          '<div class="manualActions">' +
            '<button class="btn" data-action="choose-manual-file">📁 Choose list file…</button>' +
            '<button class="btn" data-action="clear-manual-add">Clear</button>' +
            '<span class="sp"></span>' +
            '<button class="btn" data-action="close-manual-add">Cancel</button>' +
            '<button class="btn primary" id="manualAddSubmit" data-action="submit-manual-add" disabled>Add &amp; check</button>' +
          '</div>' +
          '<div class="manualStatus" id="manualAddStatus" aria-live="polite"></div>' +
        '</div>' +
      '</div>' +
      '<div id="toasts"></div>';
    shadow.appendChild(wrap);

    els = {
      fab: shadow.getElementById('fab'), fabCount: shadow.getElementById('fabCount'),
      fabPend: shadow.getElementById('fabPend'), fabDot: shadow.getElementById('fabDot'),
      panel: shadow.getElementById('panel'), list: shadow.getElementById('list'),
      tabs: shadow.getElementById('tabs'), sub: shadow.getElementById('subCounts'),
      statusbar: shadow.getElementById('statusbar'), toasts: shadow.getElementById('toasts'),
      search: shadow.getElementById('searchInp'), typeSel: shadow.getElementById('typeSel'),
      sortSel: shadow.getElementById('sortSel'), exportSel: shadow.getElementById('exportSel'),
      bulkBar: shadow.getElementById('bulkBar'), bulkCount: shadow.getElementById('bulkCount'),
      bulkExportSel: shadow.getElementById('bulkExportSel'),
      loadMoreBar: shadow.getElementById('loadMoreBar'), loadMoreText: shadow.getElementById('loadMoreText'),
      loadMoreBtn: shadow.getElementById('loadMoreBtn'),
      fullPageBtn: shadow.getElementById('fullPageBtn'),
      settingsBox: shadow.getElementById('settings'), recheckBtn: shadow.getElementById('recheckBtn'),
      viewBtn: shadow.getElementById('viewBtn'), importFile: shadow.getElementById('importFile'),
      setInterval: shadow.getElementById('setInterval'), setApprovedRefresh: shadow.getElementById('setApprovedRefresh'),
      setAutoScan: shadow.getElementById('setAutoScan'),
      setNotify: shadow.getElementById('setNotify'), setEnrich: shadow.getElementById('setEnrich'),
      setRecheckUnknown: shadow.getElementById('setRecheckUnknown'), resetIgnoredBtn: shadow.getElementById('resetIgnoredBtn'),
      setIgnoreModerated: shadow.getElementById('setIgnoreModerated'),
      setHighResThumbnails: shadow.getElementById('setHighResThumbnails'),
      purgeModBtn: shadow.getElementById('purgeModBtn'), modBlockInfo: shadow.getElementById('modBlockInfo'),
      detailsOverlay: shadow.getElementById('detailsOverlay'), detailsContent: shadow.getElementById('detailsContent'),
      manualAddOverlay: shadow.getElementById('manualAddOverlay'), manualAddCard: shadow.getElementById('manualAddCard'),
      manualAddInput: shadow.getElementById('manualAddInput'), manualAddFileName: shadow.getElementById('manualAddFileName'),
      manualAddPreview: shadow.getElementById('manualAddPreview'), manualAddStatus: shadow.getElementById('manualAddStatus'),
      manualAddCheck: shadow.getElementById('manualAddCheck'), manualAddBlocked: shadow.getElementById('manualAddBlocked'),
      manualAddSelect: shadow.getElementById('manualAddSelect'), manualAddSubmit: shadow.getElementById('manualAddSubmit'),
      manualAddFile: shadow.getElementById('manualAddFile')
    };

    // restore control state
    els.sortSel.value = settings.sortBy;
    els.setInterval.value = String(settings.recheckMinutes);
    els.setApprovedRefresh.value = String(settings.approvedRefreshHours);
    els.setAutoScan.checked = !!settings.autoScan;
    els.setNotify.checked = !!settings.notifyDesktop;
    els.setEnrich.checked = !!settings.enrichDescriptions;
    els.setRecheckUnknown.checked = !!settings.recheckUnknown;
    els.setIgnoreModerated.checked = !!settings.ignoreModerated;
    els.setHighResThumbnails.checked = !!settings.highResThumbnails;
    els.list.className = settings.view === 'rows' ? 'rows' : 'grid';
    els.viewBtn.textContent = settings.view === 'rows' ? '▦ Grid' : '☰ List';
    applyPanelClass();

    els.fab.addEventListener('click', function () { togglePanel(); });
    shadow.addEventListener('click', onSelectionClick, true);
    shadow.addEventListener('click', onPanelClick);
    shadow.addEventListener('change', onPanelChange);
    els.search.addEventListener('input', debounce(function () { ui.search = els.search.value; ui.renderLimit = CONFIG.renderBatchSize; renderList(); }, 180));
    els.typeSel.addEventListener('change', function () { ui.typeFilter = els.typeSel.value; ui.renderLimit = CONFIG.renderBatchSize; renderList(); });
    els.sortSel.addEventListener('change', function () { settings.sortBy = els.sortSel.value; saveSettings(); ui.renderLimit = CONFIG.renderBatchSize; renderList(); });
    els.exportSel.addEventListener('change', function () {
      var v = els.exportSel.value; els.exportSel.value = '';
      if (v === 'json') exportJSON();
      else if (v === 'csv') exportCSV();
      else if (v === 'html') exportHTML();
      else if (v === 'copyids') {
        var ids = visibleAssets().map(function (a) { return a.id; });
        copyText(ids.join('\n'), 'Copied ' + ids.length + ' filtered asset ID(s)');
      } else if (v === 'import') els.importFile.click();
    });
    els.bulkExportSel.addEventListener('change', function () {
      var v = els.bulkExportSel.value; els.bulkExportSel.value = '';
      var ids = selectedAssetIds();
      if (!ids.length) { toast('No assets are selected.'); return; }
      if (v === 'json') exportJSON(ids);
      else if (v === 'csv') exportCSV(ids);
      else if (v === 'html') exportHTML(ids);
    });
    els.importFile.addEventListener('change', function () {
      var f = els.importFile.files && els.importFile.files[0];
      if (!f) return;
      f.text().then(function (t) { importJSON(t); }).catch(function () { toast('Import failed: could not read file'); });
      els.importFile.value = '';
    });
    els.manualAddInput.addEventListener('input', debounce(updateManualAddPreview, 180));
    els.manualAddCheck.addEventListener('change', updateManualAddPreview);
    els.manualAddBlocked.addEventListener('change', updateManualAddPreview);
    els.manualAddFile.addEventListener('change', function () {
      var f = els.manualAddFile.files && els.manualAddFile.files[0];
      els.manualAddFile.value = '';
      if (f) loadManualAddFile(f);
    });
    els.manualAddOverlay.addEventListener('click', function (e) {
      if (e.target === els.manualAddOverlay) closeManualAdd();
    });
    ['dragenter', 'dragover'].forEach(function (eventName) {
      els.manualAddCard.addEventListener(eventName, function (e) {
        e.preventDefault();
        els.manualAddCard.classList.add('dragover');
      });
    });
    els.manualAddCard.addEventListener('dragleave', function (e) {
      if (e.target === els.manualAddCard) els.manualAddCard.classList.remove('dragover');
    });
    els.manualAddCard.addEventListener('drop', function (e) {
      e.preventDefault();
      els.manualAddCard.classList.remove('dragover');
      var f = e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files[0];
      if (f) loadManualAddFile(f);
      else if (e.dataTransfer && typeof e.dataTransfer.getData === 'function') {
        var droppedText = e.dataTransfer.getData('text/plain') || e.dataTransfer.getData('text/uri-list') || '';
        if (droppedText) {
          els.manualAddInput.value = droppedText;
          manualAddLoadedFileName = '';
          if (els.manualAddFileName) els.manualAddFileName.textContent = '';
          updateManualAddPreview();
        }
      }
    });
    els.setInterval.addEventListener('change', function () {
      settings.recheckMinutes = Number(els.setInterval.value) || 0; saveSettings(); scheduleRecheck();
      toast(settings.recheckMinutes ? ('Pending assets will auto re-check every ' + settings.recheckMinutes + ' min') : 'Auto re-check turned off');
    });
    els.setApprovedRefresh.addEventListener('change', function () {
      settings.approvedRefreshHours = Number(els.setApprovedRefresh.value) || 0;
      saveSettings(); scheduleRecheck();
      toast(settings.approvedRefreshHours
        ? ('Approved assets will be refreshed after ' + settings.approvedRefreshHours + ' hour(s), oldest-checked first.')
        : 'Automatic approved-asset refresh turned off.');
    });
    els.setAutoScan.addEventListener('change', function () {
      settings.autoScan = els.setAutoScan.checked;
      saveSettings();
      toast(settings.autoScan
        ? 'Auto-scan ON — pages and dashboard data will be collected as you browse.'
        : 'Auto-scan OFF — browsing will not collect assets automatically. Manual “Scan page” still works.');
      if (settings.autoScan) setTimeout(function () { scanPage('auto'); }, 60);
    });
    els.setNotify.addEventListener('change', function () { settings.notifyDesktop = els.setNotify.checked; saveSettings(); });
    els.setEnrich.addEventListener('change', function () {
      settings.enrichDescriptions = els.setEnrich.checked; saveSettings();
      if (settings.enrichDescriptions) Object.keys(DB.assets).forEach(queueEnrich);
    });
    els.setRecheckUnknown.addEventListener('change', function () { settings.recheckUnknown = els.setRecheckUnknown.checked; saveSettings(); });
    els.setIgnoreModerated.addEventListener('change', function () {
      settings.ignoreModerated = els.setIgnoreModerated.checked;
      saveSettings();
      renderTabs();
      if (settings.ignoreModerated) {
        var n = countByStatus().moderated;
        if (n > 0) {
          if (window.confirm('“Don’t log moderated assets” is ON.\n\nAlso remove the ' + n + ' moderated asset(s) already tracked now?\n\n' +
            'OK = remove them now and block their IDs from being logged again\n' +
            'Cancel = keep them for now (only future moderated assets will be skipped)')) {
            removeModeratedAssets('moderated-purge-toggle');
          } else {
            toast('Keeping the ' + n + ' moderated asset(s) already tracked. New moderated assets won’t be logged; use “Remove all moderated” anytime to purge these.');
          }
        } else {
          toast('Moderated assets will no longer be logged. Any seen from now on will have their ID blocked.');
        }
      } else {
        toast('Moderated assets will be logged again. IDs already on the removed list stay blocked until you reset that list.');
      }
    });
    els.setHighResThumbnails.addEventListener('change', function () {
      settings.highResThumbnails = els.setHighResThumbnails.checked;
      saveSettings();
      toast(settings.highResThumbnails ? 'High-resolution thumbnails ON — visible cards will upgrade to 420px in batches.' : 'High-resolution thumbnail upgrades OFF.');
      if (settings.highResThumbnails) queueHighResThumbnails(visibleAssets().slice(0, ui.renderLimit));
    });
    els.detailsOverlay.addEventListener('click', function (e) { if (e.target === els.detailsOverlay) closeAssetDetails(); });
    document.addEventListener('keydown', function (e) {
      if (e.key !== 'Escape') return;
      if (ui.manualAddOpen) closeManualAdd();
      else if (ui.detailsId) closeAssetDetails();
      else if (ui.panelOpen) togglePanel(false);
    });

    renderAll();
    setInterval(function () { updateStatusBar(); }, 1000);
  }

  var manualAddRunning = false;
  var manualAddLoadedFileName = '';

  function openManualAdd() {
    if (!els.manualAddOverlay) return false;
    if (ui.detailsId) closeAssetDetails();
    ui.manualAddOpen = true;
    els.manualAddOverlay.className = 'overlay';
    els.manualAddOverlay.id = 'manualAddOverlay';
    updateManualAddPreview();
    setTimeout(function () {
      try { if (els.manualAddInput) els.manualAddInput.focus(); } catch (e) {}
    }, 30);
    return true;
  }

  function closeManualAdd() {
    ui.manualAddOpen = false;
    if (els.manualAddOverlay) {
      els.manualAddOverlay.className = 'overlay hidden';
      els.manualAddOverlay.id = 'manualAddOverlay';
    }
    if (els.manualAddCard) els.manualAddCard.classList.remove('dragover');
    return true;
  }

  function updateManualAddPreview() {
    if (!els.manualAddInput || !els.manualAddPreview) return null;
    var parsed = parseManualAssetEntries(els.manualAddInput.value || '');
    var limit = CONFIG.manualAddLimit || 5000;
    var shownEntries = parsed.entries.slice(0, limit);
    var includeBlocked = !!(els.manualAddBlocked && els.manualAddBlocked.checked);
    var existingCount = 0, blockedCount = 0, actionableCount = 0;
    shownEntries.forEach(function (entry) {
      if (DB.assets[entry.id]) existingCount++;
      if (DB.ignored[entry.id]) blockedCount++;
      if (!DB.ignored[entry.id] || includeBlocked) actionableCount++;
    });

    if (!parsed.entries.length && !parsed.invalidCount) {
      els.manualAddPreview.textContent = 'No IDs or links entered yet.';
    } else {
      var bits = [parsed.entries.length + ' unique asset(s) recognized'];
      if (parsed.duplicateCount) bits.push(parsed.duplicateCount + ' duplicate(s)');
      if (parsed.invalidCount) bits.push(parsed.invalidCount + ' unrecognized');
      if (existingCount) bits.push(existingCount + ' already tracked');
      if (blockedCount) bits.push(blockedCount + (includeBlocked ? ' removed-list ID(s) will be re-added' : ' on removed list'));
      if (parsed.entries.length > limit) bits.push('only the first ' + limit + ' will be processed');
      if (parsed.inputTruncated) bits.push('input truncated at safety limit');
      els.manualAddPreview.textContent = bits.join(' · ') + '.';
    }
    els.manualAddPreview.title = parsed.invalidExamples.length
      ? ('Unrecognized examples: ' + parsed.invalidExamples.join(' | '))
      : '';

    if (els.manualAddSubmit) {
      els.manualAddSubmit.disabled = manualAddRunning || actionableCount === 0;
      els.manualAddSubmit.textContent = manualAddRunning
        ? 'Working…'
        : ((els.manualAddCheck && els.manualAddCheck.checked)
          ? ('Add & check' + (actionableCount ? ' (' + actionableCount + ')' : ''))
          : ('Add assets' + (actionableCount ? ' (' + actionableCount + ')' : '')));
    }
    return parsed;
  }

  function setManualAddRunning(on, statusText) {
    manualAddRunning = !!on;
    [els.manualAddInput, els.manualAddCheck, els.manualAddBlocked, els.manualAddSelect, els.manualAddFile].forEach(function (el) {
      if (el) el.disabled = manualAddRunning;
    });
    if (shadow) {
      shadow.querySelectorAll('[data-action="choose-manual-file"],[data-action="clear-manual-add"]').forEach(function (btn) {
        btn.disabled = manualAddRunning;
      });
    }
    if (els.manualAddStatus && statusText != null) els.manualAddStatus.textContent = statusText;
    updateManualAddPreview();
  }

  function readManualTextFile(file) {
    if (file && typeof file.text === 'function') return Promise.resolve(file.text());
    return new Promise(function (resolve, reject) {
      try {
        var reader = new FileReader();
        reader.onload = function () { resolve(String(reader.result || '')); };
        reader.onerror = function () { reject(reader.error || new Error('Could not read file')); };
        reader.readAsText(file);
      } catch (e) { reject(e); }
    });
  }

  async function loadManualAddFile(file) {
    if (!file) return false;
    buildUI();
    if (Number(file.size) > (CONFIG.manualAddFileMaxBytes || 5242880)) {
      toast('That list file is larger than the 5 MiB safety limit. Split it into smaller lists.');
      if (els.manualAddStatus) els.manualAddStatus.textContent = 'List file was not loaded: it exceeds the 5 MiB safety limit.';
      return false;
    }
    try {
      var text = await readManualTextFile(file);
      openManualAdd();
      manualAddLoadedFileName = String(file.name || 'list file');
      els.manualAddInput.value = String(text || '');
      if (els.manualAddFileName) els.manualAddFileName.textContent = 'Loaded ' + manualAddLoadedFileName;
      if (els.manualAddStatus) {
        els.manualAddStatus.textContent = 'Loaded “' + manualAddLoadedFileName + '”. Review the preview, then choose Add & check.';
      }
      updateManualAddPreview();
      return true;
    } catch (e) {
      log('manual list file load failed', e);
      toast('Could not read that list file.');
      if (els.manualAddStatus) els.manualAddStatus.textContent = 'Could not read that list file.';
      return false;
    }
  }

  async function submitManualAddFromUI() {
    if (!els.manualAddInput || manualAddRunning) return null;
    var parsed = updateManualAddPreview();
    if (!parsed || !parsed.entries.length) {
      if (els.manualAddStatus) els.manualAddStatus.textContent = 'No recognized asset IDs or Roblox asset links were found.';
      toast('No recognized asset IDs or Roblox asset links were found.');
      return null;
    }

    var checkNow = !!(els.manualAddCheck && els.manualAddCheck.checked);
    var includeBlocked = !!(els.manualAddBlocked && els.manualAddBlocked.checked);
    var limit = CONFIG.manualAddLimit || 5000;
    var actionable = parsed.entries.slice(0, limit).filter(function (entry) {
      return !DB.ignored[entry.id] || includeBlocked;
    });
    if (!actionable.length) {
      if (els.manualAddStatus) {
        els.manualAddStatus.textContent = 'Every recognized ID is on the removed list. Tick “Include IDs on removed list” if you want to add them again.';
      }
      return null;
    }
    if (checkNow && actionable.length > 500 && !window.confirm(
      'Check ' + actionable.length + ' manually added assets now?\n\n' +
      'The tracker will request thumbnails, asset details, names, and descriptions in controlled batches. ' +
      'A very large list can take a while and may be rate-limited by Roblox.')) {
      if (els.manualAddStatus) els.manualAddStatus.textContent = 'Manual add cancelled before checking the large list.';
      return null;
    }

    setManualAddRunning(true, checkNow
      ? ('Adding and checking ' + actionable.length + ' asset(s)… Progress is also shown in the tracker status bar.')
      : ('Adding ' + actionable.length + ' asset(s)…'));
    try {
      var result = await addManualAssets(els.manualAddInput.value || '', {
        check: checkNow,
        includeBlocked: includeBlocked,
        selectAdded: !!(els.manualAddSelect && els.manualAddSelect.checked),
        announce: false,
        sourceName: manualAddLoadedFileName
      });
      if (els.manualAddStatus) {
        els.manualAddStatus.textContent = result.summary + (checkNow
          ? ' Accepted assets were checked for status, name, description, type, dates, and thumbnails.'
          : ' No full status check was run; use Recheck selected when you are ready to categorize them.');
      }
      toast(result.summary, 9000);
      return result;
    } catch (e) {
      log('manual add failed', e);
      if (els.manualAddStatus) els.manualAddStatus.textContent = 'Manual add failed. See the browser console / [RCAT] log for details.';
      toast('Manual add failed — see console/[RCAT] debug log.');
      return null;
    } finally {
      setManualAddRunning(false);
      updateManualAddPreview();
    }
  }

  function syncSelectionUI() {
    pruneSelection();
    var n = ui.selectedIds.size;
    if (els.bulkBar) els.bulkBar.hidden = n === 0;
    if (els.bulkCount) els.bulkCount.textContent = n + ' selected';
    if (!shadow) return;
    var boxes = shadow.querySelectorAll('.asset-select');
    boxes.forEach(function (input) {
      var id = input.getAttribute('data-select-id') || '';
      var on = ui.selectedIds.has(id);
      input.checked = on;
      var card = input.closest ? input.closest('.card') : null;
      if (card) card.classList.toggle('selected', on);
    });
  }

  function renderedAssetIds() {
    if (shadow) {
      return [].slice.call(shadow.querySelectorAll('.asset-select')).map(function (input) {
        return input.getAttribute('data-select-id') || '';
      }).filter(Boolean);
    }
    return (ui.lastRenderedIds || []).slice();
  }

  function selectRenderedAssets() {
    var ids = renderedAssetIds();
    pruneSelection();
    ids.forEach(function (id) { if (DB.assets[id]) ui.selectedIds.add(id); });
    if (ids.length) ui.lastSelectedId = ids[ids.length - 1];
    syncSelectionUI();
    toast(ids.length ? ('Selected ' + ids.length + ' shown asset(s).') : 'No rendered assets to select.');
    return ids.length;
  }

  function selectFilteredAssets() {
    var assets = visibleAssets();
    pruneSelection();
    assets.forEach(function (a) { ui.selectedIds.add(String(a.id)); });
    if (assets.length) ui.lastSelectedId = String(assets[assets.length - 1].id);
    syncSelectionUI();
    toast(assets.length
      ? ('Selected ' + assets.length + ' filtered asset(s)' + (assets.length > renderedAssetIds().length ? ' — including assets not rendered yet.' : '.'))
      : 'No assets match the current filters.');
    return assets.length;
  }

  function onPanelChange(e) {
    var input = e.target && e.target.closest ? e.target.closest('.asset-select') : null;
    if (!input) return;
    setAssetSelected(input.getAttribute('data-select-id') || '', !!input.checked);
  }

  function onSelectionClick(e) {
    var input = e.target && e.target.closest ? e.target.closest('.asset-select') : null;
    if (!input || !e.shiftKey || !ui.lastSelectedId) return;
    var ids = renderedAssetIds();
    var currentId = input.getAttribute('data-select-id') || '';
    var a = ids.indexOf(String(ui.lastSelectedId));
    var b = ids.indexOf(currentId);
    if (a === -1 || b === -1) return;
    e.stopPropagation();
    var shouldSelect = !ui.selectedIds.has(currentId);
    ids.slice(Math.min(a, b), Math.max(a, b) + 1).forEach(function (id) {
      if (shouldSelect) ui.selectedIds.add(id);
      else ui.selectedIds.delete(id);
    });
    ui.lastSelectedId = currentId;
    syncSelectionUI();
    // Checkbox activation can toggle/revert the endpoint after this capturing
    // handler runs. A deferred sync makes the visible boxes match the
    // authoritative selection set in real browsers as well as jsdom.
    setTimeout(syncSelectionUI, 0);
  }

  function openSelectedAssets() {
    var ids = selectedAssetIds();
    if (!ids.length) { toast('No assets are selected.'); return 0; }
    if (ids.length > CONFIG.bulkOpenLimit) {
      toast('For safety, bulk Open is capped at ' + CONFIG.bulkOpenLimit + ' tabs. Select a smaller group or use Copy IDs.');
      return 0;
    }
    if (ids.length > 1 && !window.confirm('Open ' + ids.length + ' selected assets in separate tabs?')) return 0;
    var opened = 0;
    ids.forEach(function (id, index) {
      var a = DB.assets[id]; if (!a) return;
      var url = openUrl(a);
      var ok = false;
      try {
        if (typeof GM_openInTab === 'function') {
          ok = GM_openInTab(url, { active: index === 0, insert: true, setParent: true }) !== false;
        } else if (typeof GM !== 'undefined' && GM && typeof GM.openInTab === 'function') {
          GM.openInTab(url, { active: index === 0, insert: true, setParent: true });
          ok = true;
        }
      } catch (e) { ok = false; }
      if (!ok) {
        try { ok = !!window.open(url, '_blank'); } catch (e) { ok = false; }
      }
      if (ok) opened++;
    });
    toast(opened ? ('Opened ' + opened + ' selected asset tab(s).') : 'The browser blocked opening the selected asset tabs.');
    return opened;
  }

  function showSelectedDetails() {
    var ids = selectedAssetIds();
    if (ids.length === 1) { openAssetDetails(ids[0]); return true; }
    toast(ids.length ? 'Details can display one asset at a time — leave exactly one asset selected.' : 'No assets are selected.');
    return false;
  }

  function showMoreAssets() {
    var before = els.list ? els.list.querySelectorAll('.card').length : 0;
    ui.renderLimit = Math.max(CONFIG.renderBatchSize, Number(ui.renderLimit) || CONFIG.renderBatchSize) + CONFIG.renderBatchSize;
    renderList();
    var cards = els.list ? els.list.querySelectorAll('.card') : [];
    var firstNew = cards[before];
    if (firstNew && typeof firstNew.scrollIntoView === 'function') {
      // Use an instant jump: the first new card can be more than 100 cards
      // below the old viewport, so a smooth animation is slow/dizzying and
      // may not have reached the continuation point when the user resumes.
      try { firstNew.scrollIntoView({ block: 'start', behavior: 'auto' }); } catch (e) {}
    }
    return Math.max(0, cards.length - before);
  }

  function updateLoadMoreBar(total, shown) {
    if (!els.loadMoreBar) return;
    total = Math.max(0, Number(total) || 0);
    shown = Math.max(0, Math.min(total, Number(shown) || 0));
    var remaining = total - shown;
    els.loadMoreBar.hidden = remaining <= 0;
    if (els.loadMoreText) {
      els.loadMoreText.textContent = 'Showing ' + shown + ' of ' + total + ' filtered assets · ' + remaining + ' not rendered yet';
    }
    if (els.loadMoreBtn) {
      els.loadMoreBtn.textContent = 'Load ' + Math.min(CONFIG.renderBatchSize, Math.max(remaining, 0)) + ' more';
    }
  }

  function onPanelClick(e) {
    var desc = e.target && e.target.closest ? e.target.closest('.adesc') : null;
    var btn = e.target && e.target.closest ? e.target.closest('[data-action],[data-tab]') : null;
    if (desc && !btn) { desc.classList.toggle('exp'); return; }
    if (!btn) return;
    var action = btn.getAttribute('data-action');
    var tab = btn.getAttribute('data-tab');
    var id = btn.getAttribute('data-id');
    if (tab) { ui.tab = tab; ui.renderLimit = CONFIG.renderBatchSize; renderTabs(); renderList(); return; }
    switch (action) {
      case 'open-fullpage':
        if (ui.fullPage) setFullPageMode(false);
        else openFullPageTracker();
        break;
      case 'close': togglePanel(false); break;
      case 'close-details': closeAssetDetails(); break;
      case 'open-manual-add': openManualAdd(); break;
      case 'close-manual-add': closeManualAdd(); break;
      case 'choose-manual-file': if (els.manualAddFile) els.manualAddFile.click(); break;
      case 'clear-manual-add':
        if (!manualAddRunning && els.manualAddInput) {
          els.manualAddInput.value = '';
          manualAddLoadedFileName = '';
          if (els.manualAddFileName) els.manualAddFileName.textContent = '';
          if (els.manualAddStatus) els.manualAddStatus.textContent = '';
          updateManualAddPreview();
          els.manualAddInput.focus();
        }
        break;
      case 'submit-manual-add': submitManualAddFromUI(); break;
      case 'show-details': if (id) openAssetDetails(id); break;
      case 'show-more': showMoreAssets(); break;
      case 'show-all': ui.renderLimit = Number.MAX_SAFE_INTEGER; renderList(); break;
      case 'select-rendered': selectRenderedAssets(); break;
      case 'select-filtered': selectFilteredAssets(); break;
      case 'clear-selection': clearSelection(); break;
      case 'bulk-recheck': {
        var bulkRecheckIds = selectedAssetIds();
        if (bulkRecheckIds.length) recheckAssets(bulkRecheckIds, 'manual-bulk', { refreshMetadata: true });
        else toast('No assets are selected.');
        break;
      }
      case 'bulk-copy-ids': {
        var bulkIds = selectedAssetIds();
        if (bulkIds.length) copyText(bulkIds.join('\n'), 'Copied ' + bulkIds.length + ' selected asset ID(s)');
        else toast('No assets are selected.');
        break;
      }
      case 'bulk-copy-rbx': {
        var bulkRbxIds = selectedAssetIds();
        if (bulkRbxIds.length) {
          copyText(bulkRbxIds.map(function (x) { return 'rbxassetid://' + x; }).join('\n'),
            'Copied ' + bulkRbxIds.length + ' selected rbxassetid value(s)');
        } else toast('No assets are selected.');
        break;
      }
      case 'bulk-open': openSelectedAssets(); break;
      case 'bulk-details': showSelectedDetails(); break;
      case 'bulk-remove': removeSelectedAssetsWithConfirm(); break;
      case 'refresh-approved':
        refreshApprovedAssets('approved-manual', { manual: true, forceBatch: true, limit: 100, announce: true });
        break;
      case 'purge-moderated': purgeModeratedWithConfirm(); break;
      case 'scan': lastScanSignature = ''; scanPage('manual', true); renderAll(); break;
      case 'recheck-all': recheckPending('manual'); break;
      case 'recheck-one': if (id) recheckAssets([id], 'manual-one', { refreshMetadata: true }); break;
      case 'toggle-settings': ui.settingsOpen = !ui.settingsOpen; els.settingsBox.className = ui.settingsOpen ? 'open' : ''; break;
      case 'view':
        settings.view = settings.view === 'rows' ? 'grid' : 'rows'; saveSettings();
        els.list.className = settings.view; els.viewBtn.textContent = settings.view === 'rows' ? '▦ Grid' : '☰ List';
        break;
      case 'copy-id': if (id) copyText(id, 'Copied asset ID ' + id); break;
      case 'copy-rbx': if (id) copyText('rbxassetid://' + id, 'Copied rbxassetid://' + id); break;
      case 'remove-one':
        if (id && DB.assets[id]) {
          var nm = DB.assets[id].name || id;
          delete DB.assets[id]; blockAsset(id, 'removed-manual');
          if (ui.selectedIds) ui.selectedIds.delete(String(id));
          if (String(ui.detailsId || '') === String(id)) closeAssetDetails();
          saveDBNow(); renderAll();
          toast('Removed "' + nm + '" and added it to the removed list (Settings can reset it).');
        }
        break;
      case 'reset-ignored':
        DB.ignored = {}; saveDBNow(); renderAll(); lastScanSignature = ''; scanPage('auto', true);
        toast(settings.ignoreModerated
          ? 'Removed list cleared. Note: “Don’t log moderated assets” is ON, so moderated assets will still be skipped and re-blocked when seen.'
          : 'Removed list cleared — assets on this page will be collected again.');
        break;
      case 'clear-db':
        if (window.confirm('Delete ALL tracked assets from the tracker database?\nThis cannot be undone (your Roblox assets are not affected).')) {
          DB.assets = {};
          if (ui.selectedIds) ui.selectedIds.clear();
          ui.lastSelectedId = '';
          closeAssetDetails(); saveDBNow(); renderAll();
          toast('Tracker database cleared.');
        }
        break;
    }
  }

  function isFullPageRequested(urlText) {
    try {
      var u = new URL(urlText || location.href, location.origin);
      var hash = String(u.hash || '').toLowerCase();
      var mode = String(u.searchParams.get('rcat') || '').toLowerCase();
      return hash.indexOf('rcat-full') !== -1 ||
        u.searchParams.get('rcatFullPage') === '1' ||
        mode === 'fullpage' || mode === 'full-page';
    } catch (e) {
      return String(urlText || location.href || '').toLowerCase().indexOf('rcat-full') !== -1;
    }
  }

  function fullPageUrl() {
    try {
      var u = new URL(location.href);
      if (!/(^|\/)dashboard(\/|$)/i.test(u.pathname)) {
        u = new URL('https://create.roblox.com/dashboard/creations');
      }
      u.searchParams.delete('rcat');
      u.searchParams.delete('rcatFullPage');
      u.hash = 'rcat-fullpage';
      return u.href;
    } catch (e) {
      return 'https://create.roblox.com/dashboard/creations#rcat-fullpage';
    }
  }

  function applyPanelClass() {
    if (!els.panel) return;
    var classes = [];
    if (!ui.panelOpen) classes.push('hidden');
    if (ui.fullPage) classes.push('fullpage');
    els.panel.className = classes.join(' ');
    els.panel.id = 'panel';
    if (els.fullPageBtn) {
      els.fullPageBtn.textContent = ui.fullPage ? '↘ Side panel' : '⛶ Full page';
      els.fullPageBtn.title = ui.fullPage
        ? 'Return the live Asset Tracker to the side panel'
        : 'Open the live Asset Tracker as a full page in a new tab (same saved logs and controls)';
    }
  }

  function syncFullPageUrl(on) {
    try {
      var u = new URL(location.href);
      if (on) {
        u.hash = 'rcat-fullpage';
      } else {
        u.searchParams.delete('rcat');
        u.searchParams.delete('rcatFullPage');
        if (String(u.hash || '').toLowerCase().indexOf('rcat-full') !== -1) u.hash = '';
      }
      if (u.href !== location.href) history.replaceState(null, document.title, u.href);
    } catch (e) {}
  }

  function setFullPageMode(on) {
    ui.fullPage = !!on;
    if (ui.fullPage) ui.panelOpen = true;
    syncFullPageUrl(ui.fullPage);
    applyPanelClass();
    if (ui.panelOpen) renderAll();
    return ui.fullPage;
  }

  function openFullPageTracker() {
    if (ui.fullPage || isFullPageRequested()) {
      setFullPageMode(true);
      return true;
    }
    var target = fullPageUrl();
    var opened = false;
    try {
      if (typeof GM_openInTab === 'function') {
        var gmTab = GM_openInTab(target, { active: true, insert: true, setParent: true });
        opened = gmTab !== false;
      } else if (typeof GM !== 'undefined' && GM && typeof GM.openInTab === 'function') {
        GM.openInTab(target, { active: true, insert: true, setParent: true });
        opened = true;
      }
    } catch (e) { opened = false; }
    if (!opened) {
      try {
        var w = window.open(target, '_blank');
        if (w) {
          try { w.opener = null; } catch (e) {}
          opened = true;
        }
      } catch (e) { opened = false; }
    }
    if (opened) {
      toast('Opened the live full-page Asset Tracker in a new tab. It uses the same saved logs.');
      return true;
    }
    setFullPageMode(true);
    toast('The browser blocked a new tab, so the live tracker was expanded to full page in this tab instead.');
    return false;
  }

  function togglePanel(force) {
    var nextOpen = (typeof force === 'boolean') ? force : !ui.panelOpen;
    if (!nextOpen && ui.manualAddOpen) closeManualAdd();
    if (!nextOpen && ui.detailsId) closeAssetDetails();
    ui.panelOpen = nextOpen;
    applyPanelClass();
    if (ui.panelOpen) renderAll();
    else {
      // opening the panel counts as "seeing" the changes
      var any = false;
      Object.keys(DB.assets).forEach(function (k) { if (DB.assets[k].unseenChange) { DB.assets[k].unseenChange = false; any = true; } });
      if (any) saveDBSoon();
      updateFAB();
    }
  }

  function toast(msg, ms) {
    if (!els.toasts) { log('toast:', msg); return; }
    var t = document.createElement('div');
    t.className = 'toast'; t.textContent = msg;
    els.toasts.appendChild(t);
    setTimeout(function () { try { t.remove(); } catch (e) {} }, ms || 4200);
  }

  /* Progressive card-thumbnail loading: fixed square frames reserve the
     correct aspect ratio immediately; off-screen images wait, and at most
     CONFIG.thumbnailLoadConcurrency images load/decode at a time. */
  var THUMB_PLACEHOLDER = 'data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///ywAAAAAAQABAAACAUwAOw==';
  var thumbObserver = null;
  var thumbLoadQueue = [];
  var thumbLoadActive = 0;
  var thumbRenderToken = 0;

  function setThumbnailState(img, text) {
    try {
      var wrapEl = img && img.closest ? img.closest('.thumbwrap') : null;
      var state = wrapEl ? wrapEl.querySelector('.thumbstate') : null;
      if (state) {
        state.textContent = text || '';
        state.style.display = text ? '' : 'none';
      }
    } catch (e) {}
  }

  function processThumbnailLoadQueue() {
    while (thumbLoadActive < CONFIG.thumbnailLoadConcurrency && thumbLoadQueue.length) {
      (function (img) {
        if (!img || !img.isConnected) return;
        var src = img.getAttribute('data-src');
        var token = img.getAttribute('data-render-token');
        if (!src || Number(token) !== thumbRenderToken) return;
        thumbLoadActive++;
        setThumbnailState(img, 'Loading…');
        var pre = new Image();
        try { pre.decoding = 'async'; pre.referrerPolicy = 'no-referrer'; } catch (e) {}
        var finished = false;
        function done(ok) {
          if (finished) return;
          finished = true;
          thumbLoadActive = Math.max(0, thumbLoadActive - 1);
          if (img.isConnected && Number(img.getAttribute('data-render-token')) === thumbRenderToken) {
            if (ok) {
              img.src = src;
              img.classList.add('is-loaded');
              img.removeAttribute('data-src');
              setThumbnailState(img, '');
            } else {
              img.classList.add('is-error');
              setThumbnailState(img, 'Image unavailable');
            }
          }
          processThumbnailLoadQueue();
        }
        pre.onload = function () { done(true); };
        pre.onerror = function () { done(false); };
        pre.src = src;
        if (pre.complete) done(pre.naturalWidth > 0);
      })(thumbLoadQueue.shift());
    }
  }

  function queueThumbnailImage(img) {
    if (!img || img.getAttribute('data-queued') === '1') return;
    img.setAttribute('data-queued', '1');
    thumbLoadQueue.push(img);
    processThumbnailLoadQueue();
  }

  function setupThumbnailLoader() {
    if (!els.list) return;
    thumbRenderToken++;
    thumbLoadQueue = [];
    if (thumbObserver) { try { thumbObserver.disconnect(); } catch (e) {} thumbObserver = null; }

    var direct = els.list.querySelectorAll('img.thumbimg:not([data-src])');
    direct.forEach(function (img) {
      function markLoaded() { img.classList.add('is-loaded'); setThumbnailState(img, ''); }
      function markError() { img.classList.add('is-error'); setThumbnailState(img, 'Image unavailable'); }
      if (img.complete) { if (img.naturalWidth > 0) markLoaded(); else if (img.currentSrc || img.src) markError(); }
      else {
        img.addEventListener('load', markLoaded, { once: true });
        img.addEventListener('error', markError, { once: true });
      }
    });

    var deferred = els.list.querySelectorAll('img.thumbimg[data-src]');
    deferred.forEach(function (img) { img.setAttribute('data-render-token', String(thumbRenderToken)); });
    if (!deferred.length) return;
    if (typeof IntersectionObserver === 'undefined') {
      deferred.forEach(queueThumbnailImage);
      return;
    }
    thumbObserver = new IntersectionObserver(function (entries) {
      entries.forEach(function (entry) {
        if (!entry.isIntersecting) return;
        try { thumbObserver.unobserve(entry.target); } catch (e) {}
        queueThumbnailImage(entry.target);
      });
    }, { root: els.list, rootMargin: '650px 0px', threshold: 0.01 });
    deferred.forEach(function (img) { thumbObserver.observe(img); });
  }

  var STATUS_META = {
    approved: { label: '✔ Approved', cls: 'st-approved' },
    pending: { label: '⏳ Pending', cls: 'st-pending pulse' },
    moderated: { label: '⛔ Moderated', cls: 'st-moderated' },
    unknown: { label: '? Unknown', cls: 'st-unknown' }
  };

  function detailMetaHTML(label, value) {
    if (value === '' || value == null) return '';
    return '<div class="metaItem"><span>' + esc(label) + '</span><b>' + esc(value) + '</b></div>';
  }

  function assetDetailsHTML(a) {
    var sm = STATUS_META[a.status] || STATUS_META.unknown;
    var history = (a.statusHistory && a.statusHistory.length)
      ? '<div class="history"><h3>Status history</h3><ul>' + a.statusHistory.slice().reverse().map(function (h) {
          return '<li><b>' + esc(h.s) + '</b> · ' + esc(fmtDate(h.at)) + (h.src ? ' · ' + esc(h.src) : '') + '</li>';
        }).join('') + '</ul></div>'
      : '<div class="history"><h3>Status history</h3>No recorded status changes yet.</div>';
    var thumb = '<span class="thumbsizer" aria-hidden="true"></span>' + (a.thumbnail
      ? '<img src="' + esc(a.thumbnail) + '" alt="' + esc(a.name || ('Asset ' + a.id)) + ' thumbnail" width="420" height="420" fetchpriority="high" decoding="async" referrerpolicy="no-referrer">'
      : '<span class="thumbplaceholder">🖼️</span>');
    return '<div class="detailsHead"><div><h2>' + esc(a.name || ('Asset ' + a.id)) + '</h2>' +
      '<span class="detailBadge ' + sm.cls + '">' + esc(sm.label) + '</span>' +
      (a.isArchived ? ' <span class="detailBadge st-unknown">Archived</span>' : '') + '</div>' +
      '<span class="sp"></span><button class="btn" data-action="close-details" title="Close details">✕</button></div>' +
      '<div class="detailsGrid"><div><div class="detailsThumb">' + thumb + '</div>' +
      (a.thumbnail ? '<div style="margin-top:7px;font-size:11px;color:#8fa0b4">Stored thumbnail' + (a.thumbnailWidth ? ': ~' + esc(a.thumbnailWidth) + 'px wide' : ' (source resolution unknown)') + (needsHighResThumbnail(a) ? ' · upgrading to 420px…' : '') + '</div>' : '') +
      '</div><div>' +
      '<div class="detailsDesc">' + (a.description ? esc(a.description) : 'No description tracked yet.') + '</div>' +
      '<div class="detailsActions">' +
        '<button class="btn primary" data-action="copy-id" data-id="' + esc(a.id) + '">⧉ Copy Asset ID</button>' +
        '<button class="btn" data-action="copy-rbx" data-id="' + esc(a.id) + '">⧉ Copy rbxassetid</button>' +
        '<a class="btn" href="' + esc(openUrl(a)) + '" target="_blank" rel="noopener">Open asset ↗</a>' +
        (a.thumbnail ? '<a class="btn" href="' + esc(a.thumbnail) + '" target="_blank" rel="noopener">Open thumbnail ↗</a>' : '') +
        '<button class="btn" data-action="recheck-one" data-id="' + esc(a.id) + '">↻ Recheck</button>' +
        '<button class="btn danger" data-action="remove-one" data-id="' + esc(a.id) + '">Remove</button>' +
      '</div>' +
      '<div class="detailsMeta">' +
        detailMetaHTML('Asset ID', a.id) +
        detailMetaHTML('Type', (a.type || 'Unknown') + (a.typeId ? ' (#' + a.typeId + ')' : '')) +
        detailMetaHTML('Creator', (a.creatorName || '') + (a.creatorId ? ' (' + a.creatorId + ')' : '')) +
        detailMetaHTML('Created', a.created ? fmtDate(a.created) : '') +
        detailMetaHTML('Updated', a.updated ? fmtDate(a.updated) : '') +
        detailMetaHTML('First seen', fmtDate(a.firstSeen)) +
        detailMetaHTML('Last seen', fmtDate(a.lastSeen)) +
        detailMetaHTML('Last checked', a.lastChecked ? fmtDate(a.lastChecked) : 'Never') +
        detailMetaHTML('Status last observed', a.statusObservedAt ? fmtDate(a.statusObservedAt) : '') +
        detailMetaHTML('Status changed', a.lastStatusChange ? fmtDate(a.lastStatusChange) : '') +
        detailMetaHTML('Raw status', a.rawStatus || '') +
        detailMetaHTML('Status source', a.statusSource || '') +
        detailMetaHTML('Confidence', a.statusConfidence ? String(a.statusConfidence) + ' / 5' : '') +
      '</div>' + history +
      '</div></div>';
  }

  function openAssetDetails(id) {
    var a = DB.assets[String(id)];
    if (!a || !els.detailsOverlay) return;
    ui.detailsId = String(id);
    els.detailsContent.innerHTML = assetDetailsHTML(a);
    els.detailsOverlay.className = 'overlay';
    els.detailsOverlay.id = 'detailsOverlay';
    // Show what's known instantly, then quietly upgrade the thumbnail and
    // fill any missing description/dates behind the scenes.
    refreshAssetDetails(id);
  }

  function refreshOpenAssetDetails() {
    if (!ui.detailsId || !els.detailsContent) return;
    var a = DB.assets[String(ui.detailsId)];
    if (!a) { closeAssetDetails(); return; }
    els.detailsContent.innerHTML = assetDetailsHTML(a);
  }

  function closeAssetDetails() {
    ui.detailsId = '';
    if (els.detailsOverlay) {
      els.detailsOverlay.className = 'overlay hidden';
      els.detailsOverlay.id = 'detailsOverlay';
    }
    if (els.detailsContent) els.detailsContent.innerHTML = '';
  }

  function cardHTML(a, index) {
    var sm = STATUS_META[a.status] || STATUS_META.unknown;
    var thumb = a.thumbnail || '';
    var badgeTitle = 'Status: ' + (a.status || 'unknown') +
      (a.rawStatus ? ' (raw: ' + a.rawStatus + ')' : '') +
      (a.statusSource ? ' · source: ' + a.statusSource : '') +
      (a.lastStatusChange ? ' · changed ' + fmtDate(a.lastStatusChange) : '') +
      (a.statusHistory && a.statusHistory.length ? '\nHistory:\n' + a.statusHistory.map(function (h) { return '• ' + h.s + ' — ' + fmtDate(h.at) + (h.src ? ' (' + h.src + ')' : ''); }).join('\n') : '');
    var eagerThumb = (Number(index) || 0) < CONFIG.eagerThumbnailCount;
    var thumbImg = '';
    if (thumb) {
      thumbImg = eagerThumb
        ? '<img class="thumbimg" src="' + esc(thumb) + '" alt="' + esc(a.name || 'Asset thumbnail') + '" width="420" height="420" loading="eager" fetchpriority="high" decoding="async" referrerpolicy="no-referrer">'
        : '<img class="thumbimg" src="' + THUMB_PLACEHOLDER + '" data-src="' + esc(thumb) + '" alt="' + esc(a.name || 'Asset thumbnail') + '" width="420" height="420" loading="lazy" fetchpriority="low" decoding="async" referrerpolicy="no-referrer">';
    } else {
      thumbImg = '<span class="thumbplaceholder">🖼️</span>';
    }
    var isSelected = !!(ui.selectedIds && ui.selectedIds.has(String(a.id)));
    return '<article class="card' + (a.unseenChange ? ' changed' : '') + (isSelected ? ' selected' : '') + '">' +
      '<button type="button" class="thumbwrap" data-action="show-details" data-id="' + esc(a.id) + '" title="View details for ' + esc(a.name || ('Asset ' + a.id)) + '" aria-label="View details for ' + esc(a.name || ('Asset ' + a.id)) + '">' +
        '<span class="thumbsizer" aria-hidden="true"></span>' +
        thumbImg +
        '<span class="badge ' + sm.cls + '" title="' + esc(badgeTitle) + '">' + esc(sm.label) + '</span>' +
        '<span class="viewdetails">View details</span>' +
        (thumb && !eagerThumb ? '<span class="thumbstate">Queued…</span>' : '<span class="thumbstate" style="display:none"></span>') +
        (a.isArchived ? '<span class="arch">Archived</span>' : '') +
        (a.unseenChange ? '<span class="newtag">CHANGED</span>' : '') +
      '</button>' +
      '<div class="cbody">' +
        '<div class="cardtop">' +
          '<label class="selectwrap" title="Select this asset for bulk actions (Shift-click selects a range)">' +
            '<input type="checkbox" class="asset-select" data-select-id="' + esc(a.id) + '"' + (isSelected ? ' checked' : '') +
              ' aria-label="Select ' + esc(a.name || ('Asset ' + a.id)) + ' for bulk actions">Select</label>' +
          '<div class="aname" title="' + esc(a.name || '') + '">' + esc(a.name || ('Asset ' + a.id)) + '</div>' +
        '</div>' +
        '<div class="ameta"><code class="id" title="Asset ID">' + esc(a.id) + '</code>' +
          '<button class="btn" data-action="copy-id" data-id="' + esc(a.id) + '" title="Copy ID">⧉ ID</button>' +
          (a.type ? '<span class="chip">' + esc(a.type) + '</span>' : '') +
          (a.creatorName ? '<span>by ' + esc(a.creatorName) + '</span>' : '') +
        '</div>' +
        (a.description
          ? '<div class="adesc" title="Click to expand/collapse\n' + esc(a.description) + '">' + esc(a.description) + '</div>'
          : '<div class="adesc none">No description tracked yet</div>') +
        '<div class="adates">' +
          (a.created ? 'Created ' + esc(fmtDate(a.created)) + '<br>' : '') +
          'First seen ' + esc(timeAgo(a.firstSeen)) + ' · Last seen ' + esc(timeAgo(a.lastSeen)) + '<br>' +
          'Last checked ' + (a.lastChecked ? esc(timeAgo(a.lastChecked)) : 'never') +
          (a.lastStatusChange ? ' · Status changed ' + esc(timeAgo(a.lastStatusChange)) : '') +
        '</div>' +
        '<div class="aacts">' +
          '<button class="btn primary" data-action="show-details" data-id="' + esc(a.id) + '">Details</button>' +
          '<a class="btn" href="' + esc(openUrl(a)) + '" target="_blank" rel="noopener">Open ↗</a>' +
          '<button class="btn" data-action="copy-rbx" data-id="' + esc(a.id) + '">⧉ rbxassetid</button>' +
          '<button class="btn" data-action="recheck-one" data-id="' + esc(a.id) + '">↻ Recheck</button>' +
          '<button class="btn danger" data-action="remove-one" data-id="' + esc(a.id) + '" title="Remove from tracker (and do not re-collect)">✕</button>' +
        '</div>' +
      '</div></article>';
  }

  function renderTabs() {
    if (!els.tabs) return;
    var c = countByStatus();
    var defs = [
      ['all', 'All', c.all], ['approved', '✔ Approved', c.approved], ['pending', '⏳ Pending', c.pending],
      ['moderated', '⛔ Moderated', c.moderated], ['unknown', '? Unknown', c.unknown]
    ];
    els.tabs.innerHTML = defs.map(function (d) {
      return '<button class="tab t-' + d[0] + (ui.tab === d[0] ? ' on' : '') + '" data-tab="' + d[0] + '">' + esc(d[1]) + ' <span class="n">(' + d[2] + ')</span></button>';
    }).join('');
    els.sub.textContent = 'Tracking ' + c.all + ' unique assets · ' + c.approved + ' approved · ' + c.pending + ' pending · ' + c.moderated + ' moderated' + (c.unknown ? ' · ' + c.unknown + ' unknown' : '');
    var ig = Object.keys(DB.ignored).length;
    if (els.resetIgnoredBtn) els.resetIgnoredBtn.textContent = 'Reset removed list (' + ig + ')';
    if (shadow) {
      var countSpans = shadow.querySelectorAll('[data-mod-count]');
      for (var ci = 0; ci < countSpans.length; ci++) countSpans[ci].textContent = '(' + c.moderated + ')';
    }
    if (els.purgeModBtn) els.purgeModBtn.style.display = c.moderated ? '' : 'none';
    if (els.modBlockInfo) {
      var blockedMods = blockedModeratedCount();
      els.modBlockInfo.textContent = blockedMods
        ? ('Currently blocking ' + blockedMods + ' moderated ID(s) from being logged again' + (settings.ignoreModerated ? '; “Don’t log moderated assets” is ON.' : '.'))
        : (settings.ignoreModerated ? '“Don’t log moderated assets” is ON — moderated assets will be skipped and their IDs blocked when seen.' : '');
    }
  }

  function renderTypeFilter() {
    if (!els.typeSel) return;
    var types = {};
    Object.keys(DB.assets).forEach(function (k) { var t = DB.assets[k].type; if (t) types[t] = 1; });
    var cur = ui.typeFilter;
    var html = '<option value="">All types</option>' + Object.keys(types).sort().map(function (t) {
      return '<option value="' + esc(t) + '"' + (t === cur ? ' selected' : '') + '>' + esc(t) + '</option>';
    }).join('');
    if (els.typeSel.innerHTML !== html) els.typeSel.innerHTML = html;
  }

  function renderList() {
    if (!els.list) return;
    pruneSelection();
    var list = visibleAssets();
    if (!Object.keys(DB.assets).length) {
      ui.lastRenderedIds = [];
      els.list.innerHTML = '<div class="empty">No assets tracked yet.<br><br>Open <b>Creations → Development Items</b> (Decals, Images, Audio, Models…) or your <b>Marketplace / Avatar Items</b> in the Creator Dashboard and page or scroll through them — every asset you view is collected here automatically, once per Asset ID.<br><br>You can also press <b>🔍 Scan page</b>, or use <b>＋ Add IDs/links</b> to paste/upload a pure list of Asset IDs or Roblox asset links and check them immediately.</div>';
      setupThumbnailLoader();
      updateLoadMoreBar(0, 0);
      syncSelectionUI();
      return;
    }
    if (!list.length) {
      ui.lastRenderedIds = [];
      els.list.innerHTML = '<div class="empty">No assets match the current tab / search / type filter.</div>';
      setupThumbnailLoader();
      updateLoadMoreBar(0, 0);
      syncSelectionUI();
      return;
    }
    var limit = Math.max(CONFIG.renderBatchSize, Number(ui.renderLimit) || CONFIG.renderBatchSize);
    var shown = list.slice(0, limit);
    ui.lastRenderedIds = shown.map(function (a) { return String(a.id); });
    var html = shown.map(cardHTML).join('');
    if (list.length > shown.length) {
      var remaining = list.length - shown.length;
      html += '<div class="loadmore"><span>Showing ' + shown.length + ' of ' + list.length + ' assets · ' + remaining + ' more are kept out of the DOM for faster thumbnail loading.</span>' +
        '<button class="btn primary" data-action="show-more">Load ' + Math.min(CONFIG.renderBatchSize, remaining) + ' more</button>' +
        '<button class="btn" data-action="show-all">Show all</button></div>';
    }
    els.list.innerHTML = html;
    setupThumbnailLoader();
    updateLoadMoreBar(list.length, shown.length);
    syncSelectionUI();
    // Upgrade only what is actually rendered, in background batches of 20.
    queueHighResThumbnails(shown);
    if (ui.detailsId) refreshOpenAssetDetails();
  }

  function updateFAB() {
    if (!els.fab) return;
    var c = countByStatus();
    els.fabCount.textContent = '(' + c.all + ')';
    els.fabPend.style.display = c.pending ? '' : 'none';
    els.fabPend.textContent = '⏳ ' + c.pending;
    var unseen = Object.keys(DB.assets).some(function (k) { return DB.assets[k].unseenChange; });
    els.fabDot.style.display = unseen ? '' : 'none';
  }

  function updateStatusBar() {
    if (!els.statusbar) return;
    var parts = [];
    parts.push('Auto-scan: ' + (settings.autoScan ? 'on' : 'OFF'));
    parts.push('Last scan: ' + (lastScanAt ? timeAgo(lastScanAt) : '—'));
    parts.push('Last recheck: ' + (lastRecheckAt ? timeAgo(lastRecheckAt) : '—'));
    if (htmlExportRunning) parts.push('⬇ ' + (htmlExportProgress || 'Preparing HTML export…'));
    if (recheckRunning) parts.push('⏳ ' + (recheckProgress || 'Rechecking…'));
    else if (nextRecheckAt) {
      var s = Math.max(0, Math.round((nextRecheckAt - Date.now()) / 1000));
      parts.push('Next automatic refresh in ' + Math.floor(s / 60) + 'm ' + (s % 60) + 's');
    } else parts.push('Auto recheck/refresh: off');
    els.statusbar.innerHTML = parts.map(function (p) { return '<span>' + esc(p) + '</span>'; }).join('');
  }

  function updateRecheckUI() {
    if (els.recheckBtn) {
      els.recheckBtn.disabled = recheckRunning;
      els.recheckBtn.textContent = recheckRunning ? '⏳ Rechecking…' : '↻ Recheck pending';
    }
    updateStatusBar();
  }

  function renderAll() {
    if (!shadow) return;
    renderTabs(); renderTypeFilter(); renderList(); updateFAB(); updateStatusBar(); updateRecheckUI();
  }

  var renderSoon = debounce(function () { if (ui.panelOpen) renderAll(); else updateFAB(); }, 300);
  function afterDBChange() { saveDBSoon(); updateFAB(); renderSoon(); }

  /* ============================== observers & init ============================== */
  function startObservers() {
    var debouncedScan = debounce(function () { if (settings.autoScan) scanPage('auto'); }, CONFIG.scanDebounceMs);
    try {
      var mo = new MutationObserver(function () { debouncedScan(); });
      mo.observe(document.body, { childList: true, subtree: true });
    } catch (e) { log('MutationObserver failed', e); }

    window.addEventListener('hashchange', function () {
      if (isFullPageRequested() && !ui.fullPage) setFullPageMode(true);
    });

    var lastHref = location.href;
    setInterval(function () {
      if (location.href !== lastHref) {
        lastHref = location.href;
        if (isFullPageRequested() && !ui.fullPage) setFullPageMode(true);
        lastScanSignature = ''; lastDetailSignature = '';
        setTimeout(function () { if (settings.autoScan) scanPage('nav'); }, 700);
      }
      // If a background tab throttled our timer, fire the recheck when noticed overdue.
      if (nextRecheckAt && Date.now() > nextRecheckAt + 15000 && !recheckRunning) recheckPending('auto-late');
    }, 1000);
  }

  function registerMenus() {
    try {
      if (typeof GM_registerMenuCommand !== 'function') return;
      GM_registerMenuCommand('Asset Tracker: Open/close panel', function () { buildUI(); togglePanel(); });
      GM_registerMenuCommand('Asset Tracker: Open live full-page tracker', function () { buildUI(); openFullPageTracker(); });
      GM_registerMenuCommand('Asset Tracker: Scan this page', function () { lastScanSignature = ''; scanPage('manual', true); });
      GM_registerMenuCommand('Asset Tracker: Add asset IDs/links…', function () { buildUI(); togglePanel(true); openManualAdd(); });
      GM_registerMenuCommand('Asset Tracker: Recheck pending now', function () { recheckPending('manual'); });
      GM_registerMenuCommand('Asset Tracker: Refresh approved assets now', function () {
        refreshApprovedAssets('approved-menu', { manual: true, forceBatch: true, limit: 100, announce: true });
      });
      GM_registerMenuCommand('Asset Tracker: Load more assets', function () { buildUI(); togglePanel(true); showMoreAssets(); });
      GM_registerMenuCommand('Asset Tracker: Remove all moderated assets', function () { purgeModeratedWithConfirm(); });
      GM_registerMenuCommand('Asset Tracker: Export JSON', function () { exportJSON(); });
      GM_registerMenuCommand('Asset Tracker: Export HTML report', function () { exportHTML(); });
    } catch (e) {}
  }

  function init() {
    ui.fullPage = isFullPageRequested();
    if (ui.fullPage) ui.panelOpen = true;
    buildUI();
    registerMenus();
    registerStorageSync();
    startObservers();
    if (ui.fullPage) setFullPageMode(true);
    scheduleRecheck();
    setTimeout(function () { if (settings.autoScan) scanPage('init'); }, 1200);
    // Back-fill names/descriptions for records collected in earlier sessions.
    if (settings.enrichDescriptions) Object.keys(DB.assets).forEach(queueEnrich);
    log('initialized. Tracked assets:', Object.keys(DB.assets).length, 'settings:', settings);
  }

  /* Patch the network as early as possible (script runs at document-start). */
  try { patchNetwork(); } catch (e) { log('patchNetwork error', e); }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();

  /* Debug/testing handle (also handy in DevTools: __RCAT__.scanPage('manual', true)) */
  try {
    var api = {
      version: '1.5.0',
      get db() { return DB; },
      settings: settings,
      ui: ui,
      scanPage: scanPage,
      recheckPending: recheckPending,
      recheckAssets: recheckAssets,
      approvedIdsOldestFirst: approvedIdsOldestFirst,
      staleApprovedIds: staleApprovedIds,
      refreshApprovedAssets: refreshApprovedAssets,
      selectedAssetIds: selectedAssetIds,
      setAssetSelected: setAssetSelected,
      clearSelection: clearSelection,
      selectRenderedAssets: function () { buildUI(); return selectRenderedAssets(); },
      selectFilteredAssets: function () { buildUI(); return selectFilteredAssets(); },
      renderedAssetIds: renderedAssetIds,
      removeAssetsByIds: removeAssetsByIds,
      removeSelectedAssetsWithConfirm: removeSelectedAssetsWithConfirm,
      openSelectedAssets: openSelectedAssets,
      showSelectedDetails: showSelectedDetails,
      showMoreAssets: function () { buildUI(); return showMoreAssets(); },
      updateLoadMoreBar: updateLoadMoreBar,
      normalizeManualAssetId: normalizeManualAssetId,
      extractManualAssetFromLink: extractManualAssetFromLink,
      manualEntryFromToken: manualEntryFromToken,
      parseManualAssetEntries: parseManualAssetEntries,
      addManualAssets: addManualAssets,
      manualAddSummaryText: manualAddSummaryText,
      openManualAdd: function () { buildUI(); togglePanel(true); return openManualAdd(); },
      closeManualAdd: function () { buildUI(); return closeManualAdd(); },
      updateManualAddPreview: function () { buildUI(); return updateManualAddPreview(); },
      loadManualAddFile: loadManualAddFile,
      submitManualAdd: function () { buildUI(); return submitManualAddFromUI(); },
      assetsForExport: assetsForExport,
      exportJSON: exportJSON,
      exportCSV: exportCSV,
      exportHTML: exportHTML,
      statusFromBadgeText: statusFromBadgeText,
      scanStatusIn: scanStatusIn,
      currentDetailAssetId: currentDetailAssetId,
      upsertAsset: upsertAsset,
      harvestFromJSON: harvestFromJSON,
      extractAssetRecord: extractAssetRecord,
      normalizeStatusString: normalizeStatusString,
      countByStatus: countByStatus,
      removeModeratedAssets: removeModeratedAssets,
      purgeModeratedWithConfirm: purgeModeratedWithConfirm,
      blockedModeratedCount: blockedModeratedCount,
      buildHTMLReport: buildHTMLReport,
      openAssetDetails: openAssetDetails,
      closeAssetDetails: closeAssetDetails,
      needsHighResThumbnail: needsHighResThumbnail,
      guessThumbnailWidth: guessThumbnailWidth,
      mergeStoredDB: mergeStoredDB,
      syncDBFromStorage: syncDBFromStorage,
      mergeStoredSettings: mergeStoredSettings,
      syncSettingsFromStorage: syncSettingsFromStorage,
      isFullPageRequested: isFullPageRequested,
      fullPageUrl: fullPageUrl,
      openFullPageTracker: function () { buildUI(); return openFullPageTracker(); },
      setFullPageMode: function (on) { buildUI(); return setFullPageMode(on); },
      open: function () { buildUI(); togglePanel(true); }
    };
    try { window.__RCAT__ = api; } catch (e) {}
    try { if (pageWin && pageWin !== window) pageWin.__RCAT__ = api; } catch (e) {}
  } catch (e) {}
})();

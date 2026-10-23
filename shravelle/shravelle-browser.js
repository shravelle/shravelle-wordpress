/*!
 * Shravelle Browser SDK — real user monitoring for any website.
 * Works with plain HTML, React, Angular, Vue, Next.js, WordPress, etc.
 *
 * <script src="/shravelle-browser.js"></script>
 * <script>
 *   Shravelle.init({ endpoint: "https://ingest.example.com", key: "shv_brw_...", app: "shop-web", release: "5.3.0",
 *                  tracePropagationTargets: ["api.example.com"] });
 * </script>
 *
 * Collects: page views (incl. SPA route changes), Core Web Vitals (LCP, INP,
 * CLS, FCP, TTFB), JavaScript errors and unhandled promise rejections,
 * fetch/XHR calls (with W3C traceparent injection to link browser and
 * backend traces), click breadcrumbs and custom events.
 *
 * No data is lost on flaky networks: events are queued in memory, mirrored
 * to localStorage, flushed with sendBeacon when the page is hidden, and
 * retried with backoff on the next page load if delivery failed.
 */
(function (global) {
  "use strict";
  if (global.Shravelle && global.Shravelle.__loaded) return;

  var cfg = { endpoint: "", key: "", app: "web", release: "", sampleRate: 1, flushInterval: 5000, maxBatch: 100,
              tracePropagationTargets: [], captureClicks: true, captureAjax: true, beforeSend: null };
  var queue = [], userId = "", sessionId = "", started = false, sampled = true, retryDelay = 2000;
  var STORE = "__shravelle_q", SESSION = "__shravelle_s", MAX_STORED = 2000;

  function now() { return new Date().toISOString(); }
  function rnd(n) {
    var a = new Uint8Array(n);
    (global.crypto || global.msCrypto).getRandomValues(a);
    return Array.prototype.map.call(a, function (b) { return ("0" + b.toString(16)).slice(-2); }).join("");
  }
  function safe(fn) { return function () { try { return fn.apply(this, arguments); } catch (e) { /* never break the host page */ } }; }

  function loadSession() {
    try {
      var s = JSON.parse(localStorage.getItem(SESSION) || "null");
      if (s && Date.now() - s.t < 30 * 60 * 1000) { s.t = Date.now(); localStorage.setItem(SESSION, JSON.stringify(s)); return s.id; }
      var id = rnd(16); localStorage.setItem(SESSION, JSON.stringify({ id: id, t: Date.now() })); return id;
    } catch (e) { return rnd(16); }
  }

  function persist() {
    try { localStorage.setItem(STORE, JSON.stringify(queue.slice(-MAX_STORED))); } catch (e) {}
  }
  function restore() {
    try { var q = JSON.parse(localStorage.getItem(STORE) || "[]"); if (q.length) queue = q.concat(queue); } catch (e) {}
  }

  function push(ev) {
    if (!started || !sampled) return;
    ev.timestamp = ev.timestamp || now();
    ev.page_url = ev.page_url || location.href;
    ev.session_id = sessionId;
    if (userId) ev.user_id = userId;
    if (cfg.beforeSend) { ev = cfg.beforeSend(ev); if (!ev) return; }
    queue.push(ev);
    if (queue.length > MAX_STORED) queue.splice(0, queue.length - MAX_STORED);
    persist();
    if (queue.length >= cfg.maxBatch) flush();
  }

  // endpoint may be a list of gateways: on failure the SDK fails over
  var epIndex = 0;
  function endpoints() { return [].concat(cfg.endpoint); }
  function url() { var e = endpoints(); return String(e[epIndex % e.length]).replace(/\/$/, "") + "/v1/rum?key=" + encodeURIComponent(cfg.key); }
  function payload(events) { return JSON.stringify({ app: cfg.app, session_id: sessionId, user_id: userId, release: cfg.release, events: events }); }

  var inflight = false;
  function flush(useBeacon) {
    if (!queue.length || inflight) return;
    var batch = queue.slice(0, cfg.maxBatch);
    var body = payload(batch);
    if (useBeacon && navigator.sendBeacon) {
      // text/plain avoids a CORS preflight, which beacons cannot do
      if (navigator.sendBeacon(url(), new Blob([body], { type: "text/plain" }))) { queue.splice(0, batch.length); persist(); }
      return;
    }
    inflight = true;
    origFetch(url(), { method: "POST", body: body, keepalive: body.length < 60000, headers: { "Content-Type": "text/plain" } })
      .then(function (r) {
        inflight = false;
        if (r.ok || r.status === 400 || r.status === 401 || r.status === 403) { // delivered, or will never be accepted
          queue.splice(0, batch.length); persist(); retryDelay = 2000;
          if (queue.length) setTimeout(flush, 0);
        } else { backoff(); }
      }, function () { inflight = false; backoff(); });
  }
  function backoff() { epIndex++; retryDelay = Math.min(retryDelay * 2, 60000); setTimeout(flush, retryDelay); }

  // ---- page views & SPA navigation ----------------------------------------
  var lastPath = "";
  function pageView(kind) {
    var href = location.href;
    if (href === lastPath) return;
    lastPath = href;
    var nav = performance.getEntriesByType && performance.getEntriesByType("navigation")[0];
    var load = kind === "initial" && nav ? nav.loadEventEnd || nav.domComplete || nav.duration : 0;
    push({ type: "page_view", name: kind, duration_ms: load, referrer: document.referrer });
  }
  function patchHistory() {
    ["pushState", "replaceState"].forEach(function (m) {
      var orig = history[m];
      history[m] = function () { var r = orig.apply(this, arguments); setTimeout(safe(function () { pageView("route_change"); }), 0); return r; };
    });
    addEventListener("popstate", safe(function () { pageView("route_change"); }));
    addEventListener("hashchange", safe(function () { pageView("route_change"); }));
  }

  // ---- Core Web Vitals ---------------------------------------------------------
  function observe(type, cb, opts) {
    try { var po = new PerformanceObserver(function (l) { l.getEntries().forEach(cb); }); po.observe(Object.assign({ type: type, buffered: true }, opts || {})); return po; } catch (e) { return null; }
  }
  function vitals() {
    var lcp = 0, cls = 0, inp = 0, sent = false;
    observe("largest-contentful-paint", function (e) { lcp = e.startTime; });
    observe("layout-shift", function (e) { if (!e.hadRecentInput) cls += e.value; });
    observe("event", function (e) { if (e.interactionId && e.duration > inp) inp = e.duration; }, { durationThreshold: 16 });
    observe("paint", function (e) { if (e.name === "first-contentful-paint") push({ type: "web_vital", name: "FCP", value: e.startTime }); });
    var nav = performance.getEntriesByType && performance.getEntriesByType("navigation")[0];
    if (nav) push({ type: "web_vital", name: "TTFB", value: nav.responseStart });
    function report() {
      if (sent) return; sent = true;
      if (lcp) push({ type: "web_vital", name: "LCP", value: lcp });
      push({ type: "web_vital", name: "CLS", value: Math.round(cls * 10000) / 10000 });
      if (inp) push({ type: "web_vital", name: "INP", value: inp });
    }
    addEventListener("visibilitychange", function () { if (document.visibilityState === "hidden") report(); }, true);
    addEventListener("pagehide", report, true);
  }

  // ---- errors ------------------------------------------------------------------
  function errors() {
    addEventListener("error", safe(function (e) {
      if (e.target && e.target !== global && (e.target.src || e.target.href)) {
        push({ type: "js_error", name: "ResourceError", message: "Failed to load " + (e.target.src || e.target.href) });
        return;
      }
      var err = e.error || {};
      push({ type: "js_error", name: err.name || "Error", message: e.message || String(err), stack: err.stack || (e.filename + ":" + e.lineno + ":" + e.colno) });
    }), true);
    addEventListener("unhandledrejection", safe(function (e) {
      var r = e.reason || {};
      push({ type: "js_error", name: r.name || "UnhandledRejection", message: r.message || String(r), stack: r.stack || "" });
    }));
  }

  // ---- fetch / XHR -----------------------------------------------------------------
  var origFetch = global.fetch ? global.fetch.bind(global) : null;
  function isOwn(u) { return endpoints().some(function (e) { return u.indexOf(e) === 0; }); }
  function shouldTrace(u) {
    try {
      var host = new URL(u, location.href).host;
      if (host === location.host) return true;
      return cfg.tracePropagationTargets.some(function (t) { return t instanceof RegExp ? t.test(u) : host === t || u.indexOf(t) === 0; });
    } catch (e) { return false; }
  }
  function ajaxName(method, u) {
    try { var p = new URL(u, location.href); return method + " " + p.host + p.pathname.replace(/\/\d+(?=\/|$)/g, "/:id").replace(/[0-9a-f]{8}-[0-9a-f-]{27}/gi, ":uuid"); }
    catch (e) { return method + " " + u; }
  }
  function ajax() {
    if (origFetch) {
      global.fetch = function (input, init) {
        var u = typeof input === "string" ? input : (input && input.url) || "";
        if (isOwn(u)) return origFetch(input, init);
        var method = ((init && init.method) || (input && input.method) || "GET").toUpperCase();
        var start = performance.now(), traceId = "";
        if (shouldTrace(u)) {
          traceId = rnd(16);
          init = Object.assign({}, init || {});
          var h = new Headers((init && init.headers) || (input && input.headers) || {});
          h.set("traceparent", "00-" + traceId + "-" + rnd(8) + "-01");
          init.headers = h;
        }
        return origFetch(input, init).then(function (r) {
          push({ type: "ajax", name: ajaxName(method, u), duration_ms: performance.now() - start, status: r.status, trace_id: traceId });
          return r;
        }, function (err) {
          push({ type: "ajax", name: ajaxName(method, u), duration_ms: performance.now() - start, status: 0, message: String(err), trace_id: traceId });
          throw err;
        });
      };
    }
    var XO = XMLHttpRequest.prototype.open, XS = XMLHttpRequest.prototype.send;
    XMLHttpRequest.prototype.open = function (m, u) { this.__o = { m: String(m).toUpperCase(), u: String(u) }; return XO.apply(this, arguments); };
    XMLHttpRequest.prototype.send = function () {
      var x = this, o = x.__o;
      if (o && !isOwn(o.u)) {
        var start = performance.now(), traceId = "";
        if (shouldTrace(o.u)) { traceId = rnd(16); try { x.setRequestHeader("traceparent", "00-" + traceId + "-" + rnd(8) + "-01"); } catch (e) {} }
        x.addEventListener("loadend", safe(function () {
          push({ type: "ajax", name: ajaxName(o.m, o.u), duration_ms: performance.now() - start, status: x.status, trace_id: traceId });
        }));
      }
      return XS.apply(this, arguments);
    };
  }

  // ---- breadcrumbs -------------------------------------------------------------------
  function clicks() {
    addEventListener("click", safe(function (e) {
      var el = e.target && e.target.closest ? e.target.closest("a,button,[role=button],input[type=submit]") : null;
      if (!el) return;
      var label = (el.getAttribute("data-shravelle-name") || el.getAttribute("aria-label") || el.innerText || el.value || el.id || el.tagName).trim().slice(0, 80);
      push({ type: "custom", name: "click", message: label, attributes: { element: el.tagName.toLowerCase(), id: el.id || "", href: el.getAttribute("href") || "" } });
    }), true);
  }

  var Shravelle = {
    __loaded: true,
    init: safe(function (opts) {
      if (started) return;
      for (var k in opts) if (Object.prototype.hasOwnProperty.call(opts, k)) cfg[k] = opts[k];
      if (!cfg.endpoint || !cfg.key) { console.warn("[shravelle] endpoint and key are required"); return; }
      sessionId = loadSession();
      // sampling is per session so a session is either fully kept or not
      sampled = parseInt(sessionId.slice(0, 8), 16) / 0xffffffff < cfg.sampleRate;
      started = true;
      restore();
      errors(); vitals(); patchHistory();
      if (cfg.captureAjax) ajax();
      if (cfg.captureClicks) clicks();
      if (document.readyState === "complete") pageView("initial");
      else addEventListener("load", safe(function () { setTimeout(function () { pageView("initial"); }, 0); }));
      setInterval(safe(function () { flush(); }), cfg.flushInterval);
      addEventListener("visibilitychange", function () { if (document.visibilityState === "hidden") flush(true); });
      addEventListener("pagehide", function () { flush(true); });
      addEventListener("online", function () { flush(); });
    }),
    setUser: function (id) { userId = String(id || ""); },
    track: safe(function (name, attributes, value) { push({ type: "custom", name: String(name), attributes: attributes || {}, value: value || 0 }); }),
    error: safe(function (err, attributes) {
      err = err || {};
      push({ type: "js_error", name: err.name || "Error", message: err.message || String(err), stack: err.stack || "", attributes: attributes || {} });
    }),
    flush: function () { flush(); }
  };
  global.Shravelle = Shravelle;
  if (typeof module !== "undefined" && module.exports) module.exports = Shravelle;
})(typeof window !== "undefined" ? window : this);

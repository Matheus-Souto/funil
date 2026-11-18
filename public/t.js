/*! funil t.js: leva UTMs e indicação da página de vendas ao checkout. Guarda só em localStorage (funil_touch). */
(function () {
  var K = ["utm_source", "utm_medium", "utm_campaign", "utm_content", "utm_term", "fbclid", "ref"];
  var S = "funil_touch", w = window, d = document;
  var me = d.currentScript || d.querySelector("script[data-checkout]");
  var host = ((me && me.getAttribute("data-checkout")) || "").replace(/^https?:\/\//, "").replace(/\/.*$/, "").toLowerCase();
  if (!host) return;
  function pick(q) {
    var o = {}, n = 0;
    for (var i = 0; i < K.length; i++) {
      var v = q.get(K[i]);
      if (v) { o[K[i]] = v.slice(0, 500); n++; }
    }
    return n ? o : null;
  }
  var st = null, now = null, ft = "";
  try { st = JSON.parse(w.localStorage.getItem(S) || "null"); } catch {}
  if (!st || typeof st !== "object") st = {};
  try { now = pick(new URLSearchParams(w.location.search)); } catch {}
  if (now) {
    st.last = now;
    if (!st.first) st.first = now;
    try { w.localStorage.setItem(S, JSON.stringify(st)); } catch {}
  }
  var last = st.last && typeof st.last === "object" ? st.last : null;
  if (st.first && typeof st.first === "object") {
    try {
      var b = new TextEncoder().encode(JSON.stringify(st.first)), s = "";
      if (b.length <= 1024) {
        for (var j = 0; j < b.length; j++) s += String.fromCharCode(b[j]);
        ft = btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
      }
    } catch {}
  }
  function deco(a) {
    try {
      var h = a.getAttribute("href");
      if (!h) return;
      var u = new URL(h, w.location.href);
      if (u.host.toLowerCase() !== host || !/^https?:$/.test(u.protocol)) return;
      var p = u.searchParams, ch = false;
      if (last) for (var k in last) {
        if (K.indexOf(k) >= 0 && typeof last[k] === "string" && !p.has(k)) { p.set(k, last[k]); ch = true; }
      }
      if (ft && !p.has("ft")) { p.set("ft", ft); ch = true; }
      if (ch) a.setAttribute("href", u.toString());
    } catch {}
  }
  function all() {
    var l = d.getElementsByTagName("a");
    for (var i = 0; i < l.length; i++) deco(l[i]);
  }
  function on(e) {
    var t = e.target;
    while (t && t.nodeName !== "A") t = t.parentNode;
    if (t) deco(t);
  }
  all();
  if (d.readyState === "loading") d.addEventListener("DOMContentLoaded", all);
  d.addEventListener("mousedown", on, true);
  d.addEventListener("click", on, true);
  d.addEventListener("touchstart", on, { capture: true, passive: true });
})();

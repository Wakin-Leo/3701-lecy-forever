/* Daily Digest — front-end logic. No build step, no dependencies. */
(function () {
  "use strict";

  var REPO = "Wakin-Leo/3701-lecy-forever";
  var API = "https://api.github.com/repos/" + REPO + "/contents/";
  var RECENT_WINDOW_DAYS = 30;
  var PALETTE = ["#1f3a5f", "#8c2f39", "#2f6f4f", "#7a5c1e", "#5b3a8c",
                 "#a34a1f", "#1e6e7a", "#6d3b5e", "#45526b", "#3f6212"];
  var ROUTES = ["home", "latest", "archive", "favs", "notes", "bean", "admin"];

  /* field taxonomy: slug -> field key */
  var FIELD_ORDER = ["pa", "polisci", "psych", "ling", "other"];
  var FIELD_LABEL = { pa: "PA", polisci: "政治学", psych: "心理学", ling: "语言学", other: "其他" };
  var JFIELD = {
    "pub-admin": "pa", "par": "pa", "pmr": "pa", "governance": "pa", "jpart": "pa",
    "ppmg": "pa", "reg-gov": "pa", "policy-sci": "pa", "policy-politics": "pa",
    "polcomm": "polisci", "polpsych": "polisci",
    "jesp": "psych",
    "das": "ling", "jlp": "ling", "appl-ling": "ling", "ling-typ": "ling",
    "appl-corpus-ling": "ling", "j-socioling": "ling", "cds": "ling",
    "jlsp": "ling", "ijld": "ling", "discourse-edu": "ling"
  };

  var S = {
    config: null,
    manifest: null,
    jBySlug: {},
    shardCache: {},   // "slug/year" -> array
    jColor: {},       // slug -> color
    workIndex: {},    // doi -> work (with _j journal name)
    favs: { categories: ["待读", "重要"], items: [] },
    highlights: { items: [] },
    diary: { items: [] },
    annis: { items: [] },
    works: { items: [] },
    read: { items: [] },
    beanInit: false,
    favCat: null,     // active category filter in favs view
    activeJournals: null,
    query: "",
    oaOnly: false,
    unreadOnly: false,
    adminList: null,
    route: "latest"
  };

  function $(id) { return document.getElementById(id); }
  function esc(s) {
    return String(s == null ? "" : s)
      .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }
  function nowStr() {
    var d = new Date();
    function p(n) { return ("0" + n).slice(-2); }
    return d.getFullYear() + "-" + p(d.getMonth() + 1) + "-" + p(d.getDate()) +
           " " + p(d.getHours()) + ":" + p(d.getMinutes());
  }

  /* ---------- toast ---------- */
  var toastTimer = null;
  function toast(msg, sticky) {
    var t = $("toast");
    t.textContent = msg;
    t.hidden = false;
    if (toastTimer) clearTimeout(toastTimer);
    if (!sticky) toastTimer = setTimeout(function () { t.hidden = true; }, 2600);
  }

  /* ---------- gate ---------- */

  function sha256Hex(text) {
    var enc = new TextEncoder().encode(text);
    return crypto.subtle.digest("SHA-256", enc).then(function (buf) {
      return Array.prototype.map.call(new Uint8Array(buf), function (b) {
        return ("0" + b.toString(16)).slice(-2);
      }).join("");
    });
  }

  function initGate() {
    if (sessionStorage.getItem("gate") === "1") { enterApp(); return; }
    $("gate-form").addEventListener("submit", function (e) {
      e.preventDefault();
      sha256Hex($("gate-input").value).then(function (h) {
        if (h === S.config.password_sha256) {
          sessionStorage.setItem("gate", "1");
          enterApp();
        } else {
          $("gate-err").textContent = "口令不正确";
          $("gate-input").value = "";
          $("gate-input").focus();
        }
      });
    });
    $("gate-input").focus();
  }

  function enterApp() {
    $("gate").hidden = true;
    $("app").hidden = false;
    boot();
  }

  /* ---------- plain data reads ---------- */

  function fetchJson(path) {
    return fetch(path + (path.indexOf("?") < 0 ? "?" : "&") + "t=" + Date.now())
      .then(function (r) { if (!r.ok) throw new Error(path + ": " + r.status); return r.json(); });
  }

  function loadShard(slug, year) {
    var key = slug + "/" + year;
    if (S.shardCache[key]) return Promise.resolve(S.shardCache[key]);
    return fetchJson("data/" + key + ".json").then(function (d) {
      S.shardCache[key] = d;
      return d;
    }).catch(function () { return []; });
  }

  function loadUserJson(name, fallback) {
    return fetchJson("user/" + name + ".json").catch(function () { return fallback; });
  }

  /* ---------- GitHub write helpers (token in localStorage) ---------- */

  function ghHeaders() {
    return {
      "Authorization": "Bearer " + (localStorage.getItem("gh_token") || ""),
      "Accept": "application/vnd.github+json"
    };
  }
  function requireToken() {
    if (localStorage.getItem("gh_token")) return true;
    toast("请先到「期刊管理」页保存 GitHub 令牌");
    return false;
  }
  function ghGetFile(path) {
    return fetch(API + encodeURI(path), { headers: ghHeaders() }).then(function (r) {
      if (r.status === 404) return r.text().then(function () { return null; });
      if (!r.ok) throw new Error("读取失败 " + r.status);
      return r.json();
    });
  }
  function decodeFile(f) {
    return JSON.parse(decodeURIComponent(escape(atob(f.content.replace(/\n/g, "")))));
  }
  function b64(s) { return btoa(unescape(encodeURIComponent(s))); }
  function ghPutRaw(path, text, sha, message) {
    var body = { message: message, content: b64(text) };
    if (sha) body.sha = sha;
    return fetch(API + encodeURI(path), {
      method: "PUT", headers: ghHeaders(), body: JSON.stringify(body)
    }).then(function (r) {
      if (!r.ok) throw new Error("写入失败 " + r.status);
      return r.json();
    });
  }
  function ghPutB64(path, b64content, message) {
    // binary-safe variant: content already base64 (e.g. an image)
    return fetch(API + encodeURI(path), {
      method: "PUT", headers: ghHeaders(),
      body: JSON.stringify({ message: message, content: b64content })
    }).then(function (r) {
      if (!r.ok) throw new Error("写入失败 " + r.status);
      return r.json();
    });
  }
  function ghDeleteFile(path, sha, message) {
    return fetch(API + encodeURI(path), {
      method: "DELETE", headers: ghHeaders(),
      body: JSON.stringify({ message: message, sha: sha })
    }).then(function (r) {
      if (!r.ok) throw new Error("删除失败 " + r.status);
      return r.json();
    });
  }

  /* ---------- entry rendering ---------- */

  function oaLabel(status) { return status === "closed" ? "非 OA" : "OA"; }

  function isFaved(doi) {
    return S.favs.items.some(function (x) { return x.doi === doi; });
  }

  function isRead(doi) {
    return S.read.items.indexOf(doi) >= 0;
  }

  function entryHtml(w, journalName) {
    var doiUrl = "https://doi.org/" + w.doi;
    var color = S.jColor[w._slug] || "var(--line)";
    var oaCls = w.oa === "closed" ? "oa-badge closed" : "oa-badge";
    var abs = w.abs
      ? '<details class="abs"><summary>摘要</summary><p>' + esc(w.abs) + "</p>" +
        '<div class="abs-zh" hidden></div><button class="tr-btn">翻译摘要</button></details>'
      : (w.oa ? '<div class="kws"><span class="kw">摘要缺失</span></div>' : "");
    var star = isFaved(w.doi) ? "★" : "☆";
    var read = isRead(w.doi);
    return '<div class="entry' + (read ? " is-read" : "") + '" style="--jc:' + color + '" data-doi="' + esc(w.doi) + '">' +
      '<button class="read-toggle' + (read ? " on" : "") + '" data-doi="' + esc(w.doi) +
      '" title="' + (read ? "取消已读" : "标为已读") + '">' + (read ? "已读" : "标为已读") + "</button>" +
      '<div class="entry-title">' + esc(w.t) + '</div><div class="title-zh" hidden></div>' +
      '<div class="entry-meta"><span class="jtag"><span class="dot"></span>' + esc(journalName) + "</span>" +
      "<span>" + esc(w.a.join(", ")) + "</span>" +
      (w.oa ? '<span class="' + oaCls + '">' + esc(oaLabel(w.oa)) + "</span>" : "") +
      '<button class="cite-btn" data-doi="' + esc(w.doi) + '" title="复制 APA 引文">APA</button>' +
      '<button class="fav-btn' + (isFaved(w.doi) ? " faved" : "") + '" data-doi="' + esc(w.doi) +
      '" title="收藏">' + star + "</button></div>" +
      '<div class="doi-line">DOI：<a href="' + esc(doiUrl) + '" target="_blank" rel="noopener">' + esc(w.doi) + "</a>" +
      (w.pdf ? ' · <a class="pdf-link" href="' + esc(w.pdf) + '" target="_blank" rel="noopener">PDF 全文</a>' : "") +
      "</div>" +
      abs + "</div>";
  }

  function renderGrouped(list, container, journalMap) {
    if (!list.length) { container.innerHTML = '<div class="empty">没有符合条件的记录</div>'; return; }
    var html = "", lastDate = "";
    list.forEach(function (w) {
      w._j = journalMap[w._slug] || w.j || "";
      S.workIndex[w.doi] = w;
      if (w.d !== lastDate) {
        lastDate = w.d;
        html += '<div class="date-head">' + esc(w.d) + "</div>";
      }
      html += entryHtml(w, w._j);
    });
    container.innerHTML = html;
    translateTitles(container);
  }

  function passesFilters(w) {
    if (S.activeJournals && !S.activeJournals.has(w._slug)) return false;
    if (S.oaOnly && w.oa === "closed") return false;
    if (S.unreadOnly && isRead(w.doi)) return false;
    if (S.query) {
      var hay = (w.t + " " + (w.abs || "") + " " + (w.k || []).join(" ")).toLowerCase();
      if (hay.indexOf(S.query) < 0) return false;
    }
    return true;
  }

  /* ---------- latest view ---------- */

  function soloJournal() {
    // returns the slug when the filter is exactly one journal, else null
    if (S.activeJournals && S.activeJournals.size === 1) {
      return Array.from(S.activeJournals)[0];
    }
    return null;
  }

  function renderChips() {
    var box = $("journal-chips");
    box.innerHTML = "";
    var solo = soloJournal();

    // group journals by field, preserving manifest order inside each field
    var groups = {};
    S.manifest.journals.forEach(function (j) {
      var f = JFIELD[j.slug] || "other";
      (groups[f] = groups[f] || []).push(j);
    });

    FIELD_ORDER.forEach(function (f) {
      var js = groups[f];
      if (!js || !js.length) return;
      var wrap = document.createElement("div");
      wrap.className = "fgroup";
      var chip = document.createElement("button");
      var anyOn = js.some(function (j) { return !S.activeJournals || S.activeJournals.has(j.slug); });
      chip.className = "chip fchip" + (anyOn && solo ? " on" : "");
      chip.innerHTML = esc(FIELD_LABEL[f]) + ' <span class="caret">▾</span>';
      chip.onclick = function (e) {
        e.stopPropagation();
        var wasOpen = wrap.classList.contains("open");
        document.querySelectorAll(".fgroup.open").forEach(function (g) { g.classList.remove("open"); });
        if (!wasOpen) wrap.classList.add("open");
      };
      var panel = document.createElement("div");
      panel.className = "fpanel";
      js.forEach(function (j) {
        var b = document.createElement("button");
        b.className = "fjournal" + (solo === j.slug ? " on" : "");
        b.innerHTML = '<span class="dot" style="background:' + S.jColor[j.slug] + '"></span>' + esc(j.name);
        b.onclick = function (e) {
          e.stopPropagation();
          if (solo === j.slug) {
            S.activeJournals = null;           // click again: back to all
          } else {
            S.activeJournals = new Set([j.slug]);
          }
          document.querySelectorAll(".fgroup.open").forEach(function (g) { g.classList.remove("open"); });
          renderChips(); renderLatest();
        };
        panel.appendChild(b);
      });
      wrap.appendChild(chip);
      wrap.appendChild(panel);
      box.appendChild(wrap);
    });

    // active single-journal filter indicator
    if (solo) {
      var j = S.manifest.journals.filter(function (x) { return x.slug === solo; })[0];
      var ind = document.createElement("button");
      ind.className = "chip filter-ind";
      ind.innerHTML = "仅看：" + esc(j ? j.name : solo) + " ✕";
      ind.onclick = function () {
        S.activeJournals = null;
        renderChips(); renderLatest();
      };
      box.appendChild(ind);
    }
  }

  // close field panels on outside click
  document.addEventListener("click", function (e) {
    if (!(e.target.closest && e.target.closest(".fgroup"))) {
      document.querySelectorAll(".fgroup.open").forEach(function (g) { g.classList.remove("open"); });
    }
  });

  function renderLatest() {
    var container = $("latest-list");
    container.innerHTML = '<div class="loading">正在加载题录…</div>';
    var cutoff = new Date();
    cutoff.setDate(cutoff.getDate() - RECENT_WINDOW_DAYS);
    var cut = cutoff.toISOString().slice(0, 10);
    var today = new Date().toISOString().slice(0, 10);
    var year = new Date().getFullYear();
    var years = [String(year), String(year - 1)];
    var jobs = [];
    S.manifest.journals.forEach(function (j) {
      years.forEach(function (y) {
        if (j.years && j.years[y]) jobs.push(loadShard(j.slug, y).then(function (d) {
          d.forEach(function (w) { w._slug = j.slug; });
          return d;
        }));
      });
    });
    var jmap = {};
    S.manifest.journals.forEach(function (j) { jmap[j.slug] = j.name; });
    Promise.all(jobs).then(function (sets) {
      var all = [];
      sets.forEach(function (d) {
        d.forEach(function (w) { if (w.d >= cut) all.push(w); });
      });
      all.sort(function (a, b) { return a.d < b.d ? 1 : -1; });
      var shown = all.filter(passesFilters);
      var nToday = all.filter(function (w) { return w.d === today; }).length;
      $("stats").textContent = "近 " + RECENT_WINDOW_DAYS + " 天共 " + shown.length +
        " 条" + (nToday ? " · 今日新增 " + nToday + " 条" : "");
      renderGrouped(shown, container, jmap);
    });
  }

  /* ---------- archive view ---------- */

  function initArchive() {
    var sel = $("arc-journal");
    sel.innerHTML = "";
    S.manifest.journals.forEach(function (j) {
      var o = document.createElement("option");
      o.value = j.slug; o.textContent = j.name;
      sel.appendChild(o);
    });
    sel.onchange = fillYears;
    $("arc-year").onchange = renderArchive;
    fillYears();
  }

  function fillYears() {
    var slug = $("arc-journal").value;
    var j = S.manifest.journals.filter(function (x) { return x.slug === slug; })[0];
    var ys = $("arc-year");
    ys.innerHTML = "";
    Object.keys(j.years || {}).sort().reverse().forEach(function (y) {
      var o = document.createElement("option");
      o.value = y; o.textContent = y + "（" + j.years[y] + " 条）";
      ys.appendChild(o);
    });
    renderArchive();
  }

  function renderArchive() {
    var slug = $("arc-journal").value, year = $("arc-year").value;
    var container = $("archive-list");
    if (!slug || !year) { container.innerHTML = '<div class="empty">该刊暂无回溯数据</div>'; return; }
    container.innerHTML = '<div class="loading">正在加载题录…</div>';
    var jmap = {}; jmap[slug] = $("arc-journal").selectedOptions[0].textContent;
    loadShard(slug, year).then(function (d) {
      d.forEach(function (w) { w._slug = slug; });
      renderGrouped(d.filter(passesFilters), container, jmap);
    });
  }

  /* ---------- favorites ---------- */

  function saveFavsToRepo() {
    return ghGetFile("user/favorites.json").then(function (f) {
      return ghPutRaw("user/favorites.json", JSON.stringify(S.favs, null, 2),
        f && f.sha, "fav: update");
    });
  }

  function addFav(doi, cat) {
    var w = S.workIndex[doi];
    if (!w) { toast("找不到该条目数据"); return; }
    if (S.favs.categories.indexOf(cat) < 0) S.favs.categories.push(cat);
    var existing = S.favs.items.filter(function (x) { return x.doi === doi; })[0];
    if (existing) existing.cat = cat;
    else S.favs.items.unshift({
      doi: doi, t: w.t, a: w.a, d: w.d, j: w._j || "",
      oa: w.oa || "closed", url: w.url || "", k: w.k || [], abs: w.abs || "",
      cat: cat, ts: nowStr()
    });
    toast("保存中…", true);
    saveFavsToRepo().then(function () {
      toast("已收藏到「" + cat + "」");
      refreshFavUi();
    }).catch(function (e) { toast("保存失败：" + e.message); });
  }

  function removeFav(doi) {
    S.favs.items = S.favs.items.filter(function (x) { return x.doi !== doi; });
    toast("保存中…", true);
    saveFavsToRepo().then(function () {
      toast("已取消收藏");
      refreshFavUi();
    }).catch(function (e) { toast("保存失败：" + e.message); });
  }

  function refreshFavUi() {
    document.querySelectorAll(".fav-btn").forEach(function (b) {
      var f = isFaved(b.dataset.doi);
      b.textContent = f ? "★" : "☆";
      b.classList.toggle("faved", f);
    });
    if (S.route === "favs") renderFavs();
  }

  function openFavPicker(btn) {
    var pk = $("fav-picker");
    var doi = btn.dataset.doi;
    if (isFaved(doi)) { removeFav(doi); return; }
    pk.dataset.doi = doi;
    var html = '<div class="fp-title">收藏到分类…</div>';
    S.favs.categories.forEach(function (c) {
      html += '<button class="fp-cat" data-cat="' + esc(c) + '">' + esc(c) + "</button>";
    });
    html += '<div class="fp-new"><input id="fp-input" placeholder="新分类名"><button id="fp-add">添加</button></div>';
    pk.innerHTML = html;
    var r = btn.getBoundingClientRect();
    pk.style.left = Math.max(8, r.left + window.scrollX - 40) + "px";
    pk.style.top = (r.bottom + window.scrollY + 6) + "px";
    pk.hidden = false;
    var inp = $("fp-input");
    if (inp) inp.focus();
  }

  /* ---------- favorites view ---------- */

  function renderFavChips() {
    var box = $("fav-chips");
    box.innerHTML = "";
    var counts = {};
    S.favs.items.forEach(function (x) { counts[x.cat] = (counts[x.cat] || 0) + 1; });
    var all = document.createElement("button");
    all.className = "chip" + (!S.favCat ? " on" : "");
    all.textContent = "全部（" + S.favs.items.length + "）";
    all.onclick = function () { S.favCat = null; renderFavs(); };
    box.appendChild(all);
    S.favs.categories.forEach(function (c) {
      if (!counts[c]) return;
      var b = document.createElement("button");
      b.className = "chip" + (S.favCat === c ? " on" : "");
      b.textContent = c + "（" + counts[c] + "）";
      b.onclick = function () { S.favCat = c; renderFavs(); };
      box.appendChild(b);
    });
  }

  function renderFavs() {
    renderFavChips();
    var box = $("fav-list");
    var items = S.favs.items.filter(function (x) { return !S.favCat || x.cat === S.favCat; });
    if (!items.length) {
      box.innerHTML = '<div class="empty">还没有收藏。浏览条目时点右侧的 ☆ 即可收藏。</div>';
      return;
    }
    var html = "", lastCat = "";
    items.forEach(function (x) {
      if (!S.favCat && x.cat !== lastCat) {
        lastCat = x.cat;
        html += '<div class="date-head">' + esc(x.cat) + "</div>";
      }
      var cached = S.workIndex[x.doi];
      var favWork = { doi: x.doi, t: x.t, a: x.a, d: x.d, oa: x.oa, url: x.url, k: x.k,
        abs: x.abs || (cached && cached.abs) || "", _j: x.j };
      S.workIndex[x.doi] = favWork;
      html += entryHtml(favWork, x.j);
    });
    box.innerHTML = html;
    fillMissingFavAbs(items);
  }

  /* old favorites stored no abstract; backfill from OpenAlex by DOI, then persist */
  function reconstructAbs(inv) {
    if (!inv) return "";
    var pos = {}, max = -1;
    Object.keys(inv).forEach(function (w) {
      inv[w].forEach(function (p) { pos[p] = w; if (p > max) max = p; });
    });
    var arr = [];
    for (var k = 0; k <= max; k++) arr.push(pos[k] || "");
    var text = arr.join(" ").replace(/\s+/g, " ").trim();
    var labels = ["Abstract ", "ABSTRACT ", "Abstract. ", "Abstract: "];
    for (var i = 0; i < labels.length; i++) {
      if (text.indexOf(labels[i]) === 0) { text = text.slice(labels[i].length).trim(); break; }
    }
    return text;
  }

  var favAbsBusy = false;
  function fillMissingFavAbs(items) {
    if (favAbsBusy) return;
    var missing = items.filter(function (x) { return !x.abs && x.doi; });
    if (!missing.length) return;
    favAbsBusy = true;
    var changed = false, i = 0;
    function finish() {
      favAbsBusy = false;
      if (!changed) return;
      renderFavs();
      if (localStorage.getItem("gh_token")) {
        saveFavsToRepo().catch(function () { /* keep display-only copy */ });
      }
    }
    function next() {
      if (i >= missing.length) { finish(); return; }
      var x = missing[i++];
      fetch("https://api.openalex.org/works/doi:" + encodeURIComponent(x.doi) +
            "?select=abstract_inverted_index&mailto=wakin-leo%40users.noreply.github.com")
        .then(function (r) { return r.ok ? r.json() : null; })
        .then(function (d) {
          var abs = d && reconstructAbs(d.abstract_inverted_index);
          if (abs) { x.abs = abs; changed = true; }
        })
        .catch(function () { /* skip this one */ })
        .then(function () { setTimeout(next, 150); });
    }
    next();
  }

  /* ---------- APA citation ---------- */

  function apaAuthors(names) {
    var inv = (names || []).map(function (n) {
      var parts = String(n).trim().split(/\s+/);
      if (parts.length < 2) return n;
      var last = parts.pop();
      var initials = parts.map(function (p) { return p.charAt(0) ? p.charAt(0).toUpperCase() + "." : ""; })
        .filter(function (x) { return x; }).join(" ");
      return initials ? last + ", " + initials : last;
    });
    if (!inv.length) return "";
    if (inv.length === 1) return inv[0];
    if (inv.length === 2) return inv[0] + " & " + inv[1];
    if (inv.length <= 20) return inv.slice(0, -1).join(", ") + ", & " + inv[inv.length - 1];
    return inv.slice(0, 19).join(", ") + ", ... " + inv[inv.length - 1];
  }

  // markdown=true wraps the journal name in *...* for the notes file
  function apaCite(w, markdown) {
    var year = (w.d || "").slice(0, 4);
    var j = markdown ? "*" + (w.j || w._j || "") + "*" : (w.j || w._j || "");
    return apaAuthors(w.a) + " (" + year + "). " + w.t + ". " + j +
      ". https://doi.org/" + w.doi;
  }

  function copyCitation(doi) {
    var w = S.workIndex[doi];
    if (!w) { toast("找不到该条目数据"); return; }
    var text = apaCite(w, false);
    function done() { toast("已复制 APA 引文"); }
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).then(done, function () { fallbackCopy(text); done(); });
    } else {
      fallbackCopy(text); done();
    }
  }

  function fallbackCopy(text) {
    var ta = document.createElement("textarea");
    ta.value = text;
    document.body.appendChild(ta);
    ta.select();
    try { document.execCommand("copy"); } catch (e) { /* ignore */ }
    document.body.removeChild(ta);
  }

  /* ---------- read status (stored in repo) ---------- */

  var readSaveTimer = null;

  function setRead(doi, on) {
    var i = S.read.items.indexOf(doi);
    if (on && i < 0) S.read.items.push(doi);
    if (!on && i >= 0) S.read.items.splice(i, 1);
    // update every rendered copy of this entry
    document.querySelectorAll('.entry[data-doi="' + doi + '"]').forEach(function (entry) {
      entry.classList.toggle("is-read", on);
      var b = entry.querySelector(".read-toggle");
      if (b) {
        b.classList.toggle("on", on);
        b.textContent = on ? "已读" : "标为已读";
        b.title = on ? "取消已读" : "标为已读";
      }
    });
    if (readSaveTimer) clearTimeout(readSaveTimer);
    readSaveTimer = setTimeout(saveRead, 2000);
    // with "仅看未读" on, drop the entry from the list immediately
    if (S.unreadOnly) { renderLatest(); renderArchive(); }
  }

  function saveRead() {
    if (!localStorage.getItem("gh_token")) {
      toast("已读标记仅本次有效：配置 GitHub 令牌后才能长期保存");
      return;
    }
    ghGetFile("user/read.json").then(function (f) {
      return ghPutRaw("user/read.json", JSON.stringify(S.read, null, 2),
        f && f.sha, "read: update");
    }).catch(function (e) { toast("已读保存失败：" + e.message); });
  }

  /* ---------- highlights ---------- */

  function citeLine(x) {
    return apaCite(x, true);
  }

  function notesMd() {
    var parts = ["# 摘要笔记", "",
      "> 本文件由 Daily Digest 自动生成与维护：每条划线按「题录信息 → 划线内容」排列。", ""];
    var seen = [], dois = [];
    S.highlights.items.slice().reverse().forEach(function (h) {
      if (seen.indexOf(h.doi) < 0) { seen.push(h.doi); dois.push(h.doi); }
    });
    dois.forEach(function (doi) {
      var hs = S.highlights.items.filter(function (h) { return h.doi === doi; });
      parts.push("---", "", "## " + citeLine(hs[0]), "");
      hs.forEach(function (h) {
        parts.push("> " + h.text.replace(/\s+/g, " ").trim(), "");
        parts.push("<sub>划线于 " + h.ts + "</sub>", "");
      });
    });
    return parts.join("\n");
  }

  function saveHighlight(doi, text) {
    if (!requireToken()) return;
    var w = S.workIndex[doi];
    if (!w) { toast("找不到该条目数据"); return; }
    text = text.replace(/\s+/g, " ").trim();
    if (!text) return;
    toast("保存中…", true);
    ghGetFile("user/highlights.json").then(function (f) {
      var hl = f ? decodeFile(f) : { items: [] };
      hl.items.push({ doi: doi, t: w.t, a: w.a, d: w.d, j: w._j || "", text: text, ts: nowStr() });
      S.highlights = hl;
      return ghGetFile("notes/摘要笔记.md").then(function (f2) {
        return ghPutRaw("user/highlights.json", JSON.stringify(hl, null, 2), f && f.sha, "note: add highlight")
          .then(function () {
            return ghPutRaw("notes/摘要笔记.md", notesMd(), f2 && f2.sha, "note: sync 摘要笔记");
          });
      });
    }).then(function () {
      toast("已存入摘要笔记");
      if (S.route === "notes") renderNotes();
    }).catch(function (e) { toast("保存失败：" + e.message); });
  }

  function renderNotes() {
    var box = $("notes-list");
    if (!S.highlights.items.length) {
      box.innerHTML = '<div class="empty">还没有划线笔记。在条目摘要里选中一段文字，点「保存划线」即可。</div>';
      return;
    }
    var seen = [], dois = [];
    S.highlights.items.slice().reverse().forEach(function (h) {
      if (seen.indexOf(h.doi) < 0) { seen.push(h.doi); dois.push(h.doi); }
    });
    var html = "";
    dois.forEach(function (doi) {
      var hs = S.highlights.items.filter(function (h) { return h.doi === doi; });
      var x = hs[0];
      html += '<div class="note-work"><div class="note-cite">' +
        esc(apaAuthors(x.a)) + " (" + esc((x.d || "").slice(0, 4)) + '). <a href="https://doi.org/' + esc(x.doi) +
        '" target="_blank" rel="noopener">' + esc(x.t) + "</a>. <i>" + esc(x.j) + "</i>.</div>";
      hs.forEach(function (h) {
        html += '<div class="note-quote">' + esc(h.text) +
          '<span class="nq-time">划线于 ' + esc(h.ts) + "</span></div>";
      });
      html += "</div>";
    });
    box.innerHTML = html;
  }

  /* ---------- diary ---------- */

  function diaryMd() {
    var parts = ["# 小黄豆罐头日志", "", "> 由 Daily Digest 自动维护。", ""];
    S.diary.items.forEach(function (x) {
      parts.push("## " + x.ts, "", x.text, "");
    });
    return parts.join("\n");
  }

  function renderDiary() {
    var box = $("diary-list");
    if (!S.diary.items.length) { box.innerHTML = ""; return; }
    box.innerHTML = S.diary.items.map(function (x) {
      return '<div class="diary-entry"><div class="de-time">' + esc(x.ts) +
        '</div><div class="de-text">' + esc(x.text) + "</div></div>";
    }).join("");
  }

  function saveDiary() {
    var ta = $("diary-input");
    var text = ta.value.trim();
    if (!text) { toast("先写点内容再存"); return; }
    if (!requireToken()) return;
    toast("保存中…", true);
    ghGetFile("user/diary.json").then(function (f) {
      var dj = f ? decodeFile(f) : { items: [] };
      dj.items.unshift({ ts: nowStr(), text: text });
      S.diary = dj;
      return ghGetFile("notes/小黄豆罐头日志.md").then(function (f2) {
        return ghPutRaw("user/diary.json", JSON.stringify(dj, null, 2), f && f.sha, "diary: add entry")
          .then(function () {
            return ghPutRaw("notes/小黄豆罐头日志.md", diaryMd(), f2 && f2.sha, "diary: sync 日志");
          });
      });
    }).then(function () {
      ta.value = "";
      $("diary-status").textContent = "";
      renderDiary();
      toast("已存入罐头");
    }).catch(function (e) { toast("保存失败：" + e.message); });
  }

  /* ---------- 小黄豆罐头 ---------- */

  var BEAN_EPOCH = new Date(2015, 10, 10);  // 2015-11-10 local

  function daysSinceEpoch() {
    var now = new Date();
    var today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    return Math.floor((today - BEAN_EPOCH) / 86400000);
  }

  function renderCounter() {
    $("bean-days").textContent = daysSinceEpoch();
  }

  /* ----- anniversaries ----- */

  function saveAnnis() {
    return ghGetFile("user/anniversaries.json").then(function (f) {
      return ghPutRaw("user/anniversaries.json", JSON.stringify(S.annis, null, 2),
        f && f.sha, "bean: update anniversaries");
    });
  }

  function anniInfo(a) {
    var parts = a.date.split("-");
    var y = +parts[0], m = +parts[1] - 1, d = +parts[2];
    var now = new Date();
    var today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    if (a.yearly) {
      var next = new Date(now.getFullYear(), m, d);
      if (next < today) next = new Date(now.getFullYear() + 1, m, d);
      var diff = Math.round((next - today) / 86400000);
      if (diff === 0) return "就是今天 · 第 " + (now.getFullYear() - y) + " 周年";
      var years = next.getFullYear() - y;
      return "还有 " + diff + " 天" + (years > 0 ? " · 届时第 " + years + " 周年" : "");
    }
    var t = new Date(y, m, d);
    var past = Math.floor((today - t) / 86400000);
    if (past === 0) return "就是今天";
    return past > 0 ? "已经 " + past + " 天" : "还有 " + (-past) + " 天";
  }

  function renderAnnis() {
    var box = $("anni-list");
    if (!S.annis.items.length) {
      box.innerHTML = '<div class="muted anni-empty">还没有纪念日，在下面添加第一个吧。</div>';
      return;
    }
    box.innerHTML = "";
    S.annis.items.forEach(function (a, i) {
      var row = document.createElement("div");
      row.className = "anni-item";
      row.innerHTML = '<div><div class="anni-name">' + esc(a.name) + "</div>" +
        '<div class="anni-sub">' + esc(a.date) + (a.yearly ? " · 每年" : "") + " · " +
        esc(anniInfo(a)) + "</div></div>";
      var del = document.createElement("button");
      del.className = "danger"; del.textContent = "删除";
      del.onclick = function () {
        if (!requireToken()) return;
        if (!confirm("删除纪念日「" + a.name + "」？")) return;
        S.annis.items.splice(i, 1);
        toast("保存中…", true);
        saveAnnis().then(function () { toast("已删除"); renderAnnis(); })
          .catch(function (e) { toast("保存失败：" + e.message); });
      };
      row.appendChild(del);
      box.appendChild(row);
    });
  }

  function addAnni() {
    var name = $("anni-name").value.trim();
    var date = $("anni-date").value;
    if (!name || !date) { toast("名称和日期都要填"); return; }
    if (!requireToken()) return;
    S.annis.items.push({ name: name, date: date, yearly: $("anni-yearly").checked });
    toast("保存中…", true);
    saveAnnis().then(function () {
      $("anni-name").value = "";
      toast("已添加纪念日");
      renderAnnis();
    }).catch(function (e) { toast("保存失败：" + e.message); });
  }

  /* ----- works ----- */

  function saveWorks() {
    return ghGetFile("user/works.json").then(function (f) {
      var clean = { items: S.works.items.map(function (w) {
        var c = {}; for (var k in w) if (k !== "preview") c[k] = w[k];
        return c;
      }) };
      return ghPutRaw("user/works.json", JSON.stringify(clean, null, 2),
        f && f.sha, "bean: update works");
    });
  }

  function resizeImage(file) {
    return new Promise(function (res, rej) {
      var url = URL.createObjectURL(file);
      var img = new Image();
      img.onload = function () {
        var max = 1600;
        var scale = Math.min(1, max / Math.max(img.width, img.height));
        var c = document.createElement("canvas");
        c.width = Math.max(1, Math.round(img.width * scale));
        c.height = Math.max(1, Math.round(img.height * scale));
        c.getContext("2d").drawImage(img, 0, 0, c.width, c.height);
        URL.revokeObjectURL(url);
        res(c.toDataURL("image/jpeg", 0.85));
      };
      img.onerror = function () { URL.revokeObjectURL(url); rej(new Error("图片读取失败")); };
      img.src = url;
    });
  }

  function uploadWork() {
    var type = $("work-type").value;
    var caption = $("work-caption").value.trim();
    if (!requireToken()) return;
    var st = $("work-status");
    if (type === "text") {
      var title = $("work-title").value.trim();
      var text = $("work-text").value.trim();
      if (!title || !text) { st.textContent = "标题和内容都要填"; return; }
      st.textContent = "保存中…";
      S.works.items.unshift({ id: "w" + Date.now(), type: "text", title: title, text: text, caption: caption, ts: nowStr() });
      saveWorks().then(function () {
        $("work-title").value = ""; $("work-text").value = ""; $("work-caption").value = "";
        st.textContent = "已保存";
        renderWorks();
      }).catch(function (e) { st.textContent = "保存失败：" + e.message; });
      return;
    }
    var file = $("work-file").files[0];
    if (!file) { st.textContent = "请先选择图片文件"; return; }
    st.textContent = "压缩图片中…";
    resizeImage(file).then(function (dataUrl) {
      var b64data = dataUrl.split(",")[1];
      var path = "works/" + type + "-" + Date.now() + ".jpg";
      st.textContent = "上传到仓库中…";
      return ghPutB64(path, b64data, "bean: upload " + type).then(function (resp) {
        var sha = resp.content && resp.content.sha;
        S.works.items.unshift({
          id: "w" + Date.now(), type: type, path: path, sha: sha,
          caption: caption, ts: nowStr(), preview: dataUrl
        });
        return saveWorks();
      });
    }).then(function () {
      $("work-file").value = ""; $("work-caption").value = "";
      st.textContent = "已上传";
      renderWorks();
    }).catch(function (e) { st.textContent = "上传失败：" + e.message; });
  }

  function deleteWork(i) {
    var w = S.works.items[i];
    if (!requireToken()) return;
    if (!confirm("删除这条作品？图片文件会一并从仓库删除。")) return;
    toast("删除中…", true);
    S.works.items.splice(i, 1);
    var chain = saveWorks();
    if (w.path && w.sha) {
      chain = chain.then(function () { return ghDeleteFile(w.path, w.sha, "bean: delete work image"); });
    }
    chain.then(function () { toast("已删除"); renderWorks(); })
      .catch(function (e) { toast("删除失败：" + e.message); renderWorks(); });
  }

  var WORK_TYPE_LABEL = { photo: "照片", art: "画作", text: "文字" };

  function renderWorks() {
    var box = $("works-list");
    if (!S.works.items.length) { box.innerHTML = ""; return; }
    box.innerHTML = "";
    S.works.items.forEach(function (w, i) {
      var card = document.createElement("div");
      card.className = "work-card";
      var body = "";
      if (w.type === "text") {
        body = '<div class="work-text-title">' + esc(w.title || "") + '</div>' +
               '<div class="work-text-body">' + esc(w.text || "") + "</div>";
      } else {
        var src = w.preview || w.path;
        body = '<a href="' + esc(w.path || "#") + '" target="_blank" rel="noopener">' +
               '<img class="work-img" src="' + esc(src) + '" alt=""></a>';
      }
      card.innerHTML = body +
        '<div class="work-meta"><span class="wtag">' + esc(WORK_TYPE_LABEL[w.type] || w.type) + "</span>" +
        (w.caption ? '<span class="work-cap">' + esc(w.caption) + "</span>" : "") +
        '<span class="work-ts">' + esc(w.ts) + "</span></div>";
      var del = document.createElement("button");
      del.className = "danger work-del"; del.textContent = "删除";
      del.onclick = function () { deleteWork(i); };
      card.appendChild(del);
      box.appendChild(card);
    });
  }

  function initBean() {
    if (S.beanInit) return;
    S.beanInit = true;
    renderCounter();
    setInterval(renderCounter, 60000);
    $("anni-add").onclick = addAnni;
    $("work-type").onchange = function () {
      var isText = this.value === "text";
      $("work-file-row").hidden = isText;
      $("work-text-row").hidden = !isText;
    };
    $("work-save").onclick = uploadWork;
  }

  function renderBean() {
    initBean();
    renderCounter();
    renderAnnis();
    renderWorks();
    renderDiary();
  }

  /* ---------- admin ---------- */

  function renderAdminTable() {
    var tb = $("journal-table").querySelector("tbody");
    tb.innerHTML = "";
    $("journal-count").textContent = "（" + S.adminList.length + " 种）";
    S.adminList.forEach(function (j, i) {
      var tr = document.createElement("tr");
      tr.innerHTML = "<td>" + esc(j.name) + '</td><td class="muted">' + esc(j.publisher || "") +
        '</td><td class="muted">' + esc(j.issns.join(" / ")) + "</td>";
      var td = document.createElement("td");
      var btn = document.createElement("button");
      btn.className = "danger"; btn.textContent = "删除";
      btn.onclick = function () {
        if (confirm("从清单删除《" + j.name + "》？已抓取的数据会保留在仓库里，仅停止更新。")) {
          S.adminList.splice(i, 1); renderAdminTable();
        }
      };
      td.appendChild(btn); tr.appendChild(td); tb.appendChild(tr);
    });
  }

  function initAdmin() {
    S.adminList = JSON.parse(JSON.stringify(S.manifest.journals.map(function (j) {
      return { slug: j.slug, name: j.name, issns: j.issns, publisher: j.publisher };
    })));
    renderAdminTable();

    var tok = $("gh-token");
    tok.value = localStorage.getItem("gh_token") || "";
    $("save-token").onclick = function () {
      localStorage.setItem("gh_token", tok.value.trim());
      toast("令牌已保存到本浏览器");
    };

    // translation settings
    var preset = $("tr-preset"), customRow = $("tr-custom-row");
    preset.value = localStorage.getItem("tr_provider") || "glm";
    $("tr-base").value = localStorage.getItem("tr_base") || "";
    $("tr-model").value = localStorage.getItem("tr_model") || "";
    $("tr-key").value = localStorage.getItem("tr_key") || "";
    customRow.hidden = preset.value !== "custom";
    preset.onchange = function () { customRow.hidden = preset.value !== "custom"; };
    $("save-tr").onclick = function () {
      var st = $("tr-status");
      var key = $("tr-key").value.trim();
      if (!key) { st.textContent = "请粘贴 API Key"; return; }
      if (preset.value === "custom" && (!$("tr-base").value.trim() || !$("tr-model").value.trim())) {
        st.textContent = "自定义接口需要填写接口地址和模型名"; return;
      }
      localStorage.setItem("tr_provider", preset.value);
      localStorage.setItem("tr_base", $("tr-base").value.trim());
      localStorage.setItem("tr_model", $("tr-model").value.trim());
      localStorage.setItem("tr_key", key);
      st.textContent = "已保存，回到文献列表即可使用翻译。";
    };

    $("add-search").onclick = function () {
      var q = $("add-query").value.trim();
      if (!q) return;
      var box = $("add-results");
      box.innerHTML = '<div class="muted">查询中…</div>';
      fetch("https://api.openalex.org/sources?search=" + encodeURIComponent(q) +
            "&per-page=8&filter=type:journal&mailto=" + encodeURIComponent("wakin-leo@users.noreply.github.com"))
        .then(function (r) { return r.json(); })
        .then(function (d) {
          box.innerHTML = "";
          if (!d.results.length) { box.innerHTML = '<div class="muted">没有匹配结果</div>'; return; }
          d.results.forEach(function (src) {
            var row = document.createElement("div");
            row.className = "add-result";
            var issns = [];
            if (src.issn_l) issns.push(src.issn_l);
            (src.issn || []).forEach(function (x) { if (issns.indexOf(x) < 0) issns.push(x); });
            row.innerHTML = "<div><div>" + esc(src.display_name) + '</div><div class="sub">' +
              esc(src.host_organization_name || "") + " · ISSN " + esc(issns.join(" / ")) +
              " · 收录 " + (src.works_count || 0) + " 篇</div></div>";
            var btn = document.createElement("button");
            btn.textContent = "添加";
            btn.onclick = function () {
              var slug = src.id.split("/").pop().toLowerCase();
              if (S.adminList.some(function (x) { return x.slug === slug; })) { alert("已在清单中"); return; }
              S.adminList.push({
                slug: slug, name: src.display_name, issns: issns,
                publisher: src.host_organization_name || ""
              });
              renderAdminTable();
              btn.disabled = true; btn.textContent = "已添加";
            };
            row.appendChild(btn);
            box.appendChild(row);
          });
        });
    };

    $("commit-journals").onclick = function () {
      var st = $("commit-status");
      if (!requireToken()) { st.textContent = "请先保存 GitHub 令牌"; return; }
      st.textContent = "写入中…";
      ghGetFile("journals.json").then(function (f) {
        return ghPutRaw("journals.json", JSON.stringify({ journals: S.adminList }, null, 2),
          f && f.sha, "journals: update watchlist");
      }).then(function () {
        st.textContent = "已保存。后台任务会在下一次运行时生效；新增期刊的历史回溯完成后即出现在网站上。";
      }).catch(function (e) {
        st.textContent = "保存失败：" + e.message + "（检查令牌权限）";
      });
    };

    $("change-pass").onclick = function () {
      var np = $("new-pass").value;
      var st = $("pass-status");
      if (np.length < 6) { st.textContent = "口令至少 6 位"; return; }
      if (!requireToken()) { st.textContent = "请先保存 GitHub 令牌"; return; }
      sha256Hex(np).then(function (h) {
        return ghGetFile("site-config.json").then(function (f) {
          var cfg = JSON.parse(JSON.stringify(S.config));
          cfg.password_sha256 = h;
          return ghPutRaw("site-config.json", JSON.stringify(cfg, null, 2), f && f.sha, "config: rotate passphrase");
        });
      }).then(function () {
        st.textContent = "已修改，下次进站生效。";
        $("new-pass").value = "";
      }).catch(function (e) { st.textContent = "修改失败：" + e.message; });
    };
  }

  /* ---------- translation ---------- */

  var TR_PRESETS = {
    glm: { base: "https://open.bigmodel.cn/api/paas/v4/chat/completions", model: "glm-4-flash" },
    siliconflow: { base: "https://api.siliconflow.cn/v1/chat/completions", model: "deepseek-ai/DeepSeek-V4-Flash" }
  };

  function trConfig() {
    var p = localStorage.getItem("tr_provider") || "glm";
    var key = localStorage.getItem("tr_key") || "";
    var cfg = TR_PRESETS[p] || {
      base: localStorage.getItem("tr_base") || "",
      model: localStorage.getItem("tr_model") || ""
    };
    return { base: cfg.base, model: cfg.model, key: key };
  }

  function trChat(cfg, prompt) {
    return fetch(cfg.base, {
      method: "POST",
      headers: { "Content-Type": "application/json", "Authorization": "Bearer " + cfg.key },
      body: JSON.stringify({
        model: cfg.model,
        messages: [{ role: "user", content: prompt }],
        temperature: 0.2
      })
    }).then(function (r) {
      if (!r.ok) throw new Error("HTTP " + r.status);
      return r.json();
    }).then(function (d) {
      var text = d.choices && d.choices[0] && d.choices[0].message && d.choices[0].message.content;
      if (!text) throw new Error("返回内容为空");
      return text.trim();
    });
  }

  /* ----- title auto-translation (batched, cached in this browser) ----- */

  var TITLE_ZH_KEY = "title_zh_v3";
  try { S.titleZh = JSON.parse(localStorage.getItem(TITLE_ZH_KEY) || "{}"); }
  catch (e) { S.titleZh = {}; }
  var titleInflight = {};

  function persistTitleZh() {
    try { localStorage.setItem(TITLE_ZH_KEY, JSON.stringify(S.titleZh)); } catch (e) { /* quota */ }
  }

  function fillTitleZh(entry, text) {
    var el = entry.querySelector(".title-zh");
    if (el) { el.textContent = text; el.hidden = false; }
  }

  function translateTitles(container) {
    var sec = container.closest("section");
    if (sec && sec.hidden) return;   // only translate what is on screen
    container.querySelectorAll(".entry").forEach(function (entry) {
      var zh = S.titleZh[entry.dataset.doi];
      if (zh) fillTitleZh(entry, zh);
    });
    var cfg = trConfig();
    if (!cfg.key) return;
    var pending = [];
    container.querySelectorAll(".entry").forEach(function (entry) {
      var doi = entry.dataset.doi;
      var w = S.workIndex[doi];
      if (!w || S.titleZh[doi] || titleInflight[doi]) return;
      titleInflight[doi] = true;
      pending.push({ doi: doi, t: w.t });
    });
    var i = 0;
    function finishBatch(batch) {
      batch.forEach(function (b) { delete titleInflight[b.doi]; });
    }
    function nextBatch() {
      if (i >= pending.length) return;
      var batch = pending.slice(i, i + 10); i += 10;
      var prompt = "把下列英文学术论文标题逐条翻译成简体中文，保持学术语气，专业术语准确。" +
        "每条译文中最多挑选 3 个专业术语，以「中文（English）」的形式括注英文原词。括注必须紧跟在对应中文术语之后，绝不要集中到句末。" +
        "示例：输入 The career advancement of street-level bureaucrats in China，正确：中国街头官僚（street-level bureaucrats）的职业晋升；错误：中国街头官僚的职业晋升（street-level bureaucrats）——括注被挪到句末，禁止这样输出。" +
        "若译文直接保留了英文原词（如 EFL），则无需再括注；括号内只放英文原词或原形词组，不要加逗号、分号等标点，每条绝不超过 3 处括注，宁可少注也不要超过。" +
        "输出格式：每行一条译文，以原序号加英文句点开头（如 1. 译文），序号与输入一一对应，" +
        "不要输出任何解释或其他内容。\n\n" +
        batch.map(function (b, k) { return (k + 1) + ". " + b.t; }).join("\n");
      trChat(cfg, prompt).then(function (text) {
        var lines = text.split("\n");
        batch.forEach(function (b, k) {
          var zh = null;
          for (var li = 0; li < lines.length; li++) {
            var m = lines[li].match(/^\s*(\d+)\s*[.、)）:：]\s*(.+)$/);
            if (m && parseInt(m[1], 10) === k + 1) { zh = m[2].trim(); break; }
          }
          if (!zh && lines.length === batch.length) {
            zh = lines[k].replace(/^\s*\d+\s*[.、)）:：]\s*/, "").trim();
          }
          if (zh) {
            S.titleZh[b.doi] = zh;
            var entry = container.querySelector('.entry[data-doi="' + b.doi + '"]');
            if (entry) fillTitleZh(entry, zh);
          }
        });
        persistTitleZh();
        finishBatch(batch);
      }).catch(function () {
        finishBatch(batch);   // allow retry on next render
      }).then(function () {
        setTimeout(nextBatch, 250);
      });
    }
    nextBatch();
  }

  /* ----- abstract: sentence-by-sentence EN/ZH with term annotations ----- */

  function parseInterleaved(text) {
    var pairs = [], en = null;
    text.split("\n").forEach(function (line) {
      var mEn = line.match(/^\s*EN\s*[:：]\s*(.+)$/i);
      var mZh = line.match(/^\s*ZH\s*[:：]\s*(.+)$/i);
      if (mEn) { en = mEn[1].trim().replace(/^(abstract)\s*[:：]\s*/i, ""); }
      else if (mZh && en) {
        pairs.push({ en: en, zh: mZh[1].trim().replace(/^摘要\s*[:：]\s*/, "") });
        en = null;
      }
    });
    return pairs;
  }

  function translateEntry(btn) {
    var entry = btn.closest(".entry");
    var box = entry.querySelector(".abs-zh");
    var w = S.workIndex[entry.dataset.doi];
    if (!w) return;
    if (!isRead(entry.dataset.doi)) setRead(entry.dataset.doi, true);
    if (w._zh) { box.hidden = !box.hidden; btn.textContent = box.hidden ? "翻译摘要" : "收起译文"; return; }
    var cfg = trConfig();
    if (!cfg.key) {
      btn.textContent = "请先在「期刊管理」页配置翻译 Key";
      setTimeout(function () { btn.textContent = "翻译摘要"; }, 2500);
      return;
    }
    btn.disabled = true;
    btn.textContent = "翻译中…";
    var prompt = "把下面的英文论文摘要逐句翻译。要求：\n" +
      "1. 按原文句子顺序，先输出英文原句（保持原文不变），再输出它的中文翻译；\n" +
      "2. 输出格式严格为每句两行：第一行以「EN: 」开头，第二行以「ZH: 」开头；\n" +
      "3. 中文保持学术语气、术语准确；每句中文里最多挑选 2 个专业术语，在译文中以「中文（English）」的形式括注英文原词——括注必须紧跟在对应中文术语之后，不要放到句末；示例：「街头官僚（street-level bureaucrats）拥有自由裁量权」是正确的，「街头官僚拥有自由裁量权（street-level bureaucrats）」是错误的；若译文直接保留了英文原词（如 EFL），则无需再括注；每句绝不超过 2 个括注，宁可不注也不要超过，不要额外列术语表；\n" +
      "4. 不要翻译标题，不要在译文中重复「Abstract/摘要」字样，不要输出任何解释或其他内容。\n\n" +
      (w.abs || "");
    trChat(cfg, prompt).then(function (text) {
      var pairs = parseInterleaved(text);
      if (pairs.length) {
        w._zh = pairs.map(function (pr) {
          return '<div class="iz-en">' + esc(pr.en) + '</div><div class="iz-zh">' + esc(pr.zh) + "</div>";
        }).join("");
        box.innerHTML = w._zh;
      } else {
        w._zh = esc(text);
        box.textContent = text;
      }
      box.hidden = false;
      btn.textContent = "收起译文";
    }).catch(function (e) {
      btn.textContent = "翻译失败：" + e.message;
      setTimeout(function () { btn.textContent = "翻译摘要"; }, 3000);
    }).then(function () {
      btn.disabled = false;
    });
  }

  /* ---------- global event delegation ---------- */

  document.addEventListener("click", function (e) {
    var t = e.target;

    // translate
    if (t.classList && t.classList.contains("tr-btn")) {
      translateEntry(t);
      return;
    }

    // copy APA citation
    if (t.classList && t.classList.contains("cite-btn")) {
      copyCitation(t.dataset.doi);
      return;
    }

    // read toggle
    if (t.classList && t.classList.contains("read-toggle")) {
      setRead(t.dataset.doi, !isRead(t.dataset.doi));
      return;
    }

    // clicking DOI / PDF link auto-marks as read (navigation proceeds normally)
    var link = t.closest && t.closest(".doi-line a");
    if (link) {
      var entryEl = t.closest(".entry");
      if (entryEl && entryEl.dataset.doi && !isRead(entryEl.dataset.doi)) {
        setRead(entryEl.dataset.doi, true);
      }
      return;
    }

    // favorite star
    if (t.classList && t.classList.contains("fav-btn")) {
      openFavPicker(t);
      return;
    }

    // picker category chosen
    if (t.classList && t.classList.contains("fp-cat")) {
      var pk = $("fav-picker");
      if (!requireToken()) { pk.hidden = true; return; }
      addFav(pk.dataset.doi, t.dataset.cat);
      pk.hidden = true;
      return;
    }
    if (t.id === "fp-add") {
      var pk2 = $("fav-picker");
      var name = $("fp-input").value.trim();
      if (name) {
        if (!requireToken()) { pk2.hidden = true; return; }
        addFav(pk2.dataset.doi, name);
      }
      pk2.hidden = true;
      return;
    }

    // click elsewhere closes picker
    var pk3 = $("fav-picker");
    if (!pk3.hidden && !(t.closest && t.closest("#fav-picker"))) pk3.hidden = true;
  });

  // highlight selection
  document.addEventListener("mouseup", function () {
    setTimeout(function () {
      var btn = $("hl-btn");
      var sel = window.getSelection();
      if (!sel || sel.isCollapsed || !String(sel).trim()) { btn.hidden = true; return; }
      var node = sel.anchorNode && (sel.anchorNode.nodeType === 1 ? sel.anchorNode : sel.anchorNode.parentElement);
      var entry = node && node.closest ? node.closest(".entry") : null;
      if (!entry || !entry.dataset.doi) { btn.hidden = true; return; }
      var rect = sel.getRangeAt(0).getBoundingClientRect();
      btn.style.left = Math.max(8, rect.left + window.scrollX) + "px";
      btn.style.top = (rect.bottom + window.scrollY + 6) + "px";
      btn.dataset.doi = entry.dataset.doi;
      btn.hidden = false;
    }, 10);
  });
  $("hl-btn").addEventListener("click", function () {
    var sel = window.getSelection();
    var text = sel ? String(sel) : "";
    var doi = this.dataset.doi;
    this.hidden = true;
    if (sel) sel.removeAllRanges();
    saveHighlight(doi, text);
  });

  $("diary-save").addEventListener("click", saveDiary);

  /* ---------- routing & boot ---------- */

  function route() {
    var r = (location.hash || "#home").slice(1);
    if (ROUTES.indexOf(r) < 0) r = "home";
    S.route = r;
    ROUTES.forEach(function (v) { $("view-" + v).hidden = v !== r; });
    document.querySelectorAll("nav a").forEach(function (a) {
      a.classList.toggle("active", a.dataset.route === r);
    });
    if (r === "latest") renderLatest();
    if (r === "archive") renderArchive();
    if (r === "favs") renderFavs();
    if (r === "notes") renderNotes();
    if (r === "bean") renderBean();
    if (r === "admin" && !S.adminList) initAdmin();
  }

  function boot() {
    fetchJson("data/index.json").then(function (m) {
      S.manifest = m;
      S.jBySlug = {};
      m.journals.forEach(function (j, i) {
        S.jColor[j.slug] = PALETTE[i % PALETTE.length];
        S.jBySlug[j.slug] = j;
      });
      $("site-title").textContent = S.config.title || "Daily Digest";
      $("updated-line").textContent = "数据更新至 " + m.updated +
        " · 收录 " + m.journals.length + " 种期刊";
      renderChips();
      initArchive();
      $("search").addEventListener("input", function () {
        S.query = this.value.trim().toLowerCase();
        renderLatest(); renderArchive();
      });
      $("oa-only").addEventListener("change", function () {
        S.oaOnly = this.checked;
        renderLatest(); renderArchive();
      });
      $("unread-only").addEventListener("change", function () {
        S.unreadOnly = this.checked;
        renderLatest(); renderArchive();
      });
      // load user data (public reads)
      loadUserJson("favorites", S.favs).then(function (d) {
        if (d && d.items) S.favs = d;
        // favorites arrive async; re-render if the user landed on #favs directly
        if (S.route === "favs") renderFavs();
      });
      loadUserJson("highlights", S.highlights).then(function (d) {
        if (d && d.items) S.highlights = d;
      });
      loadUserJson("diary", S.diary).then(function (d) {
        if (d && d.items) { S.diary = d; renderDiary(); }
      });
      loadUserJson("anniversaries", S.annis).then(function (d) {
        if (d && d.items) S.annis = d;
      });
      loadUserJson("works", S.works).then(function (d) {
        if (d && d.items) S.works = d;
      });
      loadUserJson("read", S.read).then(function (d) {
        if (d && d.items) S.read = d;
        // read.json arrives async; re-apply the unread filter if it is on
        if (S.unreadOnly) { renderLatest(); renderArchive(); }
      });
      window.addEventListener("hashchange", route);
      route();
    }).catch(function () {
      $("updated-line").textContent = "数据尚未生成：后台首次抓取运行后即自动出现。";
    });
  }

  fetchJson("site-config.json").then(function (cfg) {
    S.config = cfg;
    initGate();
  }).catch(function () {
    $("gate-err").textContent = "站点配置加载失败";
  });
})();

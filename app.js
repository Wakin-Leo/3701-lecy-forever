/* Daily Digest — front-end logic. No build step, no dependencies. */
(function () {
  "use strict";

  var REPO = "Wakin-Leo/3701-lecy-forever";
  var RECENT_WINDOW_DAYS = 30;

  var S = {
    config: null,
    manifest: null,
    shardCache: {}, // "slug/year" -> array
    activeJournals: null, // Set of slugs; null = all
    query: "",
    oaOnly: false,
    adminList: null // working copy of journals for admin page
  };

  function $(id) { return document.getElementById(id); }
  function esc(s) {
    return String(s == null ? "" : s)
      .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
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
        }
      });
    });
  }

  function enterApp() {
    $("gate").hidden = true;
    $("app").hidden = false;
    boot();
  }

  /* ---------- data ---------- */

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

  /* ---------- rendering ---------- */

  var OA_LABEL = { gold: "OA · Gold", hybrid: "OA · Hybrid", green: "OA · Green", bronze: "OA · Bronze", closed: "闭源" };

  function entryHtml(w, journalName) {
    var doiUrl = "https://doi.org/" + w.doi;
    var oaCls = w.oa === "closed" ? "oa-badge closed" : "oa-badge";
    var fulltext = (w.oa !== "closed" && w.url && w.url !== doiUrl)
      ? ' · <a href="' + esc(w.url) + '" target="_blank" rel="noopener">全文</a>' : "";
    var kws = (w.k && w.k.length) ? '<div class="kws">关键词：' + esc(w.k.join("；")) + "</div>" : "";
    var abs = w.abs
      ? '<details class="abs"><summary>摘要</summary><p>' + esc(w.abs) + "</p>" +
        '<div class="abs-zh" hidden></div><button class="tr-btn">翻译摘要</button></details>'
      : '<div class="kws">摘要缺失 · <a href="' + esc(doiUrl) + '" target="_blank" rel="noopener">查看原文页</a></div>';
    return '<div class="entry">' +
      '<div class="entry-title"><a href="' + esc(doiUrl) + '" target="_blank" rel="noopener">' + esc(w.t) + "</a></div>" +
      '<div class="entry-meta"><span class="jtag">' + esc(journalName) + "</span>" +
      "<span>" + esc(w.a.join(", ")) + "</span>" +
      '<span class="' + oaCls + '">' + esc(OA_LABEL[w.oa] || w.oa) + "</span>" + fulltext + "</div>" +
      kws + abs + "</div>";
  }

  function renderGrouped(list, container, journalMap) {
    if (!list.length) { container.innerHTML = '<div class="empty">没有符合条件的记录</div>'; return; }
    var html = "", lastDate = "";
    list.forEach(function (w) {
      if (w.d !== lastDate) {
        lastDate = w.d;
        html += '<div class="date-head">' + esc(w.d) + "</div>";
      }
      html += entryHtml(w, journalMap[w._slug] || "");
    });
    container.innerHTML = html;
  }

  function passesFilters(w) {
    if (S.activeJournals && !S.activeJournals.has(w._slug)) return false;
    if (S.oaOnly && w.oa === "closed") return false;
    if (S.query) {
      var hay = (w.t + " " + w.abs + " " + w.k.join(" ")).toLowerCase();
      if (hay.indexOf(S.query) < 0) return false;
    }
    return true;
  }

  /* ---------- latest view ---------- */

  function renderChips() {
    var box = $("journal-chips");
    box.innerHTML = "";
    S.manifest.journals.forEach(function (j) {
      var b = document.createElement("button");
      b.className = "chip" + ((!S.activeJournals || S.activeJournals.has(j.slug)) ? " on" : "");
      b.textContent = j.name;
      b.onclick = function () {
        if (!S.activeJournals) {
          S.activeJournals = new Set(S.manifest.journals.map(function (x) { return x.slug; }));
        }
        if (S.activeJournals.has(j.slug)) S.activeJournals.delete(j.slug);
        else S.activeJournals.add(j.slug);
        if (S.activeJournals.size === S.manifest.journals.length) S.activeJournals = null;
        renderChips(); renderLatest();
      };
      box.appendChild(b);
    });
  }

  function renderLatest() {
    var cutoff = new Date();
    cutoff.setDate(cutoff.getDate() - RECENT_WINDOW_DAYS);
    var cut = cutoff.toISOString().slice(0, 10);
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
      renderGrouped(all.filter(passesFilters), $("latest-list"), jmap);
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
    Object.keys(j.years || {}).forEach(function (y) {
      var o = document.createElement("option");
      o.value = y; o.textContent = y + "（" + j.years[y] + " 条）";
      ys.appendChild(o);
    });
    renderArchive();
  }

  function renderArchive() {
    var slug = $("arc-journal").value, year = $("arc-year").value;
    if (!slug || !year) { $("archive-list").innerHTML = '<div class="empty">该刊暂无回溯数据</div>'; return; }
    var jmap = {}; jmap[slug] = $("arc-journal").selectedOptions[0].textContent;
    loadShard(slug, year).then(function (d) {
      d.forEach(function (w) { w._slug = slug; });
      renderGrouped(d.filter(passesFilters), $("archive-list"), jmap);
    });
  }

  /* ---------- admin ---------- */

  function ghHeaders() {
    return {
      "Authorization": "Bearer " + (localStorage.getItem("gh_token") || ""),
      "Accept": "application/vnd.github+json"
    };
  }

  function ghGetSha(path) {
    return fetch("https://api.github.com/repos/" + REPO + "/contents/" + path, { headers: ghHeaders() })
      .then(function (r) { if (!r.ok) throw new Error("读取失败 " + r.status); return r.json(); })
      .then(function (j) { return j.sha; });
  }

  function ghPut(path, obj, sha, message) {
    var body = {
      message: message,
      content: btoa(unescape(encodeURIComponent(JSON.stringify(obj, null, 2)))),
      sha: sha
    };
    return fetch("https://api.github.com/repos/" + REPO + "/contents/" + path, {
      method: "PUT", headers: ghHeaders(), body: JSON.stringify(body)
    }).then(function (r) { if (!r.ok) throw new Error("写入失败 " + r.status); return r.json(); });
  }

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
      alert("令牌已保存到本浏览器");
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
      if (!localStorage.getItem("gh_token")) { st.textContent = "请先保存 GitHub 令牌"; return; }
      st.textContent = "写入中…";
      ghGetSha("journals.json").then(function (sha) {
        return ghPut("journals.json", { journals: S.adminList }, sha, "journals: update watchlist");
      }).then(function () {
        st.textContent = "已保存。后台任务会在几分钟内自动运行，新增期刊的历史回溯完成后即出现在网站上。";
      }).catch(function (e) {
        st.textContent = "保存失败：" + e.message + "（检查令牌权限）";
      });
    };

    $("change-pass").onclick = function () {
      var np = $("new-pass").value;
      var st = $("pass-status");
      if (np.length < 6) { st.textContent = "口令至少 6 位"; return; }
      if (!localStorage.getItem("gh_token")) { st.textContent = "请先保存 GitHub 令牌"; return; }
      sha256Hex(np).then(function (h) {
        return ghGetSha("site-config.json").then(function (sha) {
          var cfg = JSON.parse(JSON.stringify(S.config));
          cfg.password_sha256 = h;
          return ghPut("site-config.json", cfg, sha, "config: rotate passphrase");
        });
      }).then(function () {
        st.textContent = "已修改，下次进站生效。";
        $("new-pass").value = "";
      }).catch(function (e) { st.textContent = "修改失败：" + e.message; });
    };
  }

  /* ---------- translate stub ---------- */

  document.addEventListener("click", function (e) {
    if (!e.target.classList || !e.target.classList.contains("tr-btn")) return;
    e.target.textContent = "翻译功能尚未启用";
    setTimeout(function () { e.target.textContent = "翻译摘要"; }, 2000);
  });

  /* ---------- routing & boot ---------- */

  function route() {
    var r = (location.hash || "#latest").slice(1);
    if (["latest", "archive", "admin"].indexOf(r) < 0) r = "latest";
    ["latest", "archive", "admin"].forEach(function (v) {
      $("view-" + v).hidden = v !== r;
    });
    document.querySelectorAll("nav a").forEach(function (a) {
      a.classList.toggle("active", a.dataset.route === r);
    });
    if (r === "latest") renderLatest();
    if (r === "archive") renderArchive();
    if (r === "admin" && !S.adminList) initAdmin();
  }

  function boot() {
    fetchJson("data/index.json").then(function (m) {
      S.manifest = m;
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
      window.addEventListener("hashchange", route);
      route();
    }).catch(function () {
      $("updated-line").textContent = "数据尚未生成：后台首次抓取正在运行，请稍后再来。";
    });
  }

  fetchJson("site-config.json").then(function (cfg) {
    S.config = cfg;
    initGate();
  }).catch(function () {
    $("gate-err").textContent = "站点配置加载失败";
  });
})();

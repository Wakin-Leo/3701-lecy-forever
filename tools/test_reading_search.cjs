// Offline regression tests: synthetic articles, mock fetch, no real credentials or writes.
const assert = require('node:assert/strict');
const { test } = require('node:test');
const vm = require('node:vm');
const fs = require('node:fs');
const path = require('node:path');
const sourcePath = process.env.DIGEST_TEST_SOURCE || path.join(__dirname, '..', 'app.js');
const source = fs.readFileSync(sourcePath, 'utf8');
const marker = '  /* ---------- global event delegation ---------- */';
assert.equal(source.split(marker).length, 2, 'Locate the application logic without booting the site');
const instrumented = source.slice(0, source.indexOf(marker)) +
  '\n globalThis.testApi = {S, runKeywordSearch, runSemantic, translateEntry};\n})();';
const pause = () => new Promise(resolve => setTimeout(resolve, 2));
const response = (data, status = 200) => ({ok: status < 400, status, json: async () => data});

function harness(handler = () => { throw new Error('Unexpected request'); }) {
  const nodes = new Map();
  const storage = new Map();
  const entries = [];
  function node(id) {
    if (!nodes.has(id)) nodes.set(id, {
      textContent: '', innerHTML: '', hidden: false, disabled: false, dataset: {},
      classList: {toggle() {}}, querySelectorAll: () => [], closest: () => null,
      addEventListener() {}
    });
    return nodes.get(id);
  }
  const calls = [];
  const pending = {data: 0, embeddings: 0};
  const peak = {data: 0, embeddings: 0};
  const context = vm.createContext({
    document: {
      getElementById: node, addEventListener() {},
      querySelectorAll: () => entries
    },
    localStorage: {getItem: key => storage.get(key) || null, setItem: (k, v) => storage.set(k, v)},
    setTimeout: () => 1, clearTimeout() {},
    atob: text => Buffer.from(text, 'base64').toString('binary'),
    btoa: text => Buffer.from(text, 'binary').toString('base64'),
    fetch: async (url, options) => {
      const clean = String(url).split('?')[0];
      calls.push({url: clean, method: options?.method || 'GET'});
      const group = clean.startsWith('data/emb/') ? 'embeddings' : clean.startsWith('data/') ? 'data' : null;
      if (group) { pending[group]++; peak[group] = Math.max(peak[group], pending[group]); }
      try { await pause(); return await handler(clean, options); }
      finally { if (group) pending[group]--; }
    }
  });
  vm.runInContext(instrumented, context, {filename: sourcePath});
  const api = context.testApi;
  function configureKey() {
    storage.set('tr_provider', 'siliconflow');
    storage.set('tr_key', 'synthetic-test-key');
  }
  function translationEntry(doi = '10.test/abstract') {
    const box = {hidden: true, innerHTML: '', textContent: ''};
    const readButton = {textContent: '', classList: {toggle() {}}};
    const entry = {
      dataset: {doi}, classList: {toggle() {}},
      querySelector: sel => sel === '.abs-zh' ? box : readButton
    };
    const btn = {textContent: '翻译摘要', disabled: false, closest: () => entry};
    api.S.workIndex[doi] = {doi, abs: 'A synthetic English sentence.'};
    entries.push(entry);
    return {doi, btn, box, readButton};
  }
  return {api, node, calls, peak, configureKey, translationEntry};
}

function corpus(h, count, readCount = 0) {
  const year = new Date().getFullYear();
  const years = {}, data = new Map(), read = [];
  for (let i = 0; i < count; i++) {
    const y = String(year - i), doi = '10.test/article-' + i;
    years[y] = 1;
    data.set('data/test/' + y + '.json', [{doi, t: 'Synthetic article ' + i,
      a: [], d: y + '-01-01', abs: 'Synthetic abstract about accountability.', k: []}]);
    data.set('data/emb/test/' + y + '.json', {items: {
      [doi]: Buffer.from(i < readCount ? [127, 0] : [100, 70]).toString('base64')
    }});
    if (i < readCount) read.push(doi);
  }
  h.api.S.manifest = {journals: [{slug: 'test', name: 'Synthetic Journal', years}]};
  h.api.S.jBySlug.test = h.api.S.manifest.journals[0];
  h.api.S.query = 'accountability';
  h.api.S.read.items = read;
  return data;
}

async function settled(button) {
  const deadline = Date.now() + 2000;
  while (button.disabled && Date.now() < deadline) await pause();
  assert.equal(button.disabled, false, 'Search must finish and re-enable its button');
}

test('keyword search bounds parallel shard loads and completes every shard', async () => {
  let data;
  const h = harness(url => response(data.get(url)));
  data = corpus(h, 23);
  h.api.runKeywordSearch();
  await settled(h.node('kw-btn'));
  assert.equal(h.peak.data, 6);
  assert.equal(h.calls.length, 23);
  assert.equal((h.node('latest-list').innerHTML.match(/class="entry(?: is-read)?"/g) || []).length, 23);
  assert.match(h.node('latest-list').innerHTML, /命中 23 条/);
});

test('keyword search keeps title-only, year and unread filters', async () => {
  let data;
  const h = harness(url => response(data.get(url)));
  data = corpus(h, 8, 1);
  h.api.S.unreadOnly = true;
  h.api.S.yearRange = '0:4';
  h.api.S.query = 'synthetic';
  h.api.S.searchScope = 'title';
  h.api.runKeywordSearch();
  await settled(h.node('kw-btn'));
  assert.equal(h.calls.length, 5);
  const html = h.node('latest-list').innerHTML;
  assert.match(html, /命中 4 条/);
  assert.doesNotMatch(html, /data-doi="10.test\/article-0"/);
});

test('semantic search filters read items before top-50 and bounds hydration too', async () => {
  let data;
  const h = harness(url => url.endsWith('/embeddings') ? response({data: [{embedding: [1, 0]}]}) : response(data.get(url)));
  data = corpus(h, 72, 54);
  h.configureKey();
  h.api.S.unreadOnly = true;
  h.api.S.query = 'a meaning absent from the literal titles';
  h.api.runSemantic();
  await settled(h.node('sem-btn'));
  assert.equal(h.peak.embeddings, 6);
  assert.equal(h.peak.data, 6);
  const html = h.node('latest-list').innerHTML;
  assert.match(html, /按相关度取前 18 条/);
  assert.equal((html.match(/class="entry(?: is-read)?"/g) || []).length, 18);
  assert.doesNotMatch(html, /data-doi="10.test\/article-0"/);
  assert.match(html, /data-doi="10.test\/article-71"/);
});

test('semantic search reports zero for all-read scope without loading article shards', async () => {
  let data;
  const h = harness(url => url.endsWith('/embeddings') ? response({data: [{embedding: [1, 0]}]}) : response(data.get(url)));
  data = corpus(h, 8, 8);
  h.configureKey();
  h.api.S.unreadOnly = true;
  h.api.runSemantic();
  await settled(h.node('sem-btn'));
  assert.match(h.node('latest-list').innerHTML, /按相关度取前 0 条/);
  assert.equal(h.peak.data, 0);
});

test('semantic search retains top-50 when read filtering is off and skips absent vectors', async () => {
  let data;
  const h = harness(url => url.endsWith('/embeddings') ? response({data: [{embedding: [1, 0]}]}) :
    data.has(url) ? response(data.get(url)) : response({}, 404));
  data = corpus(h, 60, 54);
  data.delete('data/emb/test/' + (new Date().getFullYear() - 2) + '.json');
  h.configureKey();
  h.api.runSemantic();
  await settled(h.node('sem-btn'));
  assert.match(h.node('latest-list').innerHTML, /已扫描 59 条标题 · 按相关度取前 50 条/);
  assert.equal((h.node('latest-list').innerHTML.match(/class="entry(?: is-read)?"/g) || []).length, 50);
});

test('semantic service failure restores the button and reports failure', async () => {
  const h = harness(() => response({}, 503));
  corpus(h, 1);
  h.configureKey();
  h.api.runSemantic();
  await settled(h.node('sem-btn'));
  assert.match(h.node('toast').textContent, /语义搜索失败：HTTP 503/);
});

test('missing translation key leaves the article unread without a request', async () => {
  const h = harness();
  const entry = h.translationEntry();
  await h.api.translateEntry(entry.btn);
  assert.equal(h.api.S.read.items.length, 0);
  assert.equal(h.calls.length, 0);
  assert.match(entry.btn.textContent, /配置翻译 Key/);
});

test('translation service failure preserves unread state', async () => {
  const h = harness(() => response({}, 403));
  h.configureKey();
  const entry = h.translationEntry();
  h.api.translateEntry(entry.btn);
  await settled(entry.btn);
  assert.equal(h.api.S.read.items.length, 0);
  assert.equal(entry.box.hidden, true);
  assert.match(entry.btn.textContent, /翻译失败：HTTP 403/);
});

test('translation marks read only after success; cached hide/show makes no request', async () => {
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  const h = harness(async () => { await gate; return response({choices: [{message: {
    content: 'EN: A synthetic English sentence.\nZH: 一句合成测试译文。'
  }}]}); });
  h.configureKey();
  const entry = h.translationEntry();
  h.api.translateEntry(entry.btn);
  assert.equal(h.api.S.read.items.length, 0, 'Pending translation must remain unread');
  release();
  await settled(entry.btn);
  assert.equal(h.api.S.read.items[0], entry.doi);
  assert.equal(entry.box.hidden, false);
  assert.match(entry.box.innerHTML, /一句合成测试译文/);
  h.api.S.read.items = []; // The reader explicitly marks it unread.
  h.api.translateEntry(entry.btn); // Hiding a cached translation should preserve that choice.
  assert.equal(entry.box.hidden, true);
  assert.equal(h.api.S.read.items.length, 0);
  h.api.translateEntry(entry.btn);
  assert.equal(entry.box.hidden, false);
  assert.equal(h.api.S.read.items[0], entry.doi);
  assert.equal(h.calls.length, 1);
});

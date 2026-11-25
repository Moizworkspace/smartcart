import { stores } from './comparison.mjs';

import { secureUrl } from './comparison.mjs';
import { brochureKeyword, compareMonthly, matchesGroceryCategory, parsePackage } from './grocery-ranking.mjs';

const origin = 'https://ksaprice.com';
const maxPages = 12;
const cache = new Map();
const entities = { amp: '&', quot: '"', apos: "'", lt: '<', gt: '>', nbsp: ' ' };
const riyadh = new Intl.DateTimeFormat('sv-SE', { timeZone: 'Asia/Riyadh' });
const articles = /<article\b[^>]*>[\s\S]*?<\/article>/gi;
const brochureDate = '[A-Z][a-z]{2} \\d{1,2}, \\d{4}';

function plain(html = '') {
  return html.replace(/<[^>]*>/g, '').replace(/&(#x[\da-f]+|#\d+|\w+);/gi, (entity, name) => {
    if (name[0] !== '#') return entities[name] ?? entity;
    const point = name[1].toLowerCase() === 'x' ? parseInt(name.slice(2), 16) : Number(name.slice(1));
    return point <= 0x10ffff ? String.fromCodePoint(point) : entity;
  }).replace(/\s+/g, ' ').trim();
}

function dateOnly(label) {
  const time = Date.parse(label + ' UTC');
  return Number.isFinite(time) ? new Date(time).toISOString().slice(0, 10) : null;
}

function capture(html, expression) {
  return plain(html.match(expression)?.[1]);
}

function publications(html, today) {
  const result = [];
  const startPattern = new RegExp('Deal Start:</dt>\\s*<dd[^>]*>\\s*(' + brochureDate + ')');
  const endPattern = new RegExp('Deal End:</dt>\\s*<dd[^>]*>\\s*(' + brochureDate + ')');
  for (const [card] of html.matchAll(articles)) {
    const id = capture(card, /data-deal-id="(\d+)"/);
    const start = dateOnly(capture(card, startPattern));
    const end = dateOnly(capture(card, endPattern));
    if (!id || !start || !end || start > today || end < today || !/<\/i>&nbsp;\s*Valid\b/i.test(card)) continue;
    result.push({
      id, start, end,
      title: capture(card, /<h6[^>]*class="[^"]*card-title[^"]*"[^>]*>([\s\S]*?)<\/h6>/i),
      scope: capture(card, /<dd\b[^>]*>[\s\S]*?<span\b[^>]*>([\s\S]*?)<\/span>/i),
    });
  }
  return result;
}

function extractProducts(html, brochures, store, searchUrl) {
  const result = [];
  for (const [card] of html.matchAll(articles)) {
    const brochure = brochures.get(capture(card, /data-deal-id="(\d+)"/));
    if (!brochure || !/text-bg-success[^>]*>\s*Active\s*<\/span>/i.test(card)) continue;
    const product = capture(card, /<p class="h6[^"]*"[^>]*>([\s\S]*?)<\/p>/i);
    const detail = capture(card, /<p class="text-muted small mb-0"[^>]*>([\s\S]*?)<\/p>/i);
    const priceLabel = capture(card, /<span class="fs-5 fw-bold text-body"[^>]*>([\s\S]*?)<\/span>/i);
    const imageUrl = secureUrl(capture(card, /<img\s+src="([^"]+\/crops\/[^"]+)"[^>]*>/i));
    const vendorId = capture(card, /data-vendor-id="(\d+)"/);
    const slide = capture(card, /data-id="(\d+)"/);
    if (!product || !vendorId || !slide) continue;
    const itemEnd = dateOnly(capture(card, new RegExp('fa-clock2[^>]*><\\/i>\\s*(' + brochureDate + ')')));
    const end = itemEnd && itemEnd < brochure.end ? itemEnd : brochure.end;
    const sourceUrl = new URL(searchUrl);
    sourceUrl.hash = 'lg=offer_' + brochure.id + '_' + vendorId + '_' + slide + '&slide=' + slide;
    const amount = priceLabel.match(/^SAR\s+([\d,]+(?:\.\d{1,2})?)$/);
    result.push({
      retailer: store.name, product, detail, priceLabel, imageUrl,
      price: amount ? Number(amount[1].replaceAll(',', '')) : null,
      start: brochure.start, end, brochure: brochure.title, scope: brochure.scope,
      sourceUrl: sourceUrl.href,
    });
  }
  return result;
}

async function cached(url) {
  const now = Date.now();
  const key = url.href;
  if (cache.get(key)?.until > now) return cache.get(key).value;
  const value = fetch(url, { signal: AbortSignal.timeout(7000), redirect: 'error' }).then(async response => {
    if (!response.ok) throw new Error('KSAPrice returned HTTP ' + response.status);
    return response.text();
  });
  if (cache.size >= 120) cache.delete(cache.keys().next().value);
  cache.set(key, { value, until: now + 5 * 60 * 1000 });
  try { return await value; }
  catch (error) {
    if (cache.get(key)?.value === value) cache.delete(key);
    throw error;
  }
}

async function scanPages(first, accept, visit) {
  const pending = new Map([[first.href, first]]);
  const seen = new Set();
  while (pending.size && seen.size < maxPages) {
    const [key, url] = pending.entries().next().value;
    pending.delete(key);
    const html = await cached(url);
    seen.add(key);
    visit(html, url);
    for (const [, href] of html.matchAll(/<a\b[^>]*\bhref="([^"]+)"[^>]*>/gi)) {
      const next = new URL(plain(href), url);
      if (next.origin !== origin || !accept(next)) continue;
      next.hash = "";
      next.searchParams.sort();
      if (!seen.has(next.href)) pending.set(next.href, next);
    }
  }
  return pending.size === 0;
}

async function searchRetailer(store, term, today) {
  const brochures = new Map();
  const listUrl = new URL(store.url);
  const listComplete = await scanPages(listUrl,
    next => next.pathname.startsWith(listUrl.pathname + '/page/') &&
      /^\d+$/.test(next.pathname.slice((listUrl.pathname + '/page/').length)) && !next.search,
    html => {
      if (!html.includes('id="dealSearch"')) throw new Error('Brochure listing unavailable');
      for (const brochure of publications(html, today)) brochures.set(brochure.id, brochure);
    });
  const items = [];
  let searchComplete = true;
  if (brochures.size) {
    const queryUrl = new URL('/en/deal/search/q/' + encodeURIComponent(term).replaceAll('%20', '+'), origin);
    queryUrl.searchParams.set('city', 'jeddah');
    queryUrl.searchParams.set('vendor', store.id);
    searchComplete = await scanPages(queryUrl,
      next => next.pathname === queryUrl.pathname && next.searchParams.get('city') === 'jeddah' &&
        next.searchParams.get('vendor') === store.id && /^\d+$/.test(next.searchParams.get('page') ?? ''),
      (html, searchUrl) => {
        if (!html.includes('id="dealSearch"') && !html.includes('data-deal-id=') &&
            !/no results/i.test(plain(html.replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, '')))) {
          throw new Error('Brochure product search unavailable');
        }
        items.push(...extractProducts(html, brochures, store, searchUrl).filter(item => item.end >= today));
      });
  }
  return { store: store.name, brochures: [...brochures.values()], items, complete: listComplete && searchComplete };
}

export async function searchActiveDeals(term, now = new Date()) {
  const today = riyadh.format(now);
  const results = await Promise.allSettled(stores.map(store => searchRetailer(store, brochureKeyword(term), today)));
  const byItem = new Map();
  const coverage = results.map((result, i) => {
    if (result.status === 'rejected') {
      console.warn(stores[i].name + ' brochure search: ' + result.reason.message);
      return { store: stores[i].name, unavailable: true };
    }
    const { store, brochures, items, complete } = result.value;
    for (const item of items) {
      const key = JSON.stringify([item.retailer, item.product, item.detail, item.priceLabel, item.brochure, item.start, item.end, item.scope]);
      if (!matchesGroceryCategory(item, term)) continue;
      byItem.set(key, { ...item, package: parsePackage(item.product, item.detail, item.price) });
    }
    return { store, brochures, complete };
  });
  const items = [...byItem.values()].sort((a, b) => compareMonthly(a, b, term));
  return { asOf: today, coverage, items };
}

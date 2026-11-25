import { DatabaseSync } from 'node:sqlite';
import { createHash, randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { secureUrl, stores } from './comparison.mjs';

export const dataDir = resolve(process.env.SMARTCART_DATA_DIR || fileURLToPath(new URL('.smartcart/', import.meta.url)));
mkdirSync(dataDir, { recursive: true });
const db = new DatabaseSync(resolve(dataDir, 'smartcart.sqlite'));
db.exec(`
  PRAGMA journal_mode=WAL;
  PRAGMA foreign_keys=ON;
  PRAGMA busy_timeout=5000;
  CREATE TABLE IF NOT EXISTS stores (id TEXT PRIMARY KEY, name TEXT NOT NULL, brochures_url TEXT NOT NULL);
  CREATE TABLE IF NOT EXISTS locations (
    id TEXT PRIMARY KEY, store_id TEXT NOT NULL REFERENCES stores(id),
    name TEXT NOT NULL, area TEXT NOT NULL, lat REAL NOT NULL, lon REAL NOT NULL
  );
  CREATE TABLE IF NOT EXISTS products (
    id TEXT PRIMARY KEY, kind TEXT NOT NULL CHECK(kind IN ('catalog','brochure')),
    name TEXT NOT NULL, details TEXT NOT NULL, image_url TEXT
  );
  CREATE TABLE IF NOT EXISTS offers (
    id TEXT PRIMARY KEY, product_id TEXT NOT NULL REFERENCES products(id),
    store_id TEXT NOT NULL REFERENCES stores(id), location_id TEXT REFERENCES locations(id),
    status TEXT NOT NULL CHECK(status IN ('pending','verified','indexed')),
    price_cents INTEGER CHECK(price_cents>0), starts_at TEXT NOT NULL, expires_at TEXT NOT NULL,
    observed_at TEXT NOT NULL, verified_at TEXT, source_url TEXT NOT NULL, details TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS offers_status_expiry ON offers(status, expires_at);
  CREATE INDEX IF NOT EXISTS offers_product ON offers(product_id);
  CREATE TABLE IF NOT EXISTS settings (name TEXT PRIMARY KEY);
`);
const putStore = db.prepare('INSERT OR IGNORE INTO stores VALUES (?,?,?)');
for (const store of stores) putStore.run(store.id, store.name, store.url);
const putProduct = db.prepare(`INSERT INTO products VALUES (?,?,?,?,?)
  ON CONFLICT(id) DO UPDATE SET name=excluded.name, details=excluded.details, image_url=excluded.image_url`);
const putLocation = db.prepare(`INSERT INTO locations VALUES (?,?,?,?,?,?)
  ON CONFLICT(id) DO UPDATE SET name=excluded.name,area=excluded.area,lat=excluded.lat,lon=excluded.lon`);
const putOffer = db.prepare(`INSERT INTO offers VALUES (?,?,?,?,?,?,?,?,?,?,?,?)
  ON CONFLICT(id) DO UPDATE SET observed_at=excluded.observed_at,
    source_url=excluded.source_url, details=excluded.details WHERE offers.status='indexed'`);

function transaction(action) {
  db.exec('BEGIN IMMEDIATE');
  try { const output = action(); db.exec('COMMIT'); return output; }
  catch (error) { db.exec('ROLLBACK'); throw error; }
}

const hash = (...parts) => createHash('sha256').update(JSON.stringify(parts)).digest('hex');
const text = (value, limit = 140) => typeof value === 'string' ? value.trim().slice(0, limit) : '';
const number = value => value === '' || value == null ? NaN : Number(value);
function cents(value) {
  const amount = Math.round(number(value) * 100);
  return Number.isSafeInteger(amount) && amount > 0 ? amount : null;
}
function stamp(value) {
  if (typeof value !== 'string' || !/(?:Z|[+-]\d{2}:\d{2})$/i.test(value)) return null;
  const date = new Date(value);
  return Number.isFinite(date.getTime()) ? date.toISOString() : null;
}
function startOfDay(day) { return Date.parse(day + 'T00:00:00+03:00'); }

export function indexBrochures(items, now = new Date()) {
  if (!items.length) return;
  transaction(() => {
    for (const item of items) {
      const store = stores.find(entry => entry.name === item.retailer);
      if (!store) continue;
      const productId = 'brochure-' + hash(store.id, item.product, item.detail);
      const source = new URL(item.sourceUrl);
      const id = 'brochure-' + hash(productId, source.hash, item.imageUrl, item.start, item.end, item.priceLabel);
      putProduct.run(productId, 'brochure', item.product, JSON.stringify({ detail: item.detail }), item.imageUrl || null);
      putOffer.run(id, productId, store.id, null, 'indexed', cents(item.price),
        new Date(startOfDay(item.start)).toISOString(), new Date(startOfDay(item.end) + 86400000).toISOString(),
        now.toISOString(), null, source.href, JSON.stringify({ brochure: item.brochure, scope: item.scope }));
    }
  });
}

export function saveProduct(input) {
  const id = text(input.id, 80) || randomUUID();
  const name = text(input.name);
  if (!name || !/^[\w-]+$/.test(id) || id.startsWith('brochure-')) throw new Error('Enter a product name and a valid catalog ID.');
  const imageUrl = input.imageUrl ? secureUrl(input.imageUrl) : null;
  if (input.imageUrl && !imageUrl) throw new Error('Enter an HTTPS image URL.');
  const barcode = text(input.barcode, 30);
  if (barcode && !/^\d{8,14}$/.test(barcode)) throw new Error('Enter an 8–14 digit barcode.');
  const quantity = number(input.quantity);
  const product = { id, name, brand: text(input.brand), size: text(input.size, 40), arabic: text(input.arabic),
    variant: text(input.variant), unit: text(input.unit, 20), quantity: Number.isFinite(quantity) && quantity > 0 ? quantity : null,
    barcode, aliases: Array.isArray(input.aliases) ? input.aliases.map(alias => text(alias)).filter(Boolean).slice(0, 20) : [],
    imageUrl };
  putProduct.run(id, 'catalog', name, JSON.stringify(product), imageUrl);
  return product;
}

export function saveLocation(input) {
  const id = text(input.id, 80) || randomUUID();
  const name = text(input.name), area = text(input.area), store = text(input.storeId);
  const lat = number(input.lat), lon = number(input.lon);
  if (!name || !area || !stores.some(s => s.id === store) ||
      !Number.isFinite(lat) || !Number.isFinite(lon) || Math.abs(lat) > 90 || Math.abs(lon) > 180) {
    throw new Error('Enter a retailer, branch, neighbourhood and valid coordinates.');
  }
  const existing = db.prepare('SELECT store_id FROM locations WHERE id=?').get(id);
  if (existing && existing.store_id !== store) throw new Error('An existing branch cannot change retailers.');
  putLocation.run(id, store, name, area, lat, lon);
  return { id, name, area, storeId: store, lat, lon };
}

export function submitOffer(input, actor, trustedImport = false) {
  const store = actor.storeId ?? text(input.storeId);
  const productId = text(input.productId, 80);
  const product = db.prepare("SELECT id FROM products WHERE id=? AND kind='catalog'").get(productId);
  const locationId = text(input.locationId, 80) || null;
  const branch = locationId && db.prepare('SELECT id FROM locations WHERE id=? AND store_id=?').get(locationId, store);
  const price = cents(input.price);
  const startsAt = stamp(input.startsAt), expiresAt = stamp(input.expiresAt);
  const source = secureUrl(input.sourceUrl);
  if (!product || !stores.some(s => s.id === store) || (locationId && !branch) ||
      !price || !startsAt || !expiresAt || startsAt >= expiresAt || !source) {
    throw new Error('Enter a catalog product, retailer, valid branch if applicable, price, dates and HTTPS evidence.');
  }
  const observed = (trustedImport && stamp(input.observedAt)) || new Date().toISOString();
  const id = 'catalog-' + hash(productId, store, locationId, price, startsAt, expiresAt, source);
  putOffer.run(id, productId, store, locationId, trustedImport ? 'verified' : 'pending',
    price, startsAt, expiresAt, observed, trustedImport ? observed : null, source,
    JSON.stringify({ conditions: text(input.conditions, 300), scope: locationId ? 'branch' : 'Jeddah' }));
  return { id };
}

export function verifyOffer(id) {
  const result = db.prepare("UPDATE offers SET status='verified',verified_at=? WHERE id=? AND status='pending'")
    .run(new Date().toISOString(), id);
  if (!result.changes) throw new Error('This submission is no longer pending.');
}

const locations = () => db.prepare('SELECT id,store_id AS storeId,name,area,lat,lon FROM locations ORDER BY area,name').all();
const catalogProducts = () => db.prepare("SELECT details FROM products WHERE kind='catalog' ORDER BY name")
  .all().map(row => JSON.parse(row.details));
const joined = `SELECT o.*,p.name AS product_name,p.image_url,l.name AS branch_name,l.area,l.lat,l.lon
  FROM offers o JOIN products p ON p.id=o.product_id LEFT JOIN locations l ON l.id=o.location_id`;

function publicOffer(row) {
  return { id: row.id, productId: row.product_id, storeId: row.store_id, productName: row.product_name,
    imageUrl: row.image_url, price: row.price_cents === null ? null : row.price_cents / 100,
    startsAt: row.starts_at, expiresAt: row.expires_at, observedAt: row.observed_at,
    status: row.status, verified: row.status === 'verified', sourceUrl: row.source_url,
    branch: row.location_id ? { name: row.branch_name, area: row.area, lat: row.lat, lon: row.lon } : null,
    ...JSON.parse(row.details) };
}

export function readCatalog() {
  const rows = db.prepare(joined + " WHERE o.status='verified' AND o.expires_at>?").all(new Date().toISOString());
  const products = catalogProducts();
  const offers = rows.map(publicOffer);
  return { products, offers, locations: locations() };
}

export function readPortal(actor, query) {
  const pattern = '%' + text(query, 100).toLowerCase() + '%';
  const scope = actor.storeId ?? null;
  const offers = db.prepare(joined + " WHERE lower(p.name) LIKE ? AND (o.store_id=? OR ? IS NULL) ORDER BY (o.status='pending') DESC, o.observed_at DESC LIMIT 100")
    .all(pattern, scope, scope).map(publicOffer);
  return { role: actor.role, storeId: scope, stores, products: catalogProducts(),
    locations: locations().filter(location => !scope || location.storeId === scope), offers };
}

transaction(() => {
  if (db.prepare("SELECT name FROM settings WHERE name='catalog-import-v1'").get()) return;
  const seed = JSON.parse(readFileSync(new URL('catalog.json', import.meta.url), 'utf8'));
  for (const product of seed.products) saveProduct(product);
  for (const offer of seed.offers) {
    if (!offer.verified || !['branch', 'Jeddah'].includes(offer.scope)) continue;
    try {
      const locationId = offer.scope === 'branch'
        ? saveLocation({ ...offer.branch, storeId: offer.storeId, id: hash(offer.storeId, offer.branch?.name, offer.branch?.area) }).id : null;
      submitOffer({ ...offer, startsAt: offer.startsAt ?? offer.observedAt, locationId }, {}, true);
    } catch (error) { console.warn('Skipped invalid legacy catalog offer:', error.message); }
  }
  db.prepare("INSERT INTO settings VALUES ('catalog-import-v1')").run();
});

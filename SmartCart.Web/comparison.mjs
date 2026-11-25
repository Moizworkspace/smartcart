const retailers = [
  ['Panda', 'panda'], ['Carrefour', 'carrefour'], ['Danube', 'danube'],
  ['Al Othaim', 'othaim'], ['LuLu', 'lulu'],
];

export const stores = retailers.map(([name, id]) => ({
  name, id, url: 'https://ksaprice.com/en/deal/index/vendor/' + id + '/location/jeddah',
}));

export const demoCatalog = {
  products: [
    { id: 'milk-1l', name: 'Full-fat milk', arabic: 'حليب كامل الدسم', brand: 'Demo Dairy', size: '1 L', quantity: 1, unit: 'L', barcode: '2000000000015' },
    { id: 'milk-2l', name: 'Full-fat milk', arabic: 'حليب كامل الدسم', brand: 'Demo Dairy', size: '2 L', quantity: 2, unit: 'L' },
    { id: 'rice-5kg', name: 'Basmati rice', arabic: 'أرز بسمتي', brand: 'Demo Pantry', size: '5 kg', quantity: 5, unit: 'kg' },
  ],
  offers: [[5.5, 5.95, 6.25, 6.75, 7], [10.95, 11.6, 11.25, 13, 12.25], [28.5, 30, 32.25, 29, 31]].flatMap(
    (prices, i) => prices.map((price, j) => ({
      productId: ['milk-1l', 'milk-2l', 'rice-5kg'][i], storeId: stores[j].id, price, scope: 'Jeddah',
    })),
  ),
};

function normalize(value) {
  return value.toLowerCase().normalize('NFKD').replace(/\p{M}/gu, '')
    .replace(/[أإآٱ]/g, 'ا').replace(/[٠-٩]/g, digit => '٠١٢٣٤٥٦٧٨٩'.indexOf(digit))
    .replace(/[۰-۹]/g, digit => '۰۱۲۳۴۵۶۷۸۹'.indexOf(digit))
    .replace(/(\d)\s*(kg|ml|l|g|كجم|مل|لتر|جم)(?![\p{L}\p{N}])/gu,
      (_, amount, unit) => amount + ' ' + ({ كجم: 'kg', مل: 'ml', لتر: 'l', جم: 'g' }[unit] ?? unit))
    .replace(/[^\p{L}\p{N}.]+/gu, ' ').trim();
}

function productTokens(product) {
  return new Set(normalize([product.name, product.arabic, product.brand, product.variant, product.size, ...(product.aliases ?? [])].filter(Boolean).join(' ')).split(' '));
}

export function searchProducts(products, query, fromPhoto = false) {
  const clean = normalize(query);
  if (!clean) return [];
  if (/^\d{8,14}$/.test(clean)) return products.filter(product => product.barcode === clean);
  const terms = [...new Set(clean.split(' '))];
  return products.map(product => {
    const tokens = productTokens(product);
    return { product, hits: terms.filter(term => tokens.has(term)).length };
  }).filter(({ hits }) => fromPhoto ? hits >= 1 : hits === terms.length)
    .sort((a, b) => b.hits - a.hits).slice(0, 12).map(({ product }) => product);
}

function distanceKm(a, b) {
  const rad = Math.PI / 180;
  const lat = (b.lat - a.lat) * rad;
  const lon = (b.lon - a.lon) * rad;
  const h = Math.sin(lat / 2) ** 2 + Math.cos(a.lat * rad) * Math.cos(b.lat * rad) * Math.sin(lon / 2) ** 2;
  return 6371 * 2 * Math.asin(Math.sqrt(Math.min(1, h)));
}

export function secureUrl(value) {
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && !url.username && !url.password ? url.href : null;
  } catch { return null; }
}

function isCurrent(offer, now) {
  const observed = Date.parse(offer.observedAt);
  const start = Date.parse(offer.startsAt ?? offer.observedAt);
  const expiry = Date.parse(offer.expiresAt);
  return offer.verified === true && Boolean(secureUrl(offer.sourceUrl)) &&
    observed <= now && start <= now && now < expiry;
}

export function compareOffers(offers, product, settings = {}) {
  const { demo = false, area = '', location = null, radius = 5, sort = 'price', now = Date.now() } = settings;
  const rows = stores.map(store => {
    const matching = offers.filter(offer => offer.productId === product?.id && offer.storeId === store.id);
    const eligible = matching.filter(offer => Number.isFinite(offer.price) && offer.price > 0 &&
      (demo || isCurrent(offer, now)) &&
      (offer.scope === 'Jeddah' || (offer.scope === 'branch' && Boolean(offer.branch?.name) && Boolean(offer.branch?.area) && (!area || offer.branch.area === area))));
    const nearby = eligible.map(offer => {
      const branch = offer.branch;
      const hasCoordinates = Number.isFinite(branch?.lat) && Math.abs(branch.lat) <= 90 &&
        Number.isFinite(branch?.lon) && Math.abs(branch.lon) <= 180;
      return { offer, distance: location && offer.scope === 'branch' && hasCoordinates ? distanceKm(location, branch) : null };
    }).filter(row => !location || row.distance === null || row.distance <= radius);
    const selected = nearby.sort((a, b) => a.offer.price - b.offer.price ||
      (a.distance ?? Infinity) - (b.distance ?? Infinity) ||
      (Date.parse(b.offer.observedAt) || 0) - (Date.parse(a.offer.observedAt) || 0))[0];
    return {
      store, offer: selected?.offer, distance: selected?.distance ?? null,
      unitPrice: selected && product.quantity > 0 ? selected.offer.price / product.quantity : null,
      hasRecords: matching.length > 0,
    };
  });
  return rows.sort((a, b) => {
    const priceOrder = (a.offer?.price ?? Infinity) - (b.offer?.price ?? Infinity);
    if (sort === 'distance') return (a.distance ?? Infinity) - (b.distance ?? Infinity) || priceOrder;
    if (sort === 'unit') return (a.unitPrice ?? Infinity) - (b.unitPrice ?? Infinity) || priceOrder;
    return priceOrder || (a.distance ?? Infinity) - (b.distance ?? Infinity);
  });
}

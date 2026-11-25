import { groceryChoices } from './grocery-ranking.mjs';
import { getBarcode, guessFromImage, guessFromText, labelSuggestions, normalizePhotoName, resizedPhoto } from './photo-lookup.mjs';
import { compareOffers, demoCatalog, searchProducts, secureUrl } from './comparison.mjs';

const byId = id => document.getElementById(id);
const query = byId('query');
const demo = byId('demo');
const area = byId('area');
const photo = byId('photo');
const camera = byId('camera');
const upload = byId('upload');
const photoStatus = byId('photo-status');
const summary = byId('summary');
const title = byId('title');
const candidates = byId('candidates');
const results = byId('results');
const radius = byId('radius');
const sort = byId('sort');
const catalog = { products: [], offers: [] };
let catalogStatus = 'Loading the verified catalog…';
let product = null;
let location = null;
let scanInProgress = false;
const currentCatalog = () => demo.checked ? demoCatalog : catalog;
const money = value => 'SAR ' + value.toFixed(2);
const date = new Intl.DateTimeFormat('en-GB', { dateStyle: 'medium', timeZone: 'Asia/Riyadh' });

function element(tag, value, className) {
  const node = document.createElement(tag);
  if (value) node.textContent = value;
  if (className) node.className = className;
  return node;
}

function link(label, url) {
  const anchor = element('a', label);
  anchor.href = url;
  anchor.target = '_blank';
  anchor.rel = 'noopener noreferrer';
  return anchor;
}

function productLabel(item) {
  return [item.brand, item.name, item.variant, item.size].filter(Boolean).join(' · ');
}

function render(message) {
  const rows = compareOffers(currentCatalog().offers, product, {
    demo: demo.checked, area: area.value, location, radius: Number(radius.value), sort: sort.value,
  });
  const prices = rows.filter(row => row.offer).map(row => row.offer.price);
  const lowest = Math.min(...prices);
  title.textContent = product ? productLabel(product) : 'Compare stores';
  summary.textContent = message ?? (demo.checked
    ? 'Demo mode. These fictional prices are for testing.'
    : catalogStatus || (product ? prices.length + ' of 5 retailers have a verified matching offer.' : 'Search for a product to compare offers.'));
  results.replaceChildren(...rows.map(({ store, offer, distance, unitPrice, hasRecords }) => {
    const card = element('article', '', 'store');
    if (offer && offer.price === lowest) card.classList.add('low');
    const name = element('div');
    name.append(element('h3', store.name));
    if (distance !== null) name.append(element('small', distance.toFixed(1) + ' km straight-line'));
    const details = element('div');
    const price = element('div');
    if (offer) {
      price.append(element('p', money(offer.price), 'amount'));
      if (unitPrice !== null && product.unit) price.append(element('small', money(unitPrice) + '/' + product.unit));
      details.append(element('p', demo.checked ? 'Example price' : offer.scope === 'branch' ? offer.branch.name : 'Jeddah offer · Branch stock unknown'));
      if (!demo.checked) {
        details.append(element('small', 'Checked ' + date.format(new Date(offer.observedAt)) + ' · Ends ' + date.format(new Date(offer.expiresAt))));
        if (offer.conditions) details.append(element('small', offer.conditions));
        details.append(link('Price source', secureUrl(offer.sourceUrl)), document.createTextNode(' · '));
      }
    } else {
      details.append(element('p', product && hasRecords ? 'No current verified offer for this area' : 'No verified price available'));
    }
    details.append(link('Browse promotions', store.url), document.createTextNode(' · '));
    const place = [offer?.branch?.name ?? store.name, area.value, 'Jeddah'].filter(Boolean).join(' ');
    const branch = offer?.branch;
    if (branch && Number.isFinite(branch.lat) && Number.isFinite(branch.lon)) {
      const coords = branch.lat + ',' + branch.lon;
      details.append(link('Directions', 'https://www.google.com/maps/dir/?api=1&destination=' + encodeURIComponent(coords)));
    } else {
      details.append(link('Find stores on map', 'https://www.google.com/maps/search/?api=1&query=' + encodeURIComponent(place)));
    }
    card.append(name, details, price);
    return card;
  }));
}

function setProduct(item) {
  product = item;
  candidates.hidden = true;
  query.value = productLabel(item).replaceAll(' · ', ' ');
  render();
}

function runSearch(text, fromPhoto = false) {
  product = null;
  candidates.hidden = true;
  const matches = searchProducts(currentCatalog().products, text, fromPhoto);
  if (!matches.length) {
    render(demo.checked ? 'No matching demo product. Try milk, rice, or حليب.' :
      catalogStatus || 'No matching product. Try the exact name, brand, pack size, or barcode.');
    return false;
  }
  if (matches.length === 1 && !fromPhoto) {
    setProduct(matches[0]);
    return true;
  }
  candidates.replaceChildren(element('p', 'Choose the exact product and pack size.'));
  for (const item of matches) {
    const button = element('button', productLabel(item) + (item.arabic ? ' · ' + item.arabic : ''), 'choice');
    button.type = 'button';
    button.addEventListener('click', () => { setProduct(item); title.scrollIntoView({ block: 'nearest' }); });
    candidates.append(button);
  }
  candidates.hidden = false;
  render('Select a matching product to see prices.');
  return true;
}

const brochureSection = byId('brochure-search');
const brochureStatus = byId('brochure-status');
const brochureResults = byId('brochure-results');
const catalogComparison = byId('catalog-comparison');
let activeSearch;
let dealItems = [];
let retailerFilter = '';
let visibleCount = 20;
const filterBar = byId('retailer-filters');
const dealOrder = byId('deal-order');
const showMore = byId('show-more');
const phoneDialog = byId('phone-dialog');

function cancelBrochureSearch() {
  activeSearch?.abort();
  activeSearch = undefined;
  brochureSection.hidden = true;
  catalogComparison.hidden = false;
}

function brochureDate(value) {
  return date.format(new Date(value + 'T12:00:00+03:00'));
}

function brochureCard(item) {
  const card = element('article', '', 'deal');
  const media = link('', item.sourceUrl);
  media.className = 'deal-media';
  media.setAttribute('aria-label', 'View brochure for ' + item.product);
  const imageUrl = secureUrl(item.imageUrl);
  if (imageUrl) {
    const image = element('img');
    image.alt = item.product;
    image.loading = 'lazy';
    image.decoding = 'async';
    image.referrerPolicy = 'no-referrer';
    image.addEventListener('error', () => media.replaceChildren(element('small', 'Photo unavailable')));
    image.src = imageUrl;
    media.append(image);
  } else {
    media.append(element('small', 'Photo unavailable'));
  }
  const body = element('div', '', 'deal-body');
  body.append(element('p', item.retailer, 'retailer-name'), element('h3', item.product));
  if (item.detail) body.append(element('small', item.detail));
  body.append(element('p', item.price === null ? item.priceLabel || 'See brochure' : money(item.price), 'amount'));
  const pack = item.package;
  if (pack?.total) {
    const amount = new Intl.NumberFormat('en', { maximumFractionDigits: 2 }).format(pack.total);
    const quantity = [pack.count ? pack.count + ' pieces' : '', pack.unit !== 'piece' ? amount + ' ' + pack.unit + ' total' : ''].filter(Boolean).join(' · ');
    const unitPrice = pack.unitPrice == null ? '' : money(pack.unitPrice) + '/' + pack.unit;
    body.append(element('p', [quantity, unitPrice].filter(Boolean).join(' · '), 'pack-details'));
  }
  const dates = element('small');
  dates.append(element('span', 'Starts ' + brochureDate(item.start)), document.createElement('br'),
    element('span', 'Ends ' + brochureDate(item.end)));
  body.append(dates);
  const links = element('div', '', 'deal-links');
  const place = [item.retailer, area.value, 'Jeddah'].filter(Boolean).join(' ');
  links.append(link('Brochure', item.sourceUrl), link('Find a store', 'https://www.google.com/maps/search/?api=1&query=' + encodeURIComponent(place)));
  body.append(links);
  const details = element('details', '', 'deal-details');
  details.append(element('summary', 'Offer details'),
    element('p', (item.brochure ? item.brochure + ' · ' : '') + (item.scope || 'See brochure for coverage')),
    element('p', 'Check availability with the branch.'));
  body.append(details);
  card.append(media, body);
  return card;
}

function renderDealPage() {
  const visible = dealItems.filter(item => !retailerFilter || item.retailer === retailerFilter);
  if (dealOrder.value === 'price') visible.sort((a, b) => (a.price ?? Infinity) - (b.price ?? Infinity));
  if (dealOrder.value === 'expiry') visible.sort((a, b) => a.end.localeCompare(b.end));
  if (dealOrder.value === 'name') visible.sort((a, b) => a.product.localeCompare(b.product));
  brochureResults.replaceChildren(...visible.slice(0, visibleCount).map(brochureCard));
  showMore.hidden = visible.length <= visibleCount;
  showMore.textContent = 'Show more (' + Math.max(0, visible.length - visibleCount) + ')';
}

function renderRetailerFilters(coverage) {
  const counts = new Map();
  for (const item of dealItems) counts.set(item.retailer, (counts.get(item.retailer) || 0) + 1);
  filterBar.replaceChildren();
  if (!dealItems.length) return;
  for (const name of ['', ...coverage.map(store => store.store)]) {
    const count = name ? counts.get(name) || 0 : dealItems.length;
    const button = element('button', (name || 'All retailers') + ' ' + count, 'chip');
    button.type = 'button';
    button.disabled = count === 0;
    button.setAttribute('aria-pressed', String(retailerFilter === name));
    button.addEventListener('click', () => {
      retailerFilter = name;
      visibleCount = 20;
      for (const other of filterBar.children) other.setAttribute('aria-pressed', String(other === button));
      renderDealPage();
    });
    filterBar.append(button);
  }
}

dealOrder.addEventListener('change', () => { visibleCount = 20; renderDealPage(); });
showMore.addEventListener('click', () => {
  const firstNew = visibleCount;
  visibleCount += 20;
  renderDealPage();
  brochureResults.children[firstNew]?.querySelector('a')?.focus();
});
area.addEventListener('change', () => { if (!brochureSection.hidden) renderDealPage(); });

byId('phone').addEventListener('click', async () => {
  const status = byId('phone-status'), image = byId('phone-qr'), anchor = byId('phone-link');
  image.hidden = anchor.hidden = true;
  status.textContent = 'Preparing phone link…';
  phoneDialog.showModal();
  try {
    const response = await fetch('/api/phone');
    if (!response.ok) throw new Error();
    const data = await response.json();
    if (!data.url) {
      status.textContent = 'Start SmartCart with --lan or configure a public HTTPS URL to enable the phone QR code.';
      return;
    }
    anchor.href = data.url;
    anchor.textContent = data.url;
    image.src = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(data.qr);
    image.hidden = anchor.hidden = false;
    status.textContent = data.secure
      ? 'Scan with the Camera app on your iPhone or Android.'
      : 'Scan on the same Wi-Fi, or type the full http:// link below. Keep SmartCart running on this PC.';
  } catch { status.textContent = 'Could not load the phone link.'; }
});

for (const button of byId('quick-search').querySelectorAll('button')) {
  button.addEventListener('click', () => {
    demo.checked = false;
    query.value = button.dataset.query;
    byId('search').requestSubmit();
  });
}
async function showBrochureDeals(term) {
  activeSearch?.abort();
  const request = new AbortController();
  activeSearch = request;
  brochureSection.hidden = false;
  byId('brochure-heading').textContent = 'Deals for “' + term + '”';
  catalogComparison.hidden = !searchProducts(catalog.products, term).length;
  brochureStatus.textContent = 'Checking active brochures from five retailers…';
  const related = byId('search-choices');
  related.replaceChildren(...groceryChoices(term).map(choice => {
    const button = element('button', choice, 'chip');
    button.type = 'button';
    button.addEventListener('click', () => {
      query.value = choice;
      byId('search').requestSubmit();
    });
    return button;
  }));
  dealItems = [];
  retailerFilter = '';
  visibleCount = 20;
  brochureResults.replaceChildren();
  filterBar.replaceChildren();
  showMore.hidden = byId('deal-order-label').hidden = true;
  try {
    const response = await fetch('/api/deals?' + new URLSearchParams({ q: term }), { signal: request.signal });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error);
    if (request.signal.aborted) return;
    const partial = data.coverage.filter(store => store.unavailable || !store.complete);
    const checked = data.coverage.length - partial.length;
    const total = data.coverage.reduce((sum, store) => sum + (store.brochures?.length ?? 0), 0);
    const message = data.items.length ? data.items.length + ' active matches' : 'No active matches found';
    brochureStatus.textContent = checked === 0 && data.items.length === 0
      ? 'Brochure search could not be completed. Try again shortly.'
      : message + ' · ' + total + ' active brochures found · ' + brochureDate(data.asOf) +
        '. Check the brochure for offer terms and branch availability.';
    if (partial.length) brochureStatus.textContent += ' Incomplete coverage: ' + partial.map(store => store.store).join(', ') + '.';
    dealItems = data.items;
    byId('brochure-heading').textContent = 'Deals for “' + term + '”';
    byId('deal-order-label').hidden = !dealItems.length;
    renderRetailerFilters(data.coverage);
    renderDealPage();
  } catch (error) {
    if (!request.signal.aborted) brochureStatus.textContent = 'Could not search the brochures. Try again shortly.';
  }
}

byId('search').addEventListener('submit', event => {
  event.preventDefault();
  if (demo.checked) {
    cancelBrochureSearch();
    runSearch(query.value);
  } else if (query.value.trim()) {
    const term = query.value.trim();
    runSearch(term);
    showBrochureDeals(term);
  }
});
demo.addEventListener('change', () => {
  cancelBrochureSearch();
  product = null;
  candidates.hidden = true;
  photoStatus.textContent = '';
  if (demo.checked) {
    setProduct(demoCatalog.products[0]);
  } else {
    query.value = '';
    render();
  }
});
for (const control of [sort, radius]) control.addEventListener('change', () => render());
area.addEventListener('change', () => {
  location = null;
  byId('radius-label').hidden = true;
  byId('geo-status').textContent = '';
  render();
});
byId('location').addEventListener('click', () => {
  const status = byId('geo-status');
  if (!navigator.geolocation) {
    status.textContent = 'Location unavailable. Choose a neighbourhood above.';
    return;
  }
  status.textContent = 'Finding your location…';
  byId('location').disabled = true;
  navigator.geolocation.getCurrentPosition(
    ({ coords }) => {
      location = { lat: coords.latitude, lon: coords.longitude };
      area.value = '';
      byId('radius-label').hidden = false;
      byId('location').disabled = false;
      status.textContent = 'Radius applies to verified branch coordinates. Citywide offers may still appear.';
      render();
    },
    () => {
      byId('location').disabled = false;
      status.textContent = 'Location unavailable. Choose a neighbourhood above.';
    }, { timeout: 10000 },
  );
});

for (const [button, capture] of [[camera, true], [upload, false]]) {
  button.addEventListener('click', () => {
    if (capture) photo.setAttribute('capture', 'environment');
    else photo.removeAttribute('capture');
    photo.click();
  });
}

const photoDialog = byId('photo-dialog');
const photoPreview = byId('photo-preview');
const identifyStatus = byId('identify-status');
const photoName = byId('photo-name');
const photoSuggestions = byId('photo-suggestions');
const googlePhoto = byId('google-photo');
let scanFile;
let previewUrl;
let scanVersion = 0;
let photoNames = [];
let customerEdited = false;

function finishPhoto() {
  scanVersion += 1;
  if (previewUrl) URL.revokeObjectURL(previewUrl);
  previewUrl = scanFile = undefined;
  photoPreview.removeAttribute('src');
  scanInProgress = camera.disabled = upload.disabled = false;
  demo.disabled = false;
}

photoDialog.addEventListener('close', finishPhoto);
byId('photo-close').addEventListener('click', () => photoDialog.close());
photoName.addEventListener('input', () => { customerEdited = true; });
byId('photo-clear').addEventListener('click', () => {
  customerEdited = true;
  photoName.value = '';
  identifyStatus.textContent = 'Choose a different suggestion or type the product name.';
  photoName.focus();
});

function addPhotoNames(names) {
  const known = new Set();
  photoNames = [...photoNames, ...names].map(normalizePhotoName).filter(name => {
    const key = name.toLowerCase();
    if (!name || !/\p{L}/u.test(name) || known.has(key)) return false;
    known.add(key);
    return true;
  }).slice(0, 7);
  if (!customerEdited && !photoName.value && photoNames.length) photoName.value = photoNames[0];
  photoSuggestions.replaceChildren(...photoNames.map(name => {
    const button = element('button', name, 'chip');
    button.type = 'button';
    button.addEventListener('click', () => {
      customerEdited = true;
      photoName.value = name;
      photoName.focus();
    });
    return button;
  }));
}

byId('confirm-photo').addEventListener('submit', event => {
  event.preventDefault();
  const term = normalizePhotoName(photoName.value);
  if (!term) {
    identifyStatus.textContent = 'Enter the product name first.';
    return;
  }
  photoDialog.close();
  query.value = term;
  byId('search').requestSubmit();
  if (!demo.checked) byId('brochure-heading').scrollIntoView({ block: 'start' });
});

googlePhoto.addEventListener('click', async () => {
  const file = scanFile, version = scanVersion;
  if (!file) return;
  googlePhoto.disabled = true;
  identifyStatus.textContent = 'Checking the photo with Google Vision…';
  try {
    const image = await resizedPhoto(file);
    if (version !== scanVersion) return;
    const response = await fetch('/api/photo-identify', { method: 'POST',
      headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ image }) });
    const result = await response.json();
    if (version !== scanVersion) return;
    if (!response.ok) throw new Error();
    addPhotoNames([...(result.guesses ?? []), ...labelSuggestions(result.text), ...(result.entities ?? [])]);
    identifyStatus.textContent = photoNames.length
      ? 'Check the suggestions or edit the name before searching.' : 'No confident match. Type the product name.';
  } catch {
    if (version === scanVersion) identifyStatus.textContent = 'Google Vision could not identify the photo. You can still type the name.';
  } finally {
    if (version === scanVersion) googlePhoto.disabled = false;
  }
});

async function barcodeNames(barcode) {
  const exact = searchProducts(currentCatalog().products, barcode);
  if (exact.length) return exact.map(item => [item.brand, item.name, item.variant].filter(Boolean).join(' '));
  const response = await fetch('/api/barcode?' + new URLSearchParams({ code: barcode }), { signal: AbortSignal.timeout(6500) });
  if (!response.ok) return [];
  const { name, brand } = await response.json();
  if (!name) return [];
  return brand && !name.toLowerCase().includes(brand.toLowerCase()) ? [brand + ' ' + name, name] : [name];
}

photo.addEventListener('change', async () => {
  const file = photo.files[0];
  photo.value = '';
  if (!file || scanInProgress) return;
  if ((file.type && !file.type.startsWith('image/')) || file.size > 15 * 1024 * 1024) {
    photoStatus.textContent = 'Choose an image smaller than 15 MB.';
    return;
  }
  photoStatus.textContent = '';
  const version = ++scanVersion;
  scanFile = file;
  scanInProgress = camera.disabled = upload.disabled = demo.disabled = true;
  previewUrl = URL.createObjectURL(file);
  photoPreview.src = previewUrl;
  photoName.value = '';
  photoNames = [];
  customerEdited = false;
  photoSuggestions.replaceChildren();
  googlePhoto.hidden = true;
  googlePhoto.disabled = false;
  identifyStatus.textContent = 'Reading the product barcode and label. You can also type its name.';
  photoDialog.showModal();
  fetch('/api/photo-options').then(response => response.json()).then(options => {
    if (version === scanVersion) googlePhoto.hidden = !options.googleVision;
  }).catch(() => {});
  try {
    const barcode = await getBarcode(file).catch(() => null);
    if (version !== scanVersion) return;
    const names = barcode ? await barcodeNames(barcode).catch(() => []) : [];
    if (version !== scanVersion) return;
    if (names.length) {
      addPhotoNames(names);
      identifyStatus.textContent = 'Barcode match found. Is this your product?';
      return;
    }
    identifyStatus.textContent = 'Checking the label and product photo…';
    const text = await guessFromText(file).catch(() => '');
    if (version !== scanVersion) return;
    const suggestions = labelSuggestions(text);
    if (suggestions.length) addPhotoNames(suggestions);
    else {
      const guesses = await guessFromImage(file).catch(() => []);
      if (version !== scanVersion) return;
      addPhotoNames(guesses);
    }
    if (version !== scanVersion) return;
    identifyStatus.textContent = photoNames.length
      ? 'Is this your product? Confirm the name or correct it before searching.'
      : 'No confident match. Type the name or try a clearer photo of the product.';
  } catch {
    if (version === scanVersion) identifyStatus.textContent = 'Could not read the photo. Type the product name to continue.';
  }
});

render();
try {
  const response = await fetch('/catalog.json');
  if (!response.ok) throw new Error('Catalog unavailable');
  const data = await response.json();
  if (!Array.isArray(data.products) || !Array.isArray(data.offers)) throw new Error('Invalid catalog');
  Object.assign(catalog, data);
  const selectableAreas = new Set([...area.options].map(option => option.value));
  for (const entry of data.locations ?? []) {
    if (!selectableAreas.has(entry.area)) {
      area.append(new Option(entry.area, entry.area));
      selectableAreas.add(entry.area);
    }
  }
  catalogStatus = catalog.products.length ? '' : 'Search active Jeddah brochures by product keyword, or turn on demo prices.';
} catch {
  catalogStatus = 'Verified catalog is unavailable. Browse store promotions or try demo prices.';
}
if (!demo.checked && query.value.trim()) runSearch(query.value);
else render();

const byId = id => document.getElementById(id);
const status = byId('status');
const access = byId('access');
const productForm = byId('product-form');
const locationForm = byId('location-form');
const offerForm = byId('offer-form');
const lookup = byId('lookup');
const money = new Intl.NumberFormat('en-SA', { style: 'currency', currency: 'SAR' });
const day = new Intl.DateTimeFormat('en-GB', { dateStyle: 'medium', timeZone: 'Asia/Riyadh' });
let key = '';
let state;
let busy = false;

function node(tag, text, className) {
  const item = document.createElement(tag);
  item.textContent = text;
  if (className) item.className = className;
  return item;
}

async function request(path, data) {
  const headers = { Authorization: 'Bearer ' + key };
  if (data) headers['Content-Type'] = 'application/json';
  const response = await fetch('/api/portal' + path, { method: data ? 'POST' : 'GET', headers,
    body: data ? JSON.stringify(data) : undefined });
  const result = await response.json();
  if (!response.ok) throw new Error(result.error);
  return result;
}

function choices(select, items, label, getLabel = entry => entry.name) {
  const selected = select.value;
  const entries = items.map(entry => new Option(getLabel(entry), entry.id));
  if (label) entries.unshift(new Option(label, ''));
  select.replaceChildren(...entries);
  if ([...select.options].some(option => option.value === selected)) select.value = selected;
}

function branchChoices() {
  choices(offerForm.elements.locationId, state.locations.filter(item =>
    item.storeId === offerForm.elements.storeId.value), 'Citywide Jeddah');
}

function setFields(form, item) {
  for (const control of form.elements) {
    if (control.name) control.value = item?.[control.name] ?? '';
  }
}

function render() {
  byId('dashboard').hidden = false;
  byId('manage').hidden = state.role !== 'admin';
  choices(byId('edit-product'), state.products, 'New product');
  choices(byId('edit-location'), state.locations, 'New branch');
  choices(locationForm.elements.storeId, state.stores);
  choices(offerForm.elements.productId, state.products, 'Select catalog product',
    item => [item.brand, item.name, item.size].filter(Boolean).join(' · '));
  choices(offerForm.elements.storeId, state.stores.filter(store => !state.storeId || state.storeId === store.id));
  branchChoices();
  byId('record-count').textContent = state.offers.length + (state.offers.length === 100 ? ' latest matching records' : ' matching records');
  byId('records').replaceChildren(...state.offers.map(record => {
    const row = node('article', '', 'store');
    const info = node('div', '');
    info.append(node('h3', record.productName), node('small', (state.stores.find(store => store.id === record.storeId)?.name ?? record.storeId) + ' · ' + record.status));
    const details = node('div', '');
    const href = node('a', 'View source');
    href.href = record.sourceUrl;
    href.target = '_blank';
    href.rel = 'noopener noreferrer';
    details.append(node('p', record.branch?.name ?? record.scope ?? 'Jeddah'), node('small',
      day.format(new Date(record.startsAt)) + ' to ' + day.format(new Date(Date.parse(record.expiresAt) - 1))), href);
    if (record.conditions) details.append(node('small', record.conditions));
    const price = node('div', record.price === null ? 'See source' : money.format(record.price));
    if (state.role === 'admin' && record.status === 'pending') {
      const verify = node('button', 'Verify price');
      verify.type = 'button';
      verify.addEventListener('click', () => perform(async () => {
        await request('/verify', { id: record.id });
        await refresh();
        return 'Price verified.';
      }));
      price.append(document.createElement('br'), verify);
    }
    row.append(info, details, price);
    return row;
  }));
}

async function refresh() {
  state = await request('?' + new URLSearchParams({ q: lookup.elements.query.value }));
  render();
}

async function perform(action) {
  if (busy) return;
  busy = true;
  status.textContent = 'Working…';
  try { status.textContent = await action() || ''; }
  catch (error) { status.textContent = error.message; }
  finally { busy = false; }
}

access.addEventListener('submit', event => {
  event.preventDefault();
  if (location.protocol !== 'https:' && !['127.0.0.1', 'localhost', '[::1]'].includes(location.hostname)) {
    status.textContent = 'Open the portal on the PC or use a trusted HTTPS address.';
    return;
  }
  perform(async () => {
    key = access.elements.key.value.trim();
    access.reset();
    byId('dashboard').hidden = true;
    await refresh();
    return state.role === 'admin' ? 'Signed in as admin.' : 'Signed in as retailer.';
  });
});

byId('edit-product').addEventListener('change', event =>
  setFields(productForm, state.products.find(item => item.id === event.target.value)));
byId('edit-location').addEventListener('change', event => {
  setFields(locationForm, state.locations.find(item => item.id === event.target.value));
  if (!event.target.value) locationForm.elements.storeId.selectedIndex = 0;
});
offerForm.elements.storeId.addEventListener('change', branchChoices);
lookup.addEventListener('submit', event => { event.preventDefault(); perform(refresh); });

for (const [form, route, editor] of [
  [productForm, '/products', 'edit-product'], [locationForm, '/locations', 'edit-location'], [offerForm, '/offers', null],
]) {
  form.addEventListener('submit', event => {
    event.preventDefault();
    perform(async () => {
      const data = Object.fromEntries(new FormData(form));
      if (editor) {
        data.id = byId(editor).value;
        if (form === productForm) data.aliases = state.products.find(item => item.id === data.id)?.aliases ?? [];
      } else {
        data.startsAt = data.start + 'T00:00:00+03:00';
        const expiry = new Date(Date.parse(data.end + 'T00:00:00+03:00') + 86400000);
        data.expiresAt = expiry.toISOString();
      }
      await request(route, data);
      if (editor) form.reset();
      await refresh();
      return editor ? 'Record saved.' : 'Price submitted for admin verification.';
    });
  });
}

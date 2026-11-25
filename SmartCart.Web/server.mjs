import { spawn } from 'node:child_process';
import { createServer as createHttpServer } from 'node:http';
import { createServer as createHttpsServer } from 'node:https';
import { randomBytes, createHash, timingSafeEqual } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { readFileSync, writeFileSync } from 'node:fs';
import { networkInterfaces } from 'node:os';
import { resolve } from 'node:path';
import QRCode from 'qrcode';
import { barcodeProduct, identifyWithVision, visionEnabled } from './photo-provider.mjs';
import { searchActiveDeals } from './brochures.mjs';
import { stores, secureUrl } from './comparison.mjs';
import { dataDir, indexBrochures, readCatalog, readPortal, saveLocation, saveProduct, submitOffer, verifyOffer } from './database.mjs';
import { openSmartCartOnAndroid } from './open-android.mjs';

const preferredPort = Number(process.env.PORT || 4173);
if (!Number.isInteger(preferredPort) || preferredPort < 1 || preferredPort > 65535) {
  console.error('Set PORT to a number between 1 and 65535.');
  process.exit(1);
}
const openBrowser = process.argv.includes('--open-browser');
const openAndroid = process.argv.includes('--open-android');
let port = preferredPort;
const lan = !openAndroid && (process.argv.includes('--lan') || process.env.SMARTCART_LAN === '1');
const tls = !openAndroid && process.env.SMARTCART_TLS_CERT && process.env.SMARTCART_TLS_KEY ? {
  cert: readFileSync(process.env.SMARTCART_TLS_CERT), key: readFileSync(process.env.SMARTCART_TLS_KEY),
} : null;
const scheme = tls ? 'https' : 'http';
const publicUrl = process.env.SMARTCART_PUBLIC_URL ? secureUrl(process.env.SMARTCART_PUBLIC_URL) : null;
if (process.env.SMARTCART_PUBLIC_URL && !publicUrl) throw new Error('SMARTCART_PUBLIC_URL must be a valid HTTPS URL.');
const addresses = Object.values(networkInterfaces()).flat().filter(item =>
  item.family === 'IPv4' && !item.internal && !item.address.startsWith('169.254.'));
const localAddress = process.env.SMARTCART_LAN_IP || addresses.find(item =>
  /^(192\.168\.|10\.|172\.(1[6-9]|2\d|3[01])\.)/.test(item.address))?.address || addresses[0]?.address;
const getPhoneUrl = () => publicUrl || (lan && localAddress ? scheme + '://' + localAddress + ':' + port + '/' : null);

const keyPath = resolve(dataDir, 'admin.key');
if (!process.env.SMARTCART_ADMIN_KEY) {
  try { writeFileSync(keyPath, randomBytes(32).toString('hex'), { flag: 'wx', mode: 0o600 }); }
  catch (error) { if (error.code !== 'EEXIST') throw error; }
}
const adminKey = process.env.SMARTCART_ADMIN_KEY || readFileSync(keyPath, 'utf8').trim();
const shopKeys = JSON.parse(process.env.SMARTCART_SHOP_KEYS || '{}');
function sameKey(a, b) {
  if (!a || typeof b !== 'string' || b.length < 24) return false;
  return timingSafeEqual(createHash('sha256').update(a).digest(), createHash('sha256').update(b).digest());
}
function identify(request) {
  const token = request.headers.authorization?.match(/^Bearer (\S+)$/)?.[1];
  if (sameKey(token, adminKey)) return { role: 'admin' };
  const store = stores.find(item => sameKey(token, shopKeys[item.id]));
  return store ? { role: 'shop', storeId: store.id } : null;
}

const routes = new Map([
  ['/', ['index.html', 'text/html']], ['/style.css', ['style.css', 'text/css']], ['/hero-groceries.jpg', ['hero-groceries.jpg', 'image/jpeg']],
  ['/app.mjs', ['app.mjs', 'text/javascript']], ['/comparison.mjs', ['comparison.mjs', 'text/javascript']],
  ['/photo-lookup.mjs', ['photo-lookup.mjs', 'text/javascript']], ['/grocery-ranking.mjs', ['grocery-ranking.mjs', 'text/javascript']],
  ['/portal', ['portal.html', 'text/html']], ['/portal.mjs', ['portal.mjs', 'text/javascript']],
]);
function json(response, status, data) {
  response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' }).end(JSON.stringify(data));
}
async function requestBody(request, maxBytes = 16384) {
  let size = 0;
  const chunks = [];
  for await (const chunk of request) {
    size += chunk.length;
    if (size > maxBytes) throw new Error('Request is too large.');
    chunks.push(chunk);
  }
  const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw new Error('Expected a JSON object.');
  return body;
}

async function portal(request, response, url) {
  const local = ['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(request.socket.remoteAddress);
  if (!local && !request.socket.encrypted) return json(response, 403, { error: 'Use the PC or a trusted HTTPS connection for portal access.' });
  const actor = identify(request);
  if (!actor) return json(response, 401, { error: 'Enter a valid admin or retailer access key.' });
  if (request.method === 'GET' && url.pathname === '/api/portal') {
    return json(response, 200, readPortal(actor, url.searchParams.get('q')));
  }
  const action = url.pathname.split('/').at(-1);
  if (request.method !== 'POST' || !['products', 'locations', 'offers', 'verify'].includes(action)) {
    return json(response, 404, { error: 'Unknown portal action.' });
  }
  if (actor.role !== 'admin' && action !== 'offers') return json(response, 403, { error: 'Admin access is required.' });
  try {
    const data = await requestBody(request);
    if (action === 'products') return json(response, 200, saveProduct(data));
    if (action === 'locations') return json(response, 200, saveLocation(data));
    if (action === 'offers') return json(response, 201, submitOffer(data, actor));
    verifyOffer(data.id);
    return json(response, 200, { verified: true });
  } catch (error) {
    return json(response, 400, { error: error instanceof SyntaxError ? 'Invalid JSON.' : error.message });
  }
}

async function handle(request, response) {
  const url = new URL(request.url, 'http://localhost');
  response.setHeader('Cache-Control', 'no-store');
  response.setHeader('X-Content-Type-Options', 'nosniff');
  response.setHeader('Referrer-Policy', 'no-referrer');
  if (url.pathname === '/api/portal' || url.pathname.startsWith('/api/portal/')) return portal(request, response, url);
  if (url.pathname === '/api/phone' && request.method === 'GET') {
    const phoneUrl = getPhoneUrl();
    const qr = phoneUrl ? await QRCode.toString(phoneUrl, { type: 'svg', margin: 3, errorCorrectionLevel: 'M' }) : null;
    return json(response, 200, { url: phoneUrl, qr, secure: phoneUrl?.startsWith('https:') ?? false });
  }
  if (url.pathname === '/catalog.json' && request.method === 'GET') return json(response, 200, readCatalog());
  if (url.pathname === '/api/photo-options' && request.method === 'GET') {
    return json(response, 200, { googleVision: visionEnabled });
  }
  if (url.pathname === '/api/barcode' && request.method === 'GET') {
    const code = url.searchParams.get('code') || '';
    if (!/^\d{8,14}$/.test(code)) return json(response, 400, { error: 'Enter a valid barcode.' });
    return json(response, 200, await barcodeProduct(code));
  }
  if (url.pathname === '/api/photo-identify' && request.method === 'POST') {
    if (!visionEnabled) return json(response, 503, { error: 'Google Vision is not configured.' });
    const body = await requestBody(request, 1500000).catch(() => null);
    if (typeof body?.image !== 'string' || !/^\/9j\/[A-Za-z0-9+/]+=*$/.test(body.image)) {
      return json(response, 400, { error: 'Choose a valid JPEG photo.' });
    }
    const result = await identifyWithVision(body.image);
    return result.limited ? json(response, 429, { error: 'Photo lookup is busy. Please try again shortly.' }) : json(response, 200, result);
  }
  if (url.pathname === '/api/deals' && request.method === 'GET') {
    const term = url.searchParams.get('q')?.trim().replace(/\s+/g, ' ');
    if (!term || term.length > 100 || !/[\p{L}\p{N}]/u.test(term)) {
      return json(response, 400, { error: 'Enter a product keyword of 1–100 characters.' });
    }
    const result = await searchActiveDeals(term);
    indexBrochures(result.items);
    return json(response, 200, result);
  }
  const route = routes.get(url.pathname);
  if (!route || !['GET', 'HEAD'].includes(request.method)) {
    response.writeHead(route ? 405 : 404).end();
    return;
  }
  const body = await readFile(new URL(route[0], import.meta.url));
  response.writeHead(200, { 'Content-Type': route[1].startsWith('image/') ? route[1] : route[1] + '; charset=utf-8' })
    .end(request.method === 'HEAD' ? undefined : body);
}

const listener = (request, response) => handle(request, response).catch(error => {
  console.error('SmartCart request failed:', error.message);
  if (!response.headersSent) json(response, 502, { error: 'SmartCart could not complete this request.' });
  else response.end();
});
const server = tls ? createHttpsServer(tls, listener) : createHttpServer(listener);
const host = lan ? '0.0.0.0' : '127.0.0.1';
server.on('error', error => {
  if (error.code === 'EADDRINUSE' && (openBrowser || openAndroid) && !process.env.PORT && port < preferredPort + 10 && port < 65535) {
    console.log('Port ' + port + ' is in use. Trying ' + (port + 1) + '.');
    server.listen(++port, host);
    return;
  }
  if (error.code === 'EADDRINUSE') {
    console.error('SmartCart could not start because port ' + port + ' is in use. Stop the other server or set PORT to a free port.');
  } else {
    console.error('SmartCart could not start: ' + error.message);
  }
  process.exitCode = 1;
});
server.once('listening', () => {
  const phoneUrl = getPhoneUrl();
  const url = scheme + '://127.0.0.1:' + port;
  console.log('SmartCart is running at ' + url);
  if (phoneUrl) console.log('Phone URL: ' + phoneUrl);
  if (openAndroid) {
    openSmartCartOnAndroid(port).catch(error => {
      console.error('Could not open SmartCart on Android: ' + error.message);
      process.exitCode = 1;
      server.close();
    });
  } else if (process.platform === 'win32' && openBrowser) {
    const browser = spawn('rundll32.exe', ['url.dll,FileProtocolHandler', url], { stdio: 'ignore', windowsHide: true });
    browser.on('error', () => console.error('Open SmartCart at ' + url));
    browser.unref();
  }
});
server.listen(port, host);

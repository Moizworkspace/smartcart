const visionKey = process.env.SMARTCART_VISION_KEY;
export const visionEnabled = Boolean(visionKey);
const barcodeCache = new Map();
let visionRequests = [];

export async function barcodeProduct(code) {
  if (barcodeCache.has(code)) return barcodeCache.get(code);
  const url = new URL('/api/v2/product/' + code + '.json', 'https://world.openfoodfacts.org');
  url.searchParams.set('fields', 'product_name,product_name_en,product_name_ar,brands');
  const response = await fetch(url, { signal: AbortSignal.timeout(5000),
    headers: { 'User-Agent': 'SmartCart-Jeddah/1.0 (local academic product lookup)' } });
  if (!response.ok && response.status !== 404) throw new Error('Barcode service unavailable.');
  const { product } = response.ok ? await response.json() : {};
  const name = product?.product_name_en || product?.product_name || product?.product_name_ar;
  const value = { name: typeof name === 'string' ? name.slice(0, 140) : '',
    brand: typeof product?.brands === 'string' ? product.brands.split(',')[0].slice(0, 50) : '' };
  if (barcodeCache.size >= 200) barcodeCache.delete(barcodeCache.keys().next().value);
  barcodeCache.set(code, value);
  return value;
}

export async function identifyWithVision(image) {
  const now = Date.now();
  visionRequests = visionRequests.filter(time => time > now - 60000);
  if (visionRequests.length >= 8) return { limited: true };
  visionRequests.push(now);
  const response = await fetch('https://vision.googleapis.com/v1/images:annotate', {
    method: 'POST',
    signal: AbortSignal.timeout(12000),
    headers: { 'Content-Type': 'application/json', 'X-Goog-Api-Key': visionKey },
    body: JSON.stringify({ requests: [{ image: { content: image },
      features: [{ type: 'WEB_DETECTION', maxResults: 6 }, { type: 'TEXT_DETECTION' }] }] }),
  });
  if (!response.ok) throw new Error('Google Vision request failed.');
  const result = (await response.json()).responses?.[0];
  if (!result || result.error) throw new Error('Google Vision could not process this image.');
  return { guesses: (result.webDetection?.bestGuessLabels ?? []).map(entry => entry.label).slice(0, 4),
    entities: (result.webDetection?.webEntities ?? []).map(entry => entry.description).filter(Boolean).slice(0, 5),
    text: result.fullTextAnnotation?.text?.slice(0, 2000) ?? '' };
}

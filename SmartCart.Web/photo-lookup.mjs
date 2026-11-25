const foodNames = [
  [/\b(?:granny smith|apples?|pink lady|royal gala)\b/i, 'Apple'],
  [/\btomatoes?\b|طماطم|بندورة/i, 'Fresh tomatoes'],
  [/\b(?:ramen|noodles?|indomie)\b|نودلز|اندومي/i, 'Noodles'],
  [/\b(?:basmati|rice)\b|أرز|رز/i, 'Rice'],
  [/\bmilk\b|حليب/i, 'Milk'],
  [/\b(?:pasta|spaghetti|macaroni)\b|مكرونة|معكرونة/i, 'Pasta'],
  [/\bbananas?\b|موز/i, 'Banana'],
  [/\boranges?\b|برتقال/i, 'Orange'],
  [/\bcucumbers?\b|خيار/i, 'Cucumber'],
  [/\b(?:zucchini|courgette)\b|كوسة/i, 'Zucchini'],
  [/\bcarrots?\b|جزر/i, 'Carrot'],
  [/\bpotatoes?\b|بطاط[اس]/i, 'Potato'],
  [/\bonions?\b|بصل/i, 'Onion'],
  [/\bbroccoli\b|بروكلي/i, 'Broccoli'],
  [/\b(?:head )?cabbage\b|ملفوف/i, 'Cabbage'],
  [/\bbell peppers?\b|فلفل رومي/i, 'Bell pepper'],
  [/\beggs?\b|بيض/i, 'Eggs'],
  [/\bchicken\b|دجاج/i, 'Chicken'],
  [/\byog(?:h)?urt\b|زبادي/i, 'Yogurt'],
  [/\bcheese\b|جبن/i, 'Cheese'],
  [/\bcoffee\b|قهوة/i, 'Coffee'],
  [/\btea\b|شاي/i, 'Tea'],
];

const processed = /\b(?:dairy milk|milk chocolate|charcoal|tomato paste|apple juice|apple vinegar|tomato sauce|apple cider|rice crackers|milk powder|condensed milk)\b|معجون الطماطم|عصير التفاح/i;
const labelNoise = /nutrition|ingredients|serving|manufacturer|distributed|calories|barcode|energy|storage|best before|المكونات|القيمة الغذائية/i;
let modelPromise;
const scripts = new Map();

function loadScript(url) {
  if (scripts.has(url)) return scripts.get(url);
  const download = new Promise((resolve, reject) => {
    const script = document.createElement('script');
    const timer = setTimeout(() => { script.remove(); reject(new Error('Scanner download timed out')); }, 12000);
    script.src = url;
    script.onload = () => { clearTimeout(timer); resolve(); };
    script.onerror = () => { clearTimeout(timer); script.remove(); reject(new Error('Scanner download failed')); };
    document.head.append(script);
  }).catch(error => { scripts.delete(url); throw error; });
  scripts.set(url, download);
  return download;
}

export async function getBarcode(file) {
  if ('BarcodeDetector' in window && 'createImageBitmap' in window) {
    try {
      const bitmap = await createImageBitmap(file);
      try {
        const found = await new BarcodeDetector().detect(bitmap);
        const match = found.find(entry => /^\d{8,14}$/.test(entry.rawValue));
        if (match) return match.rawValue;
      } finally { bitmap.close(); }
    } catch {}
  }
  if (!window.ZXingBrowser) await loadScript('https://cdn.jsdelivr.net/npm/@zxing/browser@0.1.5/umd/zxing-browser.min.js');
  const url = URL.createObjectURL(file);
  try {
    const code = (await new window.ZXingBrowser.BrowserMultiFormatReader().decodeFromImageUrl(url)).getText();
    return /^\d{8,14}$/.test(code) ? code : null;
  } catch { return null; }
  finally { URL.revokeObjectURL(url); }
}

export function normalizePhotoName(text) {
  return String(text || '').replace(/[^\p{L}\p{N}\p{M} &.'+×-]/gu, ' ')
    .replace(/\s+/g, ' ').trim().slice(0, 100);
}

function category(text) {
  if (processed.test(text)) return normalizePhotoName(text.match(processed)?.[0]);
  return foodNames.find(([pattern]) => pattern.test(text))?.[1] ?? '';
}

export function labelSuggestions(text) {
  const lines = String(text || '').split(/[\r\n]+/).map(normalizePhotoName)
    .filter(line => line.length >= 3 && /\p{L}/u.test(line) && !labelNoise.test(line));
  const keywords = lines.map(line => ({ line, category: category(line) })).filter(entry => entry.category);
  const results = keywords.flatMap(({ line, category: name }) => line.length <= 60 ? [line, name] : [name]);
  if (!results.length) results.push(...lines.filter(line => line.length <= 45).slice(0, 2));
  return results;
}

export async function guessFromText(file) {
  if (!window.Tesseract) await loadScript('https://cdn.jsdelivr.net/npm/tesseract.js@6.0.1/dist/tesseract.min.js');
  const worker = await window.Tesseract.createWorker(['eng', 'ara']);
  try { return (await worker.recognize(file)).data.text; }
  finally { await worker.terminate(); }
}

async function loadModel() {
  if (!window.tf) await loadScript('https://cdn.jsdelivr.net/npm/@tensorflow/tfjs@4.22.0/dist/tf.min.js');
  if (!window.mobilenet) await loadScript('https://cdn.jsdelivr.net/npm/@tensorflow-models/mobilenet@2.1.1/dist/mobilenet.min.js');
  return window.mobilenet.load({ version: 2, alpha: 0.5 });
}

async function withImage(file, callback) {
  const url = URL.createObjectURL(file);
  try {
    const image = new Image();
    image.src = url;
    await image.decode();
    return await callback(image);
  } finally { URL.revokeObjectURL(url); }
}

export async function guessFromImage(file) {
  modelPromise ??= loadModel().catch(error => { modelPromise = undefined; throw error; });
  const model = await modelPromise;
  const guesses = await withImage(file, image => model.classify(image, 5));
  return guesses.filter(guess => guess.probability >= .14)
    .map(guess => category(guess.className)).filter(Boolean);
}

export async function resizedPhoto(file) {
  return withImage(file, image => {
    const scale = Math.min(1, 960 / Math.max(image.naturalWidth, image.naturalHeight));
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.round(image.naturalWidth * scale));
    canvas.height = Math.max(1, Math.round(image.naturalHeight * scale));
    const ctx = canvas.getContext('2d');
    ctx.drawImage(image, 0, 0, canvas.width, canvas.height);
    return canvas.toDataURL('image/jpeg', .78).split(',')[1];
  });
}

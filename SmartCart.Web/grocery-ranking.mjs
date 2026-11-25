const unitPatterns = {
  ml: ['millilit(?:er|re)s?', 'ml', 'مل'],
  l: ['lit(?:er|re)s?', 'ltrs?', 'lt', 'l', 'لترات?', 'ليتر', 'لتر', 'ل'],
  g: ['grams?', 'gms?', 'gr', 'g', 'جرام', 'غرام', 'جم', 'غ'],
  kg: ['kilograms?', 'kgs?', 'كجم', 'كغ', 'كيلوغرام', 'كيلو'],
  lb: ['pounds?', 'lbs?', 'رطل'],
};
const units = Object.entries(unitPatterns).flatMap(([unit, patterns]) => patterns.map(pattern => [unit, pattern]));
const unit = '(?:' + units.map(([, pattern]) => pattern).join('|') + ')';
const measure = '(\\d+(?:[.,]\\d+)?)\\s*(' + unit + ')(?![\\p{L}\\p{N}])';
const packWords = '(?:pcs?\\.?|pieces?|packs?|ct|counts?|units?|cartons?|bottles?|cans?|bags?|عبوات?|علب(?:ة)?|قطع(?:ة)?|حبات?)';
const digitGroups = ['٠١٢٣٤٥٦٧٨٩', '۰۱۲۳۴۵۶۷۸۹'];

function normalize(text) {
  return String(text || '').toLowerCase().normalize('NFKD').replace(/[\u0300-\u036f]/g, '')
    .replace(/[٠-٩۰-۹]/g, digit => String(digitGroups.find(group => group.includes(digit)).indexOf(digit)))
    .replace(/٫/g, '.').replace(/٬/g, '').replace(/[أإآ]/g, 'ا')
    .replace(/[\u064b-\u065f\u0670]/g, '');
}

function measured(number, rawUnit) {
  const type = units.find(([, pattern]) => new RegExp('^(?:' + pattern + ')$', 'u').test(rawUnit))?.[0];
  const amount = Number(number.replace(',', '.'));
  if (!type || !(amount > 0)) return null;
  const scale = { g: .001, kg: 1, lb: .45359237, ml: .001, l: 1 };
  return { unit: ['ml', 'l'].includes(type) ? 'L' : 'kg', amount: amount * scale[type] };
}

function countOf(value) {
  const count = Number(value);
  return Number.isInteger(count) && count >= 2 && count <= 1000 ? count : null;
}

const nested = new RegExp('(\\d+)\\s*' + packWords + '\\s*(?:of\\s*)?\\(\\s*(\\d+)\\s*[x×*]\\s*' + measure, 'u');
const multiply = new RegExp('(?<![\\p{N}.,])(\\d+)\\s*[x×*]\\s*' + measure, 'gu');
const reverse = new RegExp(measure + '\\s*[x×*]\\s*(\\d+)(?![\\d.,])', 'gu');
const ofMeasure = new RegExp('(\\d+)\\s*[- ]?\\s*' + packWords + '\\s+(?:of|each)\\s+' + measure, 'gu');
const countPattern = new RegExp('(?<![\\p{N}.,])(\\d+)\\s*[- ]?\\s*' + packWords + '(?![\\p{L}\\p{N}])|(?:pack\\s+of|عدد)\\s*(\\d+)(?![\\d.,])', 'gu');
const single = new RegExp('(?<![\\d.,])' + measure, 'gu');
const unique = list => [...new Map(list.map(item => [JSON.stringify(item), item])).values()];

export function parsePackage(product, detail, price) {
  const title = normalize(product);
  const description = normalize(detail);
  const fields = [title, description].filter(Boolean);
  const nestedMatch = description.match(nested) ?? title.match(nested);
  const packs = nestedMatch ? [{
    count: countOf(Number(nestedMatch[1]) * Number(nestedMatch[2])),
    measure: measured(nestedMatch[3], nestedMatch[4]),
  }] : unique(fields.flatMap(field => [
    ...[...field.matchAll(multiply), ...field.matchAll(ofMeasure)]
      .map(match => ({ count: countOf(match[1]), measure: measured(match[2], match[3]) })),
    ...[...field.matchAll(reverse)]
      .map(match => ({ count: countOf(match[3]), measure: measured(match[1], match[2]) })),
  ]).filter(pack => pack.count && pack.measure));
  const counts = unique(fields.flatMap(field => [...field.matchAll(countPattern)]
    .map(match => countOf(match[1] ?? match[2])).filter(Boolean)));
  const measures = unique(fields.filter(field => !/\bper\s+(?:kg|kilo|lb)\b/.test(field))
    .flatMap(field => [...field.matchAll(single)].map(match => measured(match[1], match[2])).filter(Boolean)));
  const pack = packs.length === 1 && packs[0].count && packs[0].measure ? packs[0] : null;
  const count = pack?.count ?? (packs.length === 0 && counts.length === 1 ? counts[0] : null);
  const size = pack?.measure ?? (packs.length === 0 && measures.length === 1 ? measures[0] : null);
  const unit = size?.unit ?? (count ? 'piece' : null);
  const total = size ? size.amount * (count || 1) : count;
  return { count, unit, total, unitPrice: total && Number.isFinite(price) && price > 0 ? price / total : null };
}

function milkSearch(term) {
  const query = normalize(term);
  return /\bmilk\b|حليب/.test(query) &&
    !/\b(?:milk chocolate|dairy milk|cadbury|coconut|condensed|evaporated|powder|formula|breast)\b|شوكولاتة|حليب\s+(?:جوز الهند|مكثف|مبخر|بودرة)/.test(query);
}

const produce = [
  {
    name: /\btomato(?:es)?\b|طماطم|بندورة/,
    alternative: /\b(?:paste|puree|ketchup|sauce|canned|tinned|peeled|chopped|diced|crushed|soup|juice|dried|sundried|sun-dried|sieved|powder|passata|salsa|seasoning|sundrud|cream|pesto|spread|bruschetta|bruchetta|pasta|pickled|frozen|marinated)\b|معجون|صلصة|كاتشب|مقشرة|معلبة|مجففة|عصير/,
    choices: ['Fresh tomatoes', 'Tomato paste', 'Tomato sauce'],
  },
  {
    name: /\bapples?\b|تفاح/,
    alternative: /\b(?:juice|drink|cider|vinegar|sauce|pie|jam|jelly|candy|dried|puree|flavou?red|charcoal|wood|bbq|chips|tea|iphone|watch|ipad|liquid|airpods|earpods|charger|adapter|usb|cable|grill|pet)\b|عصير|خل|فحم|خشب|مجفف|مربى|نكهة/,
    choices: ['Fresh apples', 'Apple juice', 'Apple cider vinegar'],
  },
  {
    name: /\bpotato(?:es)?\b|بطاط[اس]/,
    alternative: /\b(?:chips|crisps|fries|flakes|starch|frozen|snacks?)\b|شيبس|مجمدة|نشا/,
  },
  {
    name: /\bonions?\b|بصل/,
    alternative: /\b(?:rings|powder|flakes|granules|pickled|dried|frozen|crisps|chips)\b|بودرة|مخلل|مجفف|مجمد/,
  },
  {
    name: /\bcarrots?\b|جزر/,
    alternative: /\b(?:juice|cake|pickled|puree|frozen|soup|dried)\b|عصير|كيك|مخلل|مجمد/,
  },
  {
    name: /\bcucumbers?\b|خيار/,
    alternative: /\b(?:pickles?|pickled|juice|scented)\b|مخلل|عصير/,
  },
  {
    name: /\bbananas?\b|موز/,
    alternative: /\b(?:chips|cake|bread|flavou?red|juice|dried|powder|milk|yogurt)\b|شيبس|كيك|عصير|مجفف|حليب|نكهة/,
  },
  {
    name: /\boranges?\b|برتقال/,
    alternative: /\b(?:juice|soda|marmalade|jam|flavou?red|drink|scented|candy)\b|عصير|مشروب|مربى|نكهة/,
  },
];
const noodle = /\b(?:noodles?|ramen|indomie)\b|نودلز|اندومي/;
const pasta = /\b(?:pasta|spaghetti|macaroni|penne|fettuccine|lasagn[ae]|fusilli|linguine|tagliatelle|farfalle)\b|مكرونة|معكرونة|سباغيتي|سباجيتي/;
const nonFood = /\b(?:charcoal|firewood|bbq wood|wood chips|laptop|iphone|ipad|smartwatch|airpods|earpods|power bank|power adapter|charging|usb|bbq grill)\b|فحم|حطب/;
const combinedDish = /\b(?:flavou?red|flavou?r|with|containing)\b|بنكهة|بنكه[هة]/;

export function groceryChoices(term) {
  const query = normalize(term);
  if (noodle.test(query) && !pasta.test(query)) return ['Instant noodles', 'Ramen', 'Pasta'];
  return produce.find(rule => rule.name.test(query) && !rule.alternative.test(query))?.choices ?? [];
}

export function brochureKeyword(term) {
  const query = normalize(term).replace(/\s+/g, ' ').trim();
  if (/^(?:(?:fresh|whole) )?tomato(?:es)?$|^(?:طماطم|بندورة)(?: طازجة)?$/.test(query)) return 'tomato';
  if (/^(?:(?:fresh|whole) )?apples?$|^تفاح(?: طازج)?$/.test(query)) return 'apple';
  if (/^instant noodles$|^نودلز(?: فورية)?$/.test(query)) return 'noodles';
  return term;
}

function matchesProduce(name, query, rule) {
  if (!rule.name.test(name) || nonFood.test(name)) return false;
  if (!rule.alternative.test(query)) return !rule.alternative.test(name) && !combinedDish.test(name);
  const requested = normalize(query.match(rule.alternative)?.[0]).replace(/s$/, '');
  if (requested === 'puree') return /puree|passata/.test(name);
  return name.includes(requested) || (requested === 'juice' && /عصير/.test(name)) ||
    (requested === 'عصير' && /\bjuice\b/.test(name)) ||
    (requested === 'paste' && /معجون/.test(name)) || (requested === 'معجون' && /\bpaste\b/.test(name));
}
export function matchesGroceryCategory(item, term) {
  const query = normalize(term);
  const name = normalize(item.product);
  if (noodle.test(query) && !pasta.test(query)) {
    if (!noodle.test(name) || pasta.test(name)) return false;
    if (/\bramen\b/.test(query)) return /\bramen\b/.test(name);
    if (/\bindomie\b|اندومي/.test(query)) return /\bindomie\b|اندومي/.test(name);
    return true;
  }
  if (pasta.test(query) && !noodle.test(query)) return pasta.test(name) && !noodle.test(name);
  const produceRule = produce.find(rule => rule.name.test(query));
  if (produceRule) return matchesProduce(name, query, produceRule);
  if (milkSearch(query)) {
    if (!/\bmilk\b|حليب/.test(name)) return false;
    if (/\b(?:cadbury|dairy milk|milk chocolate|chocolate bar|biscuit|cookie|wafer|rusk|cake|ice cream|coconut milk|condensed|evaporated|milk powder|powdered milk|powder milk|formula|milk juice)\b|شوكولاتة|بسكويت|حليب\s+(?:جوز الهند|مكثف|مبخر|بودرة)/.test(name)) {
      return /\bchocolate milk\b|حليب\s+(?:بنكهة\s+)?(?:بال)?شوكولاتة/.test(name) && !/\b(?:cadbury|ice cream|wafer|biscuit|bar)\b/.test(name);
    }
  }
  if (/\brice\b|\b(?:basmati|sella|calrose)\b|ارز|رز/.test(query) &&
      !/\b(?:crackers?|crisps?|flour|noodles?|cereal|pudding|vinegar|cakes?|paper)\b|طحين|دقيق|بسكويت|مقرمشات/.test(query)) {
    if (/\b(?:crackers?|crisps?|flour|noodles?|cereal|pudding|vinegar|cakes?|paper)\w*\b|طحين|دقيق|بسكويت|مقرمشات/.test(name)) return false;
  }
  return true;
}

export function compareMonthly(a, b, term) {
  const left = a.package, right = b.package;
  if (milkSearch(term)) {
    const priority = pack => pack.count === 12 ? 2 : (pack.count ?? 0) > 12 ? 1 : 0;
    const tier = priority(right) - priority(left);
    if (tier) return tier;
  }
  const query = normalize(term);
  const order = /\brice\b|ارز|رز/.test(query) ? ['kg', 'piece', 'L'] :
    milkSearch(term) ? ['L', 'piece', 'kg'] : ['kg', 'L', 'piece'];
  const category = pack => pack.unit ? order.indexOf(pack.unit) : order.length;
  return category(left) - category(right) ||
    (right.total ?? 0) - (left.total ?? 0) ||
    (right.count ?? 0) - (left.count ?? 0) ||
    (a.price ?? Infinity) - (b.price ?? Infinity) || a.product.localeCompare(b.product);
}

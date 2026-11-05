/** 素質コラメーカー - GitHub Pages 用検索・合成エンジン。
 * 画像・文字情報はカタログに含まれる既存の値をそのまま使用する。
 */
export const OUTPUT_HEIGHT = 810;
// 桃素質はタイトル帯が金・紫より61px下。原寸のまま上方向に平行移動する。
export const PINK_OFFSET_Y = -61;

const SYMBOL_VARIANTS = new Map([
  ['〜', '~'], ['−', '-'], ['‐', '-'], ['‑', '-'], ['‒', '-'],
  ['–', '-'], ['—', '-'], ['―', '-'], ['、', ','], ['。', '.'], ['·', '・'],
]);
// Python版の東アジア文字幅 F / H 相当を、幅を変換したい文字群に限定する。
// 一般の漢字・平仮名・片仮名を互換漢字などへ変換しない。
function isWidthVariant(char) {
  const code = char.codePointAt(0);
  return code === 0x3000 || (code >= 0xff01 && code <= 0xff60) ||
    (code >= 0xff61 && code <= 0xff9f) ||
    (code >= 0xffa0 && code <= 0xffdc) ||
    (code >= 0xffe0 && code <= 0xffe6) ||
    (code >= 0xffe8 && code <= 0xffee);
}
function normalizeRaw(raw) {
  return Array.from(raw).some(isWidthVariant) ? raw.normalize('NFKC') : raw.normalize('NFC');
}
function canonicalCharacter(raw, kanaInsensitive) {
  let char = normalizeRaw(raw);
  char = SYMBOL_VARIANTS.get(char) ?? char;
  const lower = char.toLowerCase();
  if (Array.from(lower).length === 1) char = lower;
  if (kanaInsensitive && Array.from(char).length === 1) {
    const cp = char.codePointAt(0);
    if ((cp >= 0x3041 && cp <= 0x3096) || cp === 0x309d || cp === 0x309e) {
      char = String.fromCodePoint(cp + 0x60);
    }
  }
  return char;
}
export function textUnits(text, kanaInsensitive = false) {
  const chars = Array.from(text);
  const units = [];
  for (let i = 0; i < chars.length;) {
    let j = i + 1;
    if (j < chars.length && ['ﾞ', 'ﾟ', '\u3099', '\u309a'].includes(chars[j])) {
      const combined = normalizeRaw(chars.slice(i, j + 1).join(''));
      if (Array.from(combined).length === 1) j += 1;
    }
    const raw = chars.slice(i, j).join('');
    units.push({ canonical: canonicalCharacter(raw, kanaInsensitive), start: i, end: j, raw });
    i = j;
  }
  return units;
}
export function normalized(text, kanaInsensitive = false) {
  return textUnits(text, kanaInsensitive).map(unit => unit.canonical).join('');
}
export function verifyCatalog(catalog) {
  if (!catalog || catalog.schema_version !== 2 || !Array.isArray(catalog.assets)) {
    throw new Error('素材データの形式が不正です。');
  }
  const seen = new Set();
  for (const asset of catalog.assets) {
    if (!asset.id || seen.has(asset.id) ||
      asset.width !== 579 || asset.height !== OUTPUT_HEIGHT ||
      !(asset.file?.startsWith('assets/') || asset.file?.startsWith('assets2/')) || !asset.file.endsWith('.png') ||
      !asset.title?.text ||
      asset.title.char_x?.length !== Array.from(asset.title.text).length) {
      throw new Error('素材データの内容が不正です。');
    }
    seen.add(asset.id);
  }
  return catalog;
}
function compareScores(a, b) {
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) return a[i] > b[i] ? 1 : -1;
  }
  return 0;
}
// CPython の random.Random(32-bit seed) と同じ MT19937 / randbelow。
// 同じシードのとき、Python 版と同じカードを選ぶ。
class PythonRandom {
  constructor(seed) {
    this.mt = new Uint32Array(624);
    this.index = 624;
    this.mt[0] = 19650218;
    for (let i = 1; i < 624; i++) {
      const prev = this.mt[i - 1];
      this.mt[i] = (Math.imul(1812433253, prev ^ (prev >>> 30)) + i) >>> 0;
    }
    const key = seed >>> 0;
    let i = 1;
    let j = 0;
    for (let k = 624; k > 0; k--) {
      const prev = this.mt[i - 1];
      this.mt[i] = ((this.mt[i] ^ Math.imul(prev ^ (prev >>> 30), 1664525)) + key + j) >>> 0;
      i++;
      if (i >= 624) { this.mt[0] = this.mt[623]; i = 1; }
    }
    for (let k = 623; k > 0; k--) {
      const prev = this.mt[i - 1];
      this.mt[i] = ((this.mt[i] ^ Math.imul(prev ^ (prev >>> 30), 1566083941)) - i) >>> 0;
      i++;
      if (i >= 624) { this.mt[0] = this.mt[623]; i = 1; }
    }
    this.mt[0] = 0x80000000;
  }
  uint32() {
    if (this.index >= 624) {
      for (let kk = 0; kk < 624; kk++) {
        const y = (this.mt[kk] & 0x80000000) | (this.mt[(kk + 1) % 624] & 0x7fffffff);
        this.mt[kk] = this.mt[(kk + 397) % 624] ^ (y >>> 1) ^ ((y & 1) ? 0x9908b0df : 0);
      }
      this.index = 0;
    }
    let y = this.mt[this.index++];
    y ^= y >>> 11;
    y ^= (y << 7) & 0x9d2c5680;
    y ^= (y << 15) & 0xefc60000;
    y ^= y >>> 18;
    return y >>> 0;
  }
  choiceIndex(n) {
    const bits = 32 - Math.clz32(n); // Python int.bit_length()
    while (true) {
      const draw = this.uint32() >>> (32 - bits);
      if (draw < n) return draw;
    }
  }
}
export function randomSeed() {
  const array = new Uint32Array(1);
  crypto.getRandomValues(array);
  return array[0];
}
// Python の round(100*covered/total, 1) と同じ half-even 丸め。
// 0〜200文字の範囲では整数演算で浮動小数点の境界誤差も回避できる。
function coveragePercent(covered, total) {
  const numerator = 1000 * covered;
  const whole = Math.floor(numerator / total);
  const remainder = numerator % total;
  const rounded = whole + Number(2 * remainder > total ||
    (2 * remainder === total && (whole & 1) !== 0));
  return rounded / 10;
}

// 元カードの外枠だけを残したキャップ。各色・各端に2種ずつ用意する。
// 装飾は検索・採点対象とせず、検索で選ばれた素材そのものは変えない。
const EDGE_CAPS = {
  left: {
    gold: ['./data/caps/left-gold-a.png', './data/caps/left-gold-b.png'],
    purple: ['./data/caps/left-purple-a.png', './data/caps/left-purple-b.png'],
  },
  right: {
    gold: ['./data/caps/right-gold-a.png', './data/caps/right-gold-b.png'],
    purple: ['./data/caps/right-purple-a.png', './data/caps/right-purple-b.png'],
  },
};
// 32 bit seedから、左右独立の再現可能なバリエーションを決める。
function capVariant(seed, side) {
  const salt = side === 'left' ? 0x6e624eb7 : 0x4f1bbcdc;
  return (Math.imul((seed ^ salt) >>> 0, 0x9e3779b1) >>> 31) & 1;
}

export class MosaicEngine {
  constructor(catalog) {
    this.catalog = verifyCatalog(catalog);
    this.byId = new Map(catalog.assets.map(asset => [asset.id, asset]));
    this.indexes = new Map();
    this.imageCache = new Map();
    this.capCache = new Map();
  }
  getIndex(kanaInsensitive) {
    if (this.indexes.has(kanaInsensitive)) return this.indexes.get(kanaInsensitive);
    const starts = new Map();
    for (const asset of this.catalog.assets) {
      const source = asset.title.text;
      if (Array.from(source).length !== asset.title.char_x.length) continue;
      const units = textUnits(source, kanaInsensitive);
      units.forEach((unit, pos) => {
        if (!starts.has(unit.canonical)) starts.set(unit.canonical, []);
        starts.get(unit.canonical).push({ asset, pos, units });
      });
    }
    this.indexes.set(kanaInsensitive, starts);
    return starts;
  }
  search(text, { kanaInsensitive = false, seed = randomSeed() } = {}) {
    if (!text || !text.trim()) throw new Error('文章を入力してください。');
    if (Array.from(text).length > 200) throw new Error('文章は200文字以内で入力してください。');
    if (!Number.isInteger(seed) || seed < 0 || seed >= 4294967296) {
      throw new Error('乱数シードが不正です。');
    }
    const rng = new PythonRandom(seed);
    const targetUnits = textUnits(text, kanaInsensitive);
    const target = targetUnits.map(unit => unit.canonical).join('');
    const starts = this.getIndex(kanaInsensitive);
    const n = targetUnits.length;
    const scores = Array.from({ length: n + 1 }, () => [0, 0, 0, 0, 0]);
    const choices = Array.from({ length: n + 1 }, () => []);
    const rawTarget = Array.from(text);
    for (let i = n - 1; i >= 0; i--) {
      const requested = targetUnits[i];
      let best = scores[i + 1].slice();
      let options = [{ type: 'missing', text: requested.raw, from: requested.start, to: requested.end }];
      for (const { asset, pos, units } of starts.get(requested.canonical) || []) {
        let matchingLen = 0;
        let changedCount = 0;
        while (i + matchingLen < n && pos + matchingLen < units.length &&
          targetUnits[i + matchingLen].canonical === units[pos + matchingLen].canonical) {
          if (targetUnits[i + matchingLen].raw !== units[pos + matchingLen].raw) changedCount++;
          matchingLen++;
          const after = scores[i + matchingLen];
          const endUnit = pos + matchingLen;
          const startChar = units[pos].start;
          const endChar = units[endUnit - 1].end;
          const toOriginal = targetUnits[i + matchingLen - 1].end;
          const atRightEdge = toOriginal === rawTarget.length && endChar === Array.from(asset.title.text).length;
          const atLeftEdge = i === 0 && startChar === 0;
          const score = [after[0] + matchingLen, after[1] - 1,
            after[2] - changedCount, after[3] + Number(atRightEdge), after[4] + Number(atLeftEdge)];
          const compare = compareScores(score, best);
          if (compare >= 0) {
            const piece = {
              type: 'match', asset_id: asset.id, source_title: asset.title.text,
              text: rawTarget.slice(requested.start, toOriginal).join(''),
              matched_text: Array.from(asset.title.text).slice(startChar, endChar).join(''),
              substitution_count: changedCount,
              from: requested.start, to: toOriginal, start_char: startChar, end_char: endChar,
            };
            if (compare > 0) { best = score; options = [piece]; }
            else options.push(piece);
          }
        }
      }
      scores[i] = best;
      choices[i] = options;
    }
    const toUnit = new Map(targetUnits.map((unit, i) => [unit.end, i + 1]));
    const pieces = [];
    let pos = 0;
    let hasAlternative = false;
    while (pos < n) {
      const options = choices[pos];
      if (options.length > 1) hasAlternative = true;
      const piece = { ...options[rng.choiceIndex(options.length)] };
      if (piece.type === 'missing' && pieces.length && pieces.at(-1).type === 'missing') {
        pieces.at(-1).text += piece.text;
        pieces.at(-1).to = piece.to;
      } else {
        pieces.push(piece);
      }
      pos = toUnit.get(piece.to);
    }
    const covered = scores[0][0];
    return {
      requested: text, normalized: target, kana_insensitive: kanaInsensitive,
      seed, complete: covered === n, covered, total: n,
      coverage_percent: coveragePercent(covered, n),
      card_count: pieces.filter(p => p.type === 'match').length,
      substitution_count: Math.max(0, -scores[0][2]), has_alternative: hasAlternative,
      missing: pieces.filter(p => p.type === 'missing').map(p => p.text).join(''),
      pieces,
    };
  }
  signature(result) {
    return JSON.stringify(result.pieces.map(piece =>
      [piece.type, piece.asset_id || null, piece.start_char ?? null, piece.end_char ?? null]));
  }
  async loadImage(asset) {
    if (!this.imageCache.has(asset.id)) {
      const url = `./data/${asset.file}`;
      const promise = new Promise((resolve, reject) => {
        const image = new Image();
        image.onload = () => resolve(image);
        image.onerror = () => reject(new Error('素材画像を読み込めませんでした。'));
        image.src = url;
      });
      this.imageCache.set(asset.id, promise);
      // 失敗時はリトライ可能にする。
      promise.catch(() => this.imageCache.delete(asset.id));
      // キャッシュ肥大化を避け、直近の選択画像だけを保持する。
      if (this.imageCache.size > 30) {
        const oldest = this.imageCache.keys().next().value;
        if (oldest !== asset.id) this.imageCache.delete(oldest);
      }
    }
    return this.imageCache.get(asset.id);
  }
  async loadCap(side, color, seed) {
    const url = EDGE_CAPS[side][color][capVariant(seed, side)];
    if (!this.capCache.has(url)) {
      const promise = new Promise((resolve, reject) => {
        const image = new Image();
        image.onload = () => resolve(image);
        image.onerror = () => reject(new Error('端の装飾画像を読み込めませんでした。'));
        image.src = url;
      });
      this.capCache.set(url, promise);
      promise.catch(() => this.capCache.delete(url));
    }
    return this.capCache.get(url);
  }
  // 全840枚の画像で、(18,450)の枠色は金・紫の2通りだけ。
  // 最初/最後の文字片に色を合わせ、接合部分の色違いを防ぐ。
  frameColor(image, asset, seed, side) {
    if (asset.file.startsWith('assets2/')) {
      // 桃素材の途中で切れた端は、桃キャップを使わず金・紫から選ぶ。
      // カード自身の先頭／末尾を使える場合は補完処理を通らず、桃の枠を維持する。
      // 検索の乱数系列を消費しないよう、seedと左右別のsaltから決定する。
      const salt = side === 'left' ? 0x0b34de29 : 0x70f9b4d3;
      return (Math.imul((seed ^ salt) >>> 0, 0x85ebca6b) >>> 31) ? 'purple' : 'gold';
    }
    const detector = document.createElement('canvas');
    detector.width = detector.height = 1;
    const context = detector.getContext('2d', { willReadFrequently: true });
    if (!context) throw new Error('このブラウザでは素材の色を判別できません。');
    context.drawImage(image, 18, 450, 1, 1, 0, 0, 1, 1);
    const pixel = context.getImageData(0, 0, 1, 1).data;
    detector.width = detector.height = 0;
    return pixel[0] > pixel[2] ? 'gold' : 'purple';
  }
  async render(result) {
    if (!result.complete) throw new Error('素材にない文字があります。');
    const pieces = result.pieces;
    if (!pieces.length) throw new Error('合成する画像がありません。');
    const crops = pieces.map((piece, index) => {
      const asset = this.byId.get(piece.asset_id);
      if (!asset) throw new Error('採用した素材が見つかりません。');
      const cells = asset.title.char_x;
      let x0 = cells[piece.start_char][0];
      let x1 = cells[piece.end_char - 1][1];
      if (index === 0 && piece.start_char === 0) x0 = 0;
      if (index === pieces.length - 1 && piece.end_char === Array.from(asset.title.text).length) x1 = asset.width;
      return { asset, x0, x1, width: x1 - x0 };
    });
    const images = await Promise.all(crops.map(part => this.loadImage(part.asset)));
    const strips = crops.map((part, i) => ({ ...part, image: images[i],
      yOffset: part.asset.file.startsWith('assets2/') ? PINK_OFFSET_Y : 0 }));
    for (const strip of strips) {
      if (strip.image.naturalWidth !== strip.asset.width || strip.image.naturalHeight !== OUTPUT_HEIGHT) {
        throw new Error('素材画像の寸法が不正です。');
      }
    }
    // 既存の先頭・末尾の完全なカード枠を優先。途中から始まる／終わる場合だけ補う。
    if (pieces[0].start_char > 0) {
      const cap = await this.loadCap('left', this.frameColor(images[0], crops[0].asset, result.seed, 'left'), result.seed);
      if (cap.naturalHeight !== OUTPUT_HEIGHT) throw new Error('端の装飾画像の高さが不正です。');
      strips.unshift({ image: cap, x0: 0, width: cap.naturalWidth });
    }
    const last = pieces.at(-1);
    const lastAsset = crops.at(-1).asset;
    if (last.end_char < Array.from(lastAsset.title.text).length) {
      const cap = await this.loadCap('right', this.frameColor(images.at(-1), crops.at(-1).asset, result.seed, 'right'), result.seed);
      if (cap.naturalHeight !== OUTPUT_HEIGHT) throw new Error('端の装飾画像の高さが不正です。');
      strips.push({ image: cap, x0: 0, width: cap.naturalWidth });
    }
    const width = strips.reduce((sum, part) => sum + part.width, 0);
    // Canvasの上限を超えた場合、内容を欠落させずにエラーにする。
    if (width > 32767) throw new Error('生成画像が長すぎます。文章を短くしてください。');
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = OUTPUT_HEIGHT;
    const ctx = canvas.getContext('2d', { alpha: false });
    if (!ctx) throw new Error('このブラウザでは画像を合成できません。');
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, width, OUTPUT_HEIGHT);
    for (let x = 0, i = 0; i < strips.length; i++) {
      const part = strips[i];
      ctx.drawImage(part.image, part.x0, 0, part.width, OUTPUT_HEIGHT,
        x, part.yOffset ?? 0, part.width, OUTPUT_HEIGHT);
      x += part.width;
    }
    const blob = await new Promise((resolve, reject) => canvas.toBlob(
      resultBlob => resultBlob ? resolve(resultBlob) : reject(new Error('画像を保存できませんでした。')),
      'image/png'));
    canvas.width = 0;
    canvas.height = 0;
    return blob;
  }
}

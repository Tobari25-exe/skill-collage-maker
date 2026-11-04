"""素質カードの文字列を厳密照合し、画像から必要な縦帯を合成する。

OCR・画像登録・JSON作成機能は含まない。カタログは外部で管理する。
"""
from __future__ import annotations

import hashlib
import json
import os
import random
import secrets
import unicodedata
from dataclasses import dataclass
from pathlib import Path

from PIL import Image

ROOT = Path(__file__).resolve().parent
DATA_DIR = Path(os.environ.get('MOSAIC_DATA_DIR', str(ROOT / 'data'))).resolve()
CATALOG_PATH = DATA_DIR / 'catalog.json'
OUTPUT_HEIGHT = 810  # 840枚の元カードはすべて579×810px
Image.MAX_IMAGE_PIXELS = 40_000_000


def load_catalog() -> dict:
    with CATALOG_PATH.open(encoding='utf-8') as file:
        catalog = json.load(file)
    if catalog.get('schema_version') != 2 or not isinstance(catalog.get('assets'), list):
        raise ValueError('schema_version: 2 の catalog.json が必要です')
    return catalog


# 記号の形の差だけを吸収する。長音「ー」とハイフンは別文字のまま。
_SYMBOL_VARIANTS = {
    '〜': '~',   # 波ダッシュ。全角チルダ「～」は幅変換で「~」になる。
    '−': '-', '‐': '-', '‑': '-', '‒': '-', '–': '-', '—': '-', '―': '-',
    '、': ',', '。': '.',
    '·': '・',
}


@dataclass(frozen=True)
class _Unit:
    """1文字相当の検索単位と、元の文字列への対応範囲。"""
    canonical: str
    start: int
    end: int
    raw: str


def _canonical_character(raw: str, kana_insensitive: bool) -> str:
    # NFKCは全角/半角だけに限定し、「①→1」「㌔→キロ」のような
    # 要件外の互換文字展開を避ける。
    if any(unicodedata.east_asian_width(c) in ('F', 'H') for c in raw):
        char = unicodedata.normalize('NFKC', raw)
    else:
        char = unicodedata.normalize('NFC', raw)

    char = _SYMBOL_VARIANTS.get(char, char)
    # 大文字/小文字の差を吸収。ただし1文字が2文字以上に展開する
    # ケース（ß → ss など）は1:1対応に反するため変換しない。
    lower = char.lower()
    if len(lower) == 1:
        char = lower

    if kana_insensitive and len(char) == 1:
        cp = ord(char)
        if 0x3041 <= cp <= 0x3096 or cp in (0x309D, 0x309E):
            char = chr(cp + 0x60)
    return char


def _text_units(text: str, kana_insensitive: bool = False) -> list[_Unit]:
    """濁点の結合表記や半角カナを1単位にし、元の文字座標を保持する。"""
    units: list[_Unit] = []
    i = 0
    while i < len(text):
        j = i + 1
        # 例: 半角「ｶﾞ」（2コードポイント）と全角「ガ」を照合できる。
        if j < len(text) and text[j] in ('ﾞ', 'ﾟ', '\u3099', '\u309A'):
            candidate = text[i:j + 1]
            combined = unicodedata.normalize('NFKC', candidate) if any(
                unicodedata.east_asian_width(c) in ('F', 'H') for c in candidate
            ) else unicodedata.normalize('NFC', candidate)
            if len(combined) == 1:
                j += 1
        raw = text[i:j]
        char = _canonical_character(raw, kana_insensitive)
        # 1:1で扱えない特殊互換文字を無理に複数文字へ展開しない。
        units.append(_Unit(char, i, j, raw))
        i = j
    return units


def normalized(text: str, kana_insensitive: bool = False) -> str:
    """検索用表記。漢字読みへの変換や小書き/濁点の緩和はしない。"""
    return ''.join(unit.canonical for unit in _text_units(text, kana_insensitive))


def asset_path(asset: dict) -> Path:
    rel = asset['file']
    if not isinstance(rel, str):
        raise ValueError('画像パスが不正です')
    path = (DATA_DIR / rel).resolve()
    if not path.is_relative_to(DATA_DIR / 'assets'):
        raise ValueError('画像パスは data/assets 内に限定されています')
    return path


def inspect_catalog(catalog: dict | None = None, check_images: bool = True) -> dict:
    catalog = load_catalog() if catalog is None else catalog
    failures = []
    seen = set()
    for index, asset in enumerate(catalog.get('assets', []), 1):
        aid = asset.get('id')
        if not isinstance(aid, str) or aid in seen:
            failures.append(f'{index}: IDが不正または重複')
        seen.add(aid)
        title = asset.get('title', {})
        text = title.get('text', '')
        cells = title.get('char_x', [])
        width, height = asset.get('width'), asset.get('height')
        if not isinstance(text, str) or not text:
            failures.append(f'{index}: 素質名なし')
        if len(cells) != len(text):
            failures.append(f'{index}: 文字数とchar_x数が不一致')
        if isinstance(width, int) and len(cells) == len(text):
            for cidx, pair in enumerate(cells):
                if (not isinstance(pair, list) or len(pair) != 2 or
                    not all(isinstance(v, int) for v in pair) or
                    not 0 <= pair[0] < pair[1] <= width or
                    (cidx > 0 and cells[cidx - 1][1] != pair[0])):
                    failures.append(f'{index}: char_x[{cidx}]の境界が不正')
        if height != OUTPUT_HEIGHT:
            failures.append(f'{index}: 原寸高さが{OUTPUT_HEIGHT}pxではありません')
        if check_images:
            try:
                with Image.open(asset_path(asset)) as image:
                    if image.size != (width, height):
                        failures.append(f'{index}: 画像サイズ不一致')
            except (OSError, ValueError, KeyError) as exc:
                failures.append(f'{index}: 画像読込失敗 ({exc})')
    return {'count': len(catalog.get('assets', [])), 'ok': not failures, 'errors': failures}


def search(text: str, catalog: dict | None = None, seed: int | None = None,
           kana_insensitive: bool = False) -> dict:
    """最大一致 → 最少カード → 少ない表記置換 → 末尾 → 先頭 → 同点抽選。

    全角/半角、大文字/小文字、一般的な記号表記差は常時吸収する。
    kana_insensitive=True だけが利用者が切り替えられる条件。
    漢字の読み検索・小書き文字/濁点の緩和は行わない。
    """
    catalog = load_catalog() if catalog is None else catalog
    if not text.strip():
        raise ValueError('文章を入力してください')
    if len(text) > 200:
        raise ValueError('検索は200文字以内です')
    if not isinstance(kana_insensitive, bool):
        raise ValueError('かな・カナの検索設定が不正です')
    if seed is None:
        seed = secrets.randbits(32)
    if not isinstance(seed, int) or not 0 <= seed < 2**32:
        raise ValueError('乱数シードは0〜4294967295の整数を指定してください')
    rng = random.Random(seed)

    target_units = _text_units(text, kana_insensitive)
    target = ''.join(u.canonical for u in target_units)
    starts: dict[str, list[tuple[dict, int, list[_Unit]]]] = {}
    for asset in catalog['assets']:
        source = asset['title']['text']
        if len(source) != len(asset['title']['char_x']):
            continue
        src_units = _text_units(source, kana_insensitive)
        for position, unit in enumerate(src_units):
            starts.setdefault(unit.canonical, []).append((asset, position, src_units))

    n = len(target_units)
    # (カバー数, -使用カード片数, -置換数, 末尾一致, 先頭一致)
    scores = [(0, 0, 0, 0, 0)] * (n + 1)
    choices: list[list[dict]] = [[] for _ in range(n + 1)]

    for i in range(n - 1, -1, -1):
        requested = target_units[i]
        candidates = [(scores[i + 1], {
            'type': 'missing', 'text': requested.raw,
            'from': requested.start, 'to': requested.end,
        })]
        for asset, start_unit, src_units in starts.get(requested.canonical, []):
            matching_len = 0
            changed_count = 0
            while (i + matching_len < n and start_unit + matching_len < len(src_units)
                   and target_units[i + matching_len].canonical ==
                       src_units[start_unit + matching_len].canonical):
                if (target_units[i + matching_len].raw !=
                        src_units[start_unit + matching_len].raw):
                    changed_count += 1
                matching_len += 1
                after = scores[i + matching_len]
                end_unit = start_unit + matching_len
                start_char = src_units[start_unit].start
                end_char = src_units[end_unit - 1].end
                to_original = target_units[i + matching_len - 1].end
                at_right_edge = to_original == len(text) and end_char == len(asset['title']['text'])
                at_left_edge = i == 0 and start_char == 0
                score = (after[0] + matching_len,
                         after[1] - 1,
                         after[2] - changed_count,
                         after[3] + int(at_right_edge),
                         after[4] + int(at_left_edge))
                candidates.append((score, {
                    'type': 'match', 'asset_id': asset['id'],
                    'source_title': asset['title']['text'],
                    'text': text[requested.start:to_original],
                    'matched_text': asset['title']['text'][start_char:end_char],
                    'substitution_count': changed_count,
                    'from': requested.start, 'to': to_original,
                    'start_char': start_char, 'end_char': end_char,
                }))
        best = max(score for score, _ in candidates)
        scores[i] = best
        choices[i] = [piece for score, piece in candidates if score == best]

    end_to_unit = {unit.end: i + 1 for i, unit in enumerate(target_units)}
    pieces = []
    pos = 0
    has_alternative = False
    while pos < n:
        options = choices[pos]
        if len(options) > 1:
            has_alternative = True
        piece = dict(rng.choice(options))
        if piece['type'] == 'missing' and pieces and pieces[-1]['type'] == 'missing':
            pieces[-1]['text'] += piece['text']
            pieces[-1]['to'] = piece['to']
        else:
            pieces.append(piece)
        pos = end_to_unit[piece['to']]

    covered = scores[0][0]
    return {
        'requested': text, 'normalized': target, 'kana_insensitive': kana_insensitive,
        'seed': seed, 'complete': covered == n,
        'covered': covered, 'total': n,
        'coverage_percent': round(100 * covered / n, 1),
        'card_count': sum(p['type'] == 'match' for p in pieces),
        'substitution_count': -scores[0][2],
        'has_alternative': has_alternative,
        'missing': ''.join(p['text'] for p in pieces if p['type'] == 'missing'),
        'pieces': pieces,
    }


def plan_signature(result: dict) -> str:
    """引き直し時に直前のカード構成を識別するための値。"""
    data = [(p['type'], p.get('asset_id'), p.get('start_char'), p.get('end_char'))
            for p in result['pieces']]
    payload = json.dumps(data, ensure_ascii=False, separators=(',', ':'))
    return hashlib.sha256(payload.encode('utf-8')).hexdigest()


def render(result: dict, catalog: dict | None = None) -> Image.Image:
    """出力高さは常に元カード原寸810px。外側に不要文字があれば切り落とす。"""
    if not result['complete']:
        raise ValueError('不足している文字があります')
    catalog = load_catalog() if catalog is None else catalog
    by_id = {a['id']: a for a in catalog['assets']}
    frames = []
    pieces = result['pieces']
    for piece in pieces:
        asset = by_id.get(piece['asset_id'])
        if asset is None:
            raise ValueError('採用したカードがカタログにありません')
        cells = asset['title']['char_x']
        x0 = cells[piece['start_char']][0]
        x1 = cells[piece['end_char'] - 1][1]
        with Image.open(asset_path(asset)) as original:
            source = original.convert('RGB')
            if source.height != OUTPUT_HEIGHT:
                raise ValueError(f'画像の高さが原寸{OUTPUT_HEIGHT}pxではありません')
            # 左端: 一致範囲がカード先頭から始まる場合だけ余白を保持。
            # 右端: 一致範囲がカード末尾で終わる場合だけ余白を保持。
            # タイトル途中の余分な文字は、外側のカードでも削る。
            if piece is pieces[0] and piece['start_char'] == 0:
                x0 = 0
            if piece is pieces[-1] and piece['end_char'] == len(asset['title']['text']):
                x1 = source.width
            frames.append(source.crop((x0, 0, x1, OUTPUT_HEIGHT)))

    if not frames:
        raise ValueError('合成する断片がありません')
    result_image = Image.new('RGB', (sum(img.width for img in frames), OUTPUT_HEIGHT), 'white')
    x = 0
    for img in frames:
        result_image.paste(img, (x, 0))
        x += img.width
    return result_image

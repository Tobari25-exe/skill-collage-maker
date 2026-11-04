"""素質コラメーカー公開画面と画像生成API。"""
from __future__ import annotations

import io
import re
from pathlib import Path

from fastapi import FastAPI, HTTPException
from fastapi.responses import HTMLResponse, JSONResponse, Response
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, ConfigDict, Field

import mosaic

ROOT = Path(__file__).resolve().parent
app = FastAPI(title='素質コラメーカー', version='4.0.0')
app.mount('/static', StaticFiles(directory=str(ROOT / 'static')), name='static')


class SearchBody(BaseModel):
    model_config = ConfigDict(extra='forbid')
    text: str = Field(max_length=200)
    seed: int | None = None
    kana_insensitive: bool = False


class ComposeBody(SearchBody):
    avoid_signature: str | None = None


@app.get('/', response_class=HTMLResponse)
def index():
    return (ROOT / 'static' / 'index.html').read_text(encoding='utf-8')


@app.get('/api/health')
def health():
    return {'ok': True, 'cards': len(mosaic.load_catalog()['assets']),
            'output_height': mosaic.OUTPUT_HEIGHT,
            'default_normalization': ['width', 'case', 'symbols'],
            'optional_kana_insensitive': True}


@app.post('/api/search')
def search(body: SearchBody):
    try:
        return mosaic.search(body.text, seed=body.seed,
                             kana_insensitive=body.kana_insensitive)
    except ValueError as exc:
        raise HTTPException(400, str(exc)) from exc


@app.post('/api/compose')
def compose(body: ComposeBody):
    try:
        if body.avoid_signature is not None and not re.fullmatch(r'[0-9a-f]{64}', body.avoid_signature):
            raise ValueError('候補識別子が不正です')
        catalog = mosaic.load_catalog()
        result = mosaic.search(body.text, catalog=catalog, seed=body.seed,
                               kana_insensitive=body.kana_insensitive)
        # 候補を引き直した場合、可能なら直前と異なるプランを選ぶ。
        if body.avoid_signature and body.seed is None and result['has_alternative']:
            for _ in range(16):
                if mosaic.plan_signature(result) != body.avoid_signature:
                    break
                result = mosaic.search(body.text, catalog=catalog,
                                       kana_insensitive=body.kana_insensitive)
        if not result['complete']:
            return JSONResponse(status_code=422, content={
                'detail': '素材にない文字があります', 'missing': result['missing']})
        output = io.BytesIO()
        mosaic.render(result, catalog=catalog).save(output, format='PNG')
        return Response(output.getvalue(), media_type='image/png', headers={
            'Content-Disposition': 'attachment; filename="mosaic.png"',
            'X-Mosaic-Seed': str(result['seed']),
            'X-Mosaic-Signature': mosaic.plan_signature(result),
            'X-Mosaic-Has-Alternative': str(result['has_alternative']).lower(),
        })
    except ValueError as exc:
        raise HTTPException(400, str(exc)) from exc

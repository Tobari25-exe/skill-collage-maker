#!/usr/bin/env python3
"""100件単位の分割カタログを再生成する。

使用例:
    python split_catalog.py
    python split_catalog.py my_catalog.json
    python split_catalog.py my_catalog.json --output data/catalog

入力を省略すると既存の data/catalog/manifest.json と全catalog-N.jsonを読み込む。
"""
import argparse
import json
import re
import tempfile
from pathlib import Path


def load_catalog(source, output_dir):
    if source is not None:
        with source.open(encoding="utf-8") as f:
            doc=json.load(f)
        if doc.get("schema_version") != 2 or not isinstance(doc.get("assets"),list):
            raise ValueError("schema_version=2 と assets 配列が必要です")
        return doc
    manifest_path=output_dir / "manifest.json"
    with manifest_path.open(encoding="utf-8") as f:
        m=json.load(f)
    if m.get("schema_version")!=2 or not isinstance(m.get("part_count"),int) or m["part_count"]<1:
        raise ValueError("manifest.json の形式が不正です")
    assets=[]
    for i in range(1,m["part_count"]+1):
        with (output_dir / f"catalog-{i}.json").open(encoding="utf-8") as f:
            doc=json.load(f)
        if doc.get("schema_version")!=2 or not isinstance(doc.get("assets"),list):
            raise ValueError(f"catalog-{i}.json の形式が不正です")
        assets.extend(doc["assets"])
    if len(assets)!=m.get("asset_count"):
        raise ValueError("manifest.json の件数と不一致です")
    return {"schema_version":2,"assets":assets}


def main():
    p=argparse.ArgumentParser(description=__doc__)
    p.add_argument("input",type=Path,nargs="?",help="任意の入力JSON。省略すると既存の分割データを使用")
    p.add_argument("--output",type=Path,default=Path("data/catalog"))
    p.add_argument("--chunk-size",type=int,default=100)
    args=p.parse_args()
    if args.chunk_size<1:
        p.error("--chunk-size は1以上にしてください")
    catalog=load_catalog(args.input,args.output)
    assets=catalog["assets"]
    ids=[x.get("id") for x in assets]
    if len(ids)!=len(set(ids)):
        raise ValueError("素材IDが重複しています")
    parts=[assets[i:i+args.chunk_size] for i in range(0,len(assets),args.chunk_size)]
    out=args.output
    out.mkdir(parents=True,exist_ok=True)
    # すべての入力とJSONシリアライズを検証した後でファイル更新する。
    serialized={f"catalog-{i}.json":json.dumps({"schema_version":2,"assets":piece},ensure_ascii=False,indent=2)+"\n" for i,piece in enumerate(parts,1)}
    serialized["manifest.json"]=json.dumps({"schema_version":2,"chunk_size":args.chunk_size,"part_count":len(parts),"asset_count":len(assets)},ensure_ascii=False,indent=2)+"\n"
    with tempfile.TemporaryDirectory(dir=out) as tmp:
        for filename,data in serialized.items():
            (Path(tmp)/filename).write_text(data,encoding="utf-8")
        for path in out.glob("catalog-*.json"):
            if re.fullmatch(r"catalog-[1-9][0-9]*\.json",path.name) and path.name not in serialized:
                path.unlink()
        for filename in sorted(serialized):
            (Path(tmp)/filename).replace(out/filename)
    print(f"{len(assets)}件 / 最大{args.chunk_size}件ずつ / {len(parts)}ファイル")

if __name__=="__main__":
    main()

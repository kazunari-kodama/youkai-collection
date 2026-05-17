"""
栃木妖怪伝承マップ CSV を youkai_research に登録し、全件 promote するスクリプト
KDM-164 動作確認用

使い方:
  python import_tochigi_research.py <csvファイルパス> [--dry-run]

例:
  python import_tochigi_research.py "C:\\Users\\kazun\\Downloads\\栃木妖怪伝承マップ_70km圏.csv"
"""

import csv
import sys
sys.stdout.reconfigure(encoding='utf-8', errors='replace')  # type: ignore
import json
import time
import argparse
import urllib.request
import urllib.error
from pathlib import Path

API_BASE = "https://5rmuhg7c8d.execute-api.ap-northeast-1.amazonaws.com/prod"
SYSTEM_KEY = "Ck9pgsMYDMiD6cIFMdaRtg5g1bevNEls"
ADMIN_KEY = "c69ed16d45ee467480ae"


def api(method: str, path: str, body: dict | None = None, headers: dict | None = None) -> dict:
    url = f"{API_BASE}{path}"
    data = json.dumps(body).encode("utf-8") if body else None
    h = {"Content-Type": "application/json", **(headers or {})}
    req = urllib.request.Request(url, data=data, headers=h, method=method)
    try:
        with urllib.request.urlopen(req) as resp:
            return json.loads(resp.read())
    except urllib.error.HTTPError as e:
        return {"error": e.read().decode(), "status": e.code}


def load_csv(path: str) -> list[dict]:
    p = Path(path)
    # BOM 付き UTF-8 / Shift-JIS 両対応
    for enc in ("utf-8-sig", "shift_jis", "utf-8"):
        try:
            rows = []
            with open(p, encoding=enc, newline="") as f:
                reader = csv.DictReader(f)
                for row in reader:
                    # 空白トリム
                    rows.append({k.strip(): v.strip() for k, v in row.items()})
            print(f"[load] encoding={enc}, rows={len(rows)}")
            return rows
        except (UnicodeDecodeError, Exception):
            continue
    raise RuntimeError(f"CSV 読み込み失敗: {path}")


def clean_name(name: str) -> str:
    """先頭の ①②③… 記号を除去"""
    return name.lstrip("①②③④⑤⑥⑦⑧⑨⑩ ").strip()


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("csv_path", help="CSV ファイルパス")
    parser.add_argument("--dry-run", action="store_true")
    parser.add_argument("--promote", action="store_true", help="登録後に全件 promote も行う")
    args = parser.parse_args()

    rows = load_csv(args.csv_path)

    # ヘッダー名の揺れに対応（英名/日本語名どちらも）
    # 期待: 名前 or name, カテゴリ or category, 場所 or location, 緯度 or lat, 経度 or lon, 概要 or overview
    def get(row: dict, *keys: str, default: str = "") -> str:
        for k in keys:
            if k in row and row[k]:
                return row[k]
        return default

    research_ids = []
    ok = err = 0

    for i, row in enumerate(rows, 1):
        name_raw = get(row, "名前", "name")
        name = clean_name(name_raw)
        if not name:
            continue

        category   = get(row, "カテゴリ", "category")
        location   = get(row, "地域", "場所", "location")
        lat_str    = get(row, "緯度", "latitude", "lat")
        lon_str    = get(row, "経度", "longitude", "lon")
        overview   = get(row, "概要", "overview", "summary")

        try:
            lat = float(lat_str) if lat_str else None
            lon = float(lon_str) if lon_str else None
        except ValueError:
            lat = lon = None

        location_str = f"{location} ({lat},{lon})" if lat else location
        summary = f"[{category}] {overview}" if category else overview

        payload = {
            "yokai_name": name,
            "source_type": "oral",  # 民間伝承
            "summary": summary,
            "raw_content": f"場所: {location_str}\n概要: {overview}",
        }
        if lat:
            payload["latitude"] = lat
        if lon:
            payload["longitude"] = lon

        print(f"  [{i:02d}] {name} ({category}) @ {location}")

        if args.dry_run:
            continue

        resp = api("POST", "/research", payload, {"X-System-Key": SYSTEM_KEY})
        if "research_id" in resp:
            research_ids.append(resp["research_id"])
            ok += 1
        else:
            print(f"       ✗ {resp}")
            err += 1
        time.sleep(0.05)  # rate limit 対策

    print(f"\n[import] ok={ok}, err={err}, total={len(rows)}")

    if args.dry_run or not research_ids:
        print("[dry-run] 登録スキップ")
        return

    if not args.promote:
        print(f"\n登録完了。promote するには --promote オプションを付けて再実行してください。")
        print(f"  python import_tochigi_research.py <path> --promote")
        return

    # pending → reviewing → promote
    print(f"\n[promote] {len(research_ids)} 件を順次 promote します...")
    promoted = 0
    for rid in research_ids:
        # reviewing に遷移
        r1 = api("PATCH", f"/research/{rid}", {"status": "reviewing"}, {"X-Admin-Key": ADMIN_KEY})
        if r1.get("ok"):
            # promote (game_visible=true — 通常モードにも流用)
            r2 = api("POST", f"/research/{rid}/promote", {"game_visible": True}, {"X-Admin-Key": ADMIN_KEY})
            if r2.get("ok"):
                promoted += 1
            else:
                print(f"  promote 失敗 {rid}: {r2}")
        else:
            print(f"  reviewing 遷移失敗 {rid}: {r1}")
        time.sleep(0.05)

    print(f"[promote] 完了: {promoted}/{len(research_ids)} 件")
    print(f"\nacademic API で確認:")
    print(f"  GET {API_BASE}/academic/youkai  (要 Cognito JWT)")


if __name__ == "__main__":
    main()

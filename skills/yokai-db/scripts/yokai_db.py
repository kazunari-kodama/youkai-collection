#!/usr/bin/env python3
"""妖怪DB（妖怪屋 youkai-collection）から妖怪情報を取得する CLI。

既定の取得元は学術モード API（GET /academic/youkai）。全国の伝承妖怪
（youkai_core の公開データ。創作妖怪は除外）を Cognito の premium アカウントで取得する。
認証なしで使えるゲーム用 API（GET /youkai）も --source game で選べる。

標準ライブラリのみで動作し、結果は ~/.cache/yokai-db/ にキャッシュする。

使い方（詳細は SKILL.md）:
  yokai_db.py login                        premium アカウントでログイン（初回のみ）
  yokai_db.py sync                         全件取得してキャッシュ更新
  yokai_db.py search -q 河童               横断検索
  yokai_db.py search --category 天狗 --region 福島
  yokai_db.py search --near 37.49,139.93 --radius 50
  yokai_db.py get 亀姫                     1件の詳細（ID でも名前でも可）
  yokai_db.py export --format csv --out data/yokai.csv
"""
from __future__ import annotations

import argparse
import base64
import csv
import getpass
import io
import json
import math
import os
import re
import sys
import time
import unicodedata
import urllib.error
import urllib.parse
import urllib.request
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

API_BASE = os.environ.get(
    "YOKAI_API_BASE",
    "https://5rmuhg7c8d.execute-api.ap-northeast-1.amazonaws.com/prod",
).rstrip("/")
COGNITO_REGION = os.environ.get("YOKAI_COGNITO_REGION", "ap-northeast-1")
COGNITO_CLIENT_ID = os.environ.get("YOKAI_COGNITO_CLIENT_ID", "219csst82vd6cc0pdm2cvgmh9t")
COGNITO_URL = f"https://cognito-idp.{COGNITO_REGION}.amazonaws.com/"

CACHE_DIR = Path(os.environ.get("YOKAI_DB_CACHE_DIR", Path.home() / ".cache" / "yokai-db"))
CONFIG_DIR = Path(os.environ.get("YOKAI_DB_CONFIG_DIR", Path.home() / ".config" / "yokai-db"))
TOKEN_PATH = CONFIG_DIR / "token.json"
CACHE_TTL_SEC = int(os.environ.get("YOKAI_DB_TTL", 24 * 3600))
UA = "yokai-db-skill/2.0"


class AuthError(RuntimeError):
    pass


def cache_path(source: str) -> Path:
    return CACHE_DIR / f"{source}.json"


# ================================================================ HTTP

def _request(url, data=None, headers=None, retries=3):
    hdrs = {"User-Agent": UA, "Accept": "application/json", **(headers or {})}
    body = json.dumps(data).encode("utf-8") if data is not None else None
    last_err = None
    for attempt in range(retries):
        try:
            req = urllib.request.Request(url, data=body, headers=hdrs, method="POST" if body else "GET")
            with urllib.request.urlopen(req, timeout=30) as res:
                return json.loads(res.read().decode("utf-8"))
        except urllib.error.HTTPError as e:
            text = e.read().decode("utf-8", "replace")
            if e.code in (400, 401, 403, 404):
                raise urllib.error.HTTPError(e.url, e.code, text, e.headers, None)
            last_err = f"HTTP {e.code} {text[:200]}"
        except (urllib.error.URLError, TimeoutError, json.JSONDecodeError) as e:
            last_err = e
        time.sleep(1.5 * (attempt + 1))
    raise RuntimeError(f"取得に失敗しました: {url} ({last_err})")


# ================================================================ Cognito auth

def _cognito(target: str, payload: dict) -> dict:
    try:
        return _request(
            COGNITO_URL,
            data=payload,
            headers={
                "Content-Type": "application/x-amz-json-1.1",
                "X-Amz-Target": f"AWSCognitoIdentityProviderService.{target}",
            },
        )
    except urllib.error.HTTPError as e:
        try:
            err = json.loads(e.msg)
            kind = err.get("__type", "")
            msg = err.get("message", "")
        except (ValueError, TypeError):
            kind, msg = "", str(e.msg)
        jp = {
            "NotAuthorizedException": "メールアドレスまたはパスワードが正しくありません（またはトークン失効）",
            "UserNotFoundException": "アカウントが見つかりません",
            "UserNotConfirmedException": "メール確認が完了していないアカウントです",
            "PasswordResetRequiredException": "パスワードのリセットが必要です",
        }.get(kind, msg)
        raise AuthError(f"Cognito 認証エラー: {jp} [{kind}]")


def _jwt_payload(token: str) -> dict:
    part = token.split(".")[1]
    part += "=" * (-len(part) % 4)
    return json.loads(base64.urlsafe_b64decode(part))


def _save_tokens(auth: dict, email: str | None, prev: dict | None = None):
    prev = prev or {}
    tok = {
        "email": email or prev.get("email"),
        "id_token": auth["IdToken"],
        "refresh_token": auth.get("RefreshToken") or prev.get("refresh_token"),
        "expires_at": int(time.time()) + int(auth.get("ExpiresIn", 3600)) - 60,
    }
    CONFIG_DIR.mkdir(parents=True, exist_ok=True)
    TOKEN_PATH.write_text(json.dumps(tok, ensure_ascii=False), encoding="utf-8")
    os.chmod(TOKEN_PATH, 0o600)
    return tok


def login(email: str, password: str) -> dict:
    res = _cognito("InitiateAuth", {
        "AuthFlow": "USER_PASSWORD_AUTH",
        "ClientId": COGNITO_CLIENT_ID,
        "AuthParameters": {"USERNAME": email, "PASSWORD": password},
    })
    if "AuthenticationResult" not in res:
        raise AuthError(f"追加の認証ステップが必要です（{res.get('ChallengeName')}）。学術モード画面で一度ログインして完了させてください")
    tok = _save_tokens(res["AuthenticationResult"], email)
    groups = _jwt_payload(tok["id_token"]).get("cognito:groups", [])
    if "premium" not in groups:
        raise AuthError("ログインは成功しましたが、このアカウントは premium グループではないため学術モード API を使えません")
    return tok


def get_id_token() -> str:
    """有効な IdToken を返す。期限切れならリフレッシュ、無ければ環境変数でログイン。"""
    tok = json.loads(TOKEN_PATH.read_text(encoding="utf-8")) if TOKEN_PATH.exists() else None
    if tok and tok.get("expires_at", 0) > time.time():
        return tok["id_token"]
    if tok and tok.get("refresh_token"):
        try:
            res = _cognito("InitiateAuth", {
                "AuthFlow": "REFRESH_TOKEN_AUTH",
                "ClientId": COGNITO_CLIENT_ID,
                "AuthParameters": {"REFRESH_TOKEN": tok["refresh_token"]},
            })
            return _save_tokens(res["AuthenticationResult"], None, tok)["id_token"]
        except AuthError:
            pass  # リフレッシュトークン失効 → 下でパスワードログインを試す
    email = os.environ.get("YOKAI_DB_EMAIL")
    password = os.environ.get("YOKAI_DB_PASSWORD")
    if email and password:
        return login(email, password)["id_token"]
    raise AuthError(
        "学術モード API の認証情報がありません。ユーザー自身のターミナルで\n"
        "  python3 <skill>/scripts/yokai_db.py login\n"
        "を実行するか、環境変数 YOKAI_DB_EMAIL / YOKAI_DB_PASSWORD を設定してください。\n"
        "（認証なしで使えるゲーム用データは --source game で取得できます）"
    )


# ================================================================ fetch

def fetch_academic() -> list[dict]:
    token = get_id_token()
    items, cursor, seen = [], None, set()
    for _ in range(50):  # 念のための上限
        qs = {"limit": "500"}
        if cursor:
            qs["cursor"] = json.dumps(cursor, ensure_ascii=False)
        url = f"{API_BASE}/academic/youkai?{urllib.parse.urlencode(qs)}"
        try:
            data = _request(url, headers={"Authorization": f"Bearer {token}"})
        except urllib.error.HTTPError as e:
            if e.code in (401, 403):
                raise AuthError(f"学術モード API が {e.code} を返しました（premium 権限またはトークンを確認）: {e.msg[:200]}")
            raise
        new = [i for i in data.get("items", []) if i.get("yokai_id") not in seen]
        if not new:
            break  # サーバーが cursor を無視して同じページを返した場合
        seen.update(i.get("yokai_id") for i in new)
        items.extend(new)
        cursor = data.get("next_key")
        if not cursor:
            break
    return items


def fetch_game() -> list[dict]:
    base = _request(f"{API_BASE}/youkai") or []

    def detail(it):
        try:
            return _request(f"{API_BASE}/youkai/{urllib.parse.quote(it['id'])}")
        except (urllib.error.HTTPError, RuntimeError):
            return None

    with ThreadPoolExecutor(max_workers=8) as ex:
        details = list(ex.map(detail, base))
    return [{**b, **(d or {})} for b, d in zip(base, details)]


def fetch_one_game(yokai_id: str) -> dict | None:
    try:
        return _request(f"{API_BASE}/youkai/{urllib.parse.quote(yokai_id)}")
    except urllib.error.HTTPError:
        return None


# ================================================================ normalize

# 学術モード画面（frontend/academic.js）と同じカテゴリ正規化
CAT_NORMALIZE = {
    "九尾の狐": "狐", "ムジナ": "狸", "狐火": "狐", "蛇女": "蛇神", "竜宮": "竜神",
    "武装地蔵": "地蔵", "異形老婆神像": "神社怪異", "霊泉": "霊水",
    "鬼・怪異群": "鬼", "鬼・文芸": "鬼", "大蛇・大ムカデ": "大蛇", "大蛇・竜神": "竜神",
    "地霊・水神": "水神", "幽霊・水霊": "幽霊", "死霊・美女霊": "死霊", "妖獣・河童説": "河童",
}
KNOWN_CATS = {
    "河童", "水神", "霊水", "霊魚", "鬼", "怨霊", "死霊", "怨念", "天狗", "修験", "竜神", "大蛇",
    "蛇神", "狐", "狸", "狼", "霊鹿", "幽霊", "異類嫁", "異形女性", "異類報恩", "地蔵", "霊石",
    "霊木", "神社怪異", "神霊", "女神", "蚕の起源神", "日輪信仰", "妖", "妖獣", "付喪神", "妖術師",
}
CAT_RULES = [
    (r"河童", "河童"), (r"天狗", "天狗"), (r"狐|九尾", "狐"), (r"狸|ムジナ|貉", "狸"),
    (r"狼|山犬", "狼"), (r"竜|龍", "竜神"), (r"大蛇|蛇神|蛇女|蛇体", "大蛇"),
    (r"幽霊|亡霊|死霊|怨霊", "幽霊"), (r"鬼", "鬼"), (r"修験|山伏", "天狗"),
    (r"神社|祠|御神木", "神社怪異"), (r"地蔵|仏|観音", "地蔵"), (r"河伯|水神|水霊", "水神"),
    (r"付喪神|器物", "付喪神"), (r"妖術|妖狐|妖怪", "妖"),
]
SOURCE_LABEL = {"academic": "学術文献", "web": "Web", "oral": "民間伝承", "image": "画像資料"}


def extract_category(notes: str, name: str, explicit: str | None) -> tuple[str, str]:
    """(正規化カテゴリ, 元のカテゴリ表記) を返す。"""
    m = re.match(r"^\[(.+?)\]", notes or "")
    if m:
        raw = m.group(1)
        if raw in CAT_NORMALIZE:
            return CAT_NORMALIZE[raw], raw
        if raw in KNOWN_CATS:
            return raw, raw
        parts = [p.strip() for p in re.split(r"・|、|,", raw)]
        for p in parts:
            n = CAT_NORMALIZE.get(p, p)
            if n in KNOWN_CATS:
                return n, raw
        return CAT_NORMALIZE.get(parts[0], parts[0]), raw
    if explicit:
        return CAT_NORMALIZE.get(explicit, explicit), explicit
    text = f"{notes or ''} {name or ''}"
    for pat, cat in CAT_RULES:
        if re.search(pat, text):
            return cat, ""
    return "", ""


def _img_url(i):
    if isinstance(i, dict):
        return i
    if isinstance(i, str):
        return {"url": i if i.startswith("http") else f"https://d1j2hi9wtnv778.cloudfront.net/{i.lstrip('/')}", "type": "", "caption": ""}
    return None


def normalize(rec: dict, source: str) -> dict:
    notes_raw = rec.get("notes") or rec.get("summary") or ""
    name = rec.get("name") or rec.get("yokai_name") or ""
    cat, cat_raw = extract_category(notes_raw, name, rec.get("category"))
    m = re.search(r"場所:\s*(.+?)(\n|$)", rec.get("raw_content") or "")
    place = rec.get("place_name") or (m.group(1).strip() if m else "")
    regions = rec.get("regions") or []
    out = {
        "id": rec.get("yokai_id") or rec.get("id"),
        "name": name,
        "kana": rec.get("kana", ""),
        "category": cat,
        "category_raw": cat_raw,
        "place": place or rec.get("region_detail", "") or "／".join(regions),
        "lat": rec.get("latitude", rec.get("lat")),
        "lon": rec.get("longitude", rec.get("lon")),
        "notes": re.sub(r"^\[.*?\]\s*", "", notes_raw),
        "appearance": rec.get("appearance", ""),
        "regions": regions,
        "keywords": rec.get("keywords") or [],
        "category_tags": rec.get("category_tags") or [],
        "source_type": rec.get("source_type", ""),
        "source_url": rec.get("source_url", ""),
        "sources": rec.get("sources") or [],
        "reliability_score": rec.get("reliability_score"),
        "originality_score": rec.get("originality_score"),
        "raw_content": rec.get("raw_content", ""),
        "game_visible": rec.get("game_visible") == "true" or source == "game",
        "images": [x for x in (_img_url(i) for i in rec.get("images") or []) if x],
        "camera_url": rec.get("camera_url", ""),
        "updated_at": rec.get("updated_at", ""),
        "_source": source,
    }
    return {k: v for k, v in out.items() if v not in (None, "", [])} | {"id": out["id"], "name": name}


# ================================================================ cache

def sync(source: str, verbose=True) -> dict:
    if verbose:
        print(f"{source} データを取得中…", file=sys.stderr)
    raw = fetch_academic() if source == "academic" else fetch_game()
    items = [normalize(r, source) for r in raw]
    db = {
        "source": source,
        "endpoint": f"{API_BASE}/academic/youkai" if source == "academic" else f"{API_BASE}/youkai",
        "fetched_at": time.strftime("%Y-%m-%dT%H:%M:%S%z"),
        "count": len(items),
        "items": items,
    }
    p = cache_path(source)
    p.parent.mkdir(parents=True, exist_ok=True)
    tmp = p.with_suffix(".tmp")
    tmp.write_text(json.dumps(db, ensure_ascii=False, indent=1), encoding="utf-8")
    tmp.replace(p)
    if verbose:
        print(f"キャッシュ更新: {p}（{len(items)} 件）", file=sys.stderr)
    return db


def load_db(source: str, refresh=False) -> dict:
    p = cache_path(source)
    if not refresh and p.exists() and time.time() - p.stat().st_mtime < CACHE_TTL_SEC:
        return json.loads(p.read_text(encoding="utf-8"))
    try:
        return sync(source)
    except (RuntimeError, urllib.error.HTTPError) as e:
        if p.exists() and not isinstance(e, AuthError):
            print(f"警告: {e} — 古いキャッシュを使います", file=sys.stderr)
            return json.loads(p.read_text(encoding="utf-8"))
        if p.exists() and isinstance(e, AuthError):
            print(f"警告: {e}\n— 古いキャッシュ（{json.loads(p.read_text())['fetched_at']}）を使います", file=sys.stderr)
            return json.loads(p.read_text(encoding="utf-8"))
        raise


# ================================================================ search

def norm_text(s) -> str:
    """NFKC + 空白除去 + カタカナ→ひらがな + 小文字化。"""
    s = unicodedata.normalize("NFKC", str(s or "")).lower()
    s = "".join(ch for ch in s if not ch.isspace())
    return "".join(chr(ord(c) - 0x60) if "ァ" <= c <= "ヶ" else c for c in s)


def haystack(it: dict) -> str:
    parts = [it.get(k, "") for k in ("name", "kana", "category", "category_raw", "place", "notes", "appearance", "raw_content")]
    parts += it.get("regions", []) + it.get("keywords", [])
    return norm_text(" ".join(map(str, parts)))


def haversine_km(lat1, lon1, lat2, lon2) -> float:
    p1, p2 = math.radians(lat1), math.radians(lat2)
    dp, dl = p2 - p1, math.radians(lon2 - lon1)
    a = math.sin(dp / 2) ** 2 + math.cos(p1) * math.cos(p2) * math.sin(dl / 2) ** 2
    return 2 * 6371.0 * math.asin(math.sqrt(a))


def search(items, q=None, region=None, category=None, keyword=None, near=None, radius=None):
    terms = [norm_text(t) for t in (q or "").split() if t.strip()]
    res = []
    for it in items:
        if terms and not all(t in haystack(it) for t in terms):
            continue
        if region:
            rh = norm_text(" ".join([it.get("place", ""), *it.get("regions", []), it.get("raw_content", ""), it.get("notes", "")]))
            if norm_text(region) not in rh:
                continue
        if category:
            c = norm_text(category)
            if c not in norm_text(it.get("category", "") + "|" + it.get("category_raw", "")):
                continue
        if keyword:
            kw = norm_text(keyword)
            if not any(kw in norm_text(k) for k in it.get("keywords", []) + it.get("category_tags", [])):
                continue
        if near:
            if it.get("lat") is None or it.get("lon") is None:
                continue
            d = haversine_km(near[0], near[1], float(it["lat"]), float(it["lon"]))
            if radius is not None and d > radius:
                continue
            it = {**it, "distance_km": round(d, 2)}
        res.append(it)
    if near:
        res.sort(key=lambda x: x["distance_km"])
    elif terms:
        res.sort(key=lambda x: 0 if all(t in norm_text(x["name"] + x.get("kana", "")) for t in terms) else 1)
    return res


def resolve(items, key: str) -> list[dict]:
    by_id = [it for it in items if it["id"] == key]
    if by_id:
        return by_id
    k = norm_text(key)
    exact = [it for it in items if k in (norm_text(it["name"]), norm_text(it.get("kana", "")))]
    return exact or [it for it in items if k in norm_text(it["name"] + "|" + it.get("kana", ""))]


# ================================================================ output

LIGHT_FIELDS = ["id", "name", "kana", "category", "place", "lat", "lon", "source_type", "notes"]


def short(s, n):
    s = (s or "").replace("\n", " ")
    return s[:n] + ("…" if len(s) > n else "")


def fmt_table(items) -> str:
    lines = []
    for it in items:
        dist = f" {it['distance_km']:>6.1f}km" if "distance_km" in it else ""
        kana = f"（{it['kana']}）" if it.get("kana") else ""
        cat = f"[{it['category']}]" if it.get("category") else ""
        lines.append(f"{it['id']}  {it['name']}{kana} {cat}{dist}  {short(it.get('place'), 20)}  {short(it.get('notes'), 45)}")
    return "\n".join(lines)


def fmt_markdown(it: dict) -> str:
    kana = f"（{it['kana']}）" if it.get("kana") else ""
    out = [f"## {it['name']}{kana}", "", f"- ID: `{it['id']}`"]
    if it.get("category"):
        raw = f"（元表記: {it['category_raw']}）" if it.get("category_raw") and it["category_raw"] != it["category"] else ""
        out.append(f"- カテゴリ: {it['category']}{raw}")
    if it.get("place"):
        out.append(f"- 伝承地: {it['place']}")
    if it.get("lat") is not None:
        out.append(f"- 座標: {it['lat']}, {it['lon']}")
    if it.get("distance_km") is not None:
        out.append(f"- 距離: {it['distance_km']} km")
    if it.get("keywords"):
        out.append(f"- キーワード: {'・'.join(it['keywords'])}")
    if it.get("source_type"):
        out.append(f"- 情報源種別: {SOURCE_LABEL.get(it['source_type'], it['source_type'])}")
    scores = [f"{lbl} {it[k]}" for k, lbl in (("reliability_score", "信頼性"), ("originality_score", "独自性")) if it.get(k) is not None]
    if scores:
        out.append(f"- AIスコア: {' / '.join(scores)}")
    if it.get("game_visible") and it.get("_source") == "academic":
        out.append("- ゲーム対応: あり")
    if it.get("notes"):
        out += ["", "### 伝承・解説", it["notes"]]
    if it.get("appearance") and it["appearance"] != it.get("notes"):
        out += ["", "### 姿・特徴", it["appearance"]]
    if it.get("sources") or it.get("source_url"):
        out += ["", "### 出典"]
        for s in it.get("sources", []):
            out.append(f"- [{s.get('title') or s.get('url')}]({s.get('url')})")
        if it.get("source_url") and all(s.get("url") != it["source_url"] for s in it.get("sources", [])):
            out.append(f"- {it['source_url']}")
    if it.get("camera_url") or it.get("images"):
        out += ["", "### 画像"]
        if it.get("camera_url"):
            out.append(f"- カメラ用: {it['camera_url']}")
        for i in it.get("images", []):
            out.append(f"- {i.get('caption') or i.get('type') or '画像'}: {i.get('url')}")
    return "\n".join(out)


CSV_COLS = ["id", "name", "kana", "category", "category_raw", "place", "lat", "lon", "notes", "appearance",
            "keywords", "source_type", "source_urls", "reliability_score", "originality_score", "game_visible"]


def to_csv(items) -> str:
    buf = io.StringIO()
    w = csv.writer(buf)
    w.writerow(CSV_COLS)
    for it in items:
        row = []
        for c in CSV_COLS:
            if c == "source_urls":
                v = [s.get("url") for s in it.get("sources", [])] or ([it["source_url"]] if it.get("source_url") else [])
            else:
                v = it.get(c, "")
            row.append("|".join(map(str, v)) if isinstance(v, list) else ("" if v is None else v))
        w.writerow(row)
    return buf.getvalue()


def emit(items, fmt, full=False) -> str:
    if fmt == "json":
        if not full:
            items = [{k: it[k] for k in LIGHT_FIELDS + ["distance_km"] if k in it} for it in items]
        return json.dumps(items, ensure_ascii=False, indent=2)
    if fmt == "csv":
        return to_csv(items)
    if fmt == "md":
        return "\n\n---\n\n".join(fmt_markdown(it) for it in items)
    return fmt_table(items)


# ================================================================ CLI

def parse_latlon(s: str):
    try:
        a, b = s.split(",")
        return float(a), float(b)
    except ValueError:
        raise argparse.ArgumentTypeError("--near は '緯度,経度' 形式（例: 37.49,139.93）")


def add_filters(sp):
    sp.add_argument("-q", "--query", help="フリーワード（空白区切りで AND）")
    sp.add_argument("--region", help="地名（例: 会津, 福島, 遠野）")
    sp.add_argument("--category", help="カテゴリ（例: 河童, 天狗, 鬼, 狐, 竜神）")
    sp.add_argument("--keyword", help="keywords フィールド（ゲーム用データのみ）")
    sp.add_argument("--near", type=parse_latlon, help="緯度,経度")
    sp.add_argument("--radius", type=float, help="--near からの半径 km")


def main(argv=None):
    p = argparse.ArgumentParser(description="妖怪DB 取得ツール")
    p.add_argument("--source", choices=["academic", "game"], default=os.environ.get("YOKAI_DB_SOURCE", "academic"),
                   help="academic=学術モードAPI（全国の伝承妖怪・要premium）/ game=ゲーム用公開API")
    p.add_argument("--refresh", action="store_true", help="キャッシュを無視して再取得")
    sub = p.add_subparsers(dest="cmd", required=True)

    pl = sub.add_parser("login", help="premium アカウントでログインしトークンを保存")
    pl.add_argument("--email")
    sub.add_parser("logout", help="保存したトークンを削除")
    sub.add_parser("sync", help="全件取得してキャッシュ更新")
    sub.add_parser("info", help="件数・取得日時・カテゴリ内訳")

    ps = sub.add_parser("search", help="検索")
    add_filters(ps)
    ps.add_argument("--limit", type=int, default=30, help="0 で全件")
    ps.add_argument("--format", choices=["table", "json", "csv", "md"], default="table")
    ps.add_argument("--full", action="store_true", help="json で全フィールド")

    pli = sub.add_parser("list", help="全件一覧")
    pli.add_argument("--limit", type=int)
    pli.add_argument("--format", choices=["table", "json", "csv", "md"], default="table")
    pli.add_argument("--full", action="store_true")

    pg = sub.add_parser("get", help="1件の詳細（ID または名前）")
    pg.add_argument("key")
    pg.add_argument("--format", choices=["md", "json"], default="md")

    pe = sub.add_parser("export", help="ファイル出力")
    add_filters(pe)
    pe.add_argument("--format", choices=["json", "csv", "md"], default="json")
    pe.add_argument("--out", required=True)

    a = p.parse_args(argv)

    try:
        if a.cmd == "login":
            email = a.email or os.environ.get("YOKAI_DB_EMAIL") or input("メールアドレス: ").strip()
            password = os.environ.get("YOKAI_DB_PASSWORD") or getpass.getpass("パスワード: ")
            tok = login(email, password)
            print(f"ログイン成功（premium）。トークンを {TOKEN_PATH} に保存しました（リフレッシュトークンは30日有効）", file=sys.stderr)
            return 0
        if a.cmd == "logout":
            TOKEN_PATH.unlink(missing_ok=True)
            print("トークンを削除しました", file=sys.stderr)
            return 0
        if a.cmd == "sync":
            db = sync(a.source)
            print(json.dumps({k: db[k] for k in ("source", "count", "fetched_at")}, ensure_ascii=False))
            return 0

        db = load_db(a.source, refresh=a.refresh)
        items = db["items"]

        if a.cmd == "info":
            from collections import Counter
            cats = Counter(it.get("category") or "(なし)" for it in items)
            print(json.dumps({
                "source": db["source"], "count": db["count"], "fetched_at": db["fetched_at"],
                "cache": str(cache_path(a.source)), "categories": dict(cats.most_common()),
            }, ensure_ascii=False, indent=2))
        elif a.cmd in ("search", "list"):
            if a.cmd == "search":
                if a.radius and not a.near:
                    p.error("--radius には --near が必要です")
                res = search(items, a.query, a.region, a.category, a.keyword, a.near, a.radius)
            else:
                res = items
            total = len(res)
            if a.limit:
                res = res[: a.limit]
            print(emit(res, a.format, a.full))
            print(f"\n# {db['source']}: ヒット {total} 件 / 表示 {len(res)} 件 / 全 {len(items)} 件（取得 {db['fetched_at']}）", file=sys.stderr)
        elif a.cmd == "get":
            hits = resolve(items, a.key)
            if not hits:
                print(f"見つかりません: {a.key}（search -q で部分一致・別表記を試してください）", file=sys.stderr)
                return 1
            if len(hits) > 1:
                print(f"# 候補 {len(hits)} 件", file=sys.stderr)
            hits = hits[:10]
            if a.source == "game":
                # ゲーム用は単体 API で最新を取り直す
                hits = [normalize(d, "game") if (d := fetch_one_game(h["id"])) else h for h in hits]
            if a.format == "json":
                print(json.dumps(hits if len(hits) > 1 else hits[0], ensure_ascii=False, indent=2))
            else:
                print("\n\n---\n\n".join(fmt_markdown(h) for h in hits))
        elif a.cmd == "export":
            res = search(items, a.query, a.region, a.category, a.keyword, a.near, a.radius)
            out = Path(a.out)
            out.parent.mkdir(parents=True, exist_ok=True)
            if a.format == "json":
                text = json.dumps({"source": db["source"], "endpoint": db.get("endpoint"), "fetched_at": db["fetched_at"],
                                   "count": len(res), "items": res}, ensure_ascii=False, indent=2)
            else:
                text = emit(res, a.format)
            out.write_text(text, encoding="utf-8")
            print(f"{len(res)} 件を {out} に出力しました", file=sys.stderr)
        return 0
    except AuthError as e:
        print(f"[認証エラー] {e}", file=sys.stderr)
        return 2


if __name__ == "__main__":
    sys.exit(main())

# build-region-map

計算配置（computed spawns）の地域の重み付けに使う「geohash 4桁 → 都道府県名」の対応表
`backend/src/data/region-map.json` を生成するスクリプト。Lambda に同梱される。

## 出典・ライセンス

- **国土数値情報（行政区域データ N03）令和6年（2024年1月1日時点）**　国土交通省
  - https://nlftp.mlit.go.jp/ksj/gml/datalist/KsjTmplt-N03-2024.html
  - 使用許諾条件: **オープンデータ（CC BY 4.0）**
- `region-map.json` は上記データを加工して作成したもの（都道府県境界から geohash 4桁ごとの都道府県を判定）。
- 表示例: 「出典：国土数値情報（行政区域データ）（国土交通省）を加工して作成」

## 生成手順

元データ（全国で約600MB）はリポジトリに含めない。

```sh
# 1. 都道府県別の zip（01〜47）をダウンロードして GeoJSON を取り出す
mkdir -p /tmp/n03/zip /tmp/n03/geojson
cd /tmp/n03/zip
for i in $(seq -w 1 47); do
  curl -sfO "https://nlftp.mlit.go.jp/ksj/gml/data/N03/N03-2024/N03-20240101_${i}_GML.zip"
done
for f in *.zip; do unzip -o -q -j "$f" '*.geojson' -d /tmp/n03/geojson; done

# 2. 対応表を生成（リポジトリのルートで実行。北海道のファイルが大きいのでヒープを広げる）
node --max-old-space-size=4096 scripts/build-region-map/index.mjs /tmp/n03/geojson
```

`*_subprefecture.geojson`（北海道の振興局）は自動で除外する。依存パッケージは不要。

## 判定方法

- 対象: 北緯20〜46度・東経122〜154度に中心がある geohash 4桁（約40km × 20km）
- マス中心点が含まれる都道府県を採用
- 中心点が海上なら、マス内 3×3 の9点で最多の都道府県（同数は名前順）
- どれにも該当しないマスは出力しない（参照側 `prefectureOfGeohash` は `null` を返す）

2024年版での結果: 13,468 マス中、中心点で決定 627・9点の多数決で決定 218・該当なし 12,623。

geohash 4桁は粗いので、県境付近のマスは隣県として扱われることがある。
地域の重み付け（倍率5倍）にしか使わないため、この精度で足りる想定。

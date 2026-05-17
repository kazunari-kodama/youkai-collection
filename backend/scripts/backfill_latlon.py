"""
youkai_research / youkai_core の既存アイテムに
raw_content から lat/lon を抽出して書き込むバックフィル (KDM-164 補足)

raw_content のフォーマット:
  "場所: 栃木市 (36.3804,139.7372)\n概要: ..."

実行方法:
  python backfill_latlon.py [--dry-run]
"""

import boto3
import re
import argparse
from decimal import Decimal

REGION = 'ap-northeast-1'
RESEARCH_TABLE = 'youkai_research'
CORE_TABLE = 'youkai_core'

LAT_LON_RE = re.compile(r'\((\d+\.\d+),(\d+\.\d+)\)')


def extract_latlon(raw_content: str) -> tuple[float, float] | tuple[None, None]:
    m = LAT_LON_RE.search(raw_content)
    if m:
        return float(m.group(1)), float(m.group(2))
    return None, None


def backfill(dry_run: bool):
    ddb = boto3.client('dynamodb', region_name=REGION)

    # --- youkai_research をスキャン ---
    items = []
    kwargs = {'TableName': RESEARCH_TABLE,
              'FilterExpression': 'attribute_not_exists(#lat)',
              'ExpressionAttributeNames': {'#lat': 'latitude'},
              'ProjectionExpression': 'research_id, raw_content, promoted_to'}
    while True:
        resp = ddb.scan(**kwargs)
        items.extend(resp['Items'])
        if 'LastEvaluatedKey' not in resp:
            break
        kwargs['ExclusiveStartKey'] = resp['LastEvaluatedKey']

    print(f'[research] lat なし: {len(items)} 件')

    updated_research = updated_core = 0

    for item in items:
        rid = item['research_id']['S']
        raw = item.get('raw_content', {}).get('S', '')
        lat, lon = extract_latlon(raw)
        if lat is None:
            continue

        print(f'  {rid[:8]}… lat={lat} lon={lon}')
        if dry_run:
            continue

        # research に lat/lon を書き込む
        ddb.update_item(
            TableName=RESEARCH_TABLE,
            Key={'research_id': {'S': rid}},
            UpdateExpression='SET latitude = :lat, longitude = :lon',
            ExpressionAttributeValues={
                ':lat': {'N': str(lat)},
                ':lon': {'N': str(lon)},
            },
        )
        updated_research += 1

        # promoted_to がある場合 youkai_core にも書き込む
        yokai_id = item.get('promoted_to', {}).get('S')
        if yokai_id:
            ddb.update_item(
                TableName=CORE_TABLE,
                Key={'yokai_id': {'S': yokai_id}},
                UpdateExpression='SET latitude = :lat, longitude = :lon',
                ExpressionAttributeValues={
                    ':lat': {'N': str(lat)},
                    ':lon': {'N': str(lon)},
                },
            )
            updated_core += 1

    print(f'[backfill] research={updated_research}, core={updated_core}')


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('--dry-run', action='store_true')
    args = parser.parse_args()
    backfill(dry_run=args.dry_run)

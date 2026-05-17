"""
kodama_db → youkai_core 移行スクリプト (KDM-155)

- kodama_db を全件スキャンして youkai_core にコピー
- 各アイテムに published="true", created_at, updated_at を付与
- DynamoDB batch_write_item (25件ずつ) で書き込み
- 最後に件数を照合して検証

実行方法:
  python migrate_kodama_to_core.py [--dry-run]
"""

import boto3
import argparse
from datetime import datetime, timezone

SRC_TABLE = 'kodama_db'
DST_TABLE = 'youkai_core'
REGION    = 'ap-northeast-1'
BATCH_SIZE = 25  # DynamoDB BatchWriteItem の上限


def migrate(dry_run: bool):
    ddb = boto3.client('dynamodb', region_name=REGION)
    now = datetime.now(timezone.utc).strftime('%Y-%m-%dT%H:%M:%SZ')

    print(f'[migrate] src={SRC_TABLE} → dst={DST_TABLE}  dry_run={dry_run}')
    print(f'[migrate] timestamp={now}')

    # --- 全件スキャン ---
    items = []
    kwargs = {'TableName': SRC_TABLE}
    while True:
        resp = ddb.scan(**kwargs)
        items.extend(resp['Items'])
        print(f'  scanned {len(items)} items so far...')
        if 'LastEvaluatedKey' not in resp:
            break
        kwargs['ExclusiveStartKey'] = resp['LastEvaluatedKey']

    print(f'[migrate] total scanned: {len(items)} items')

    # --- 属性追加 ---
    for item in items:
        item['published']  = {'S': 'true'}
        item['created_at'] = {'S': now}
        item['updated_at'] = {'S': now}

    if dry_run:
        print('[dry-run] first item sample:')
        first = items[0] if items else {}
        for k, v in sorted(first.items()):
            print(f'  {k}: {v}')
        print('[dry-run] 書き込みはスキップしました')
        return

    # --- バッチ書き込み ---
    written = 0
    for i in range(0, len(items), BATCH_SIZE):
        batch = items[i:i + BATCH_SIZE]
        request_items = {
            DST_TABLE: [{'PutRequest': {'Item': item}} for item in batch]
        }
        resp = ddb.batch_write_item(RequestItems=request_items)
        unprocessed = resp.get('UnprocessedItems', {})
        if unprocessed:
            print(f'  [warn] unprocessed items: {len(unprocessed.get(DST_TABLE, []))}')
        written += len(batch)
        print(f'  written {written}/{len(items)}...')

    print(f'[migrate] write done: {written} items')

    # --- 検証: 件数照合 ---
    print('[migrate] verifying item count...')
    src_count = ddb.describe_table(TableName=SRC_TABLE)['Table']['ItemCount']
    dst_resp  = ddb.scan(TableName=DST_TABLE, Select='COUNT')
    dst_count = dst_resp['Count']
    while 'LastEvaluatedKey' in dst_resp:
        dst_resp  = ddb.scan(TableName=DST_TABLE, Select='COUNT',
                             ExclusiveStartKey=dst_resp['LastEvaluatedKey'])
        dst_count += dst_resp['Count']

    print(f'  src ({SRC_TABLE}) ItemCount (cached): {src_count}')
    print(f'  dst ({DST_TABLE}) actual count:       {dst_count}')
    if dst_count == len(items):
        print('[migrate] ✓ 件数一致 — 移行成功')
    else:
        print(f'[migrate] ✗ 件数不一致: scanned={len(items)}, dst={dst_count}')


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('--dry-run', action='store_true', help='書き込みせず内容を確認する')
    args = parser.parse_args()
    migrate(dry_run=args.dry_run)

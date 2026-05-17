"""
YOUKAI_TABLE に存在する全アイテムを「オリジナル妖怪（創作）」として
youkai_core に is_original = True を付与するバックフィルスクリプト。

実行前に環境変数を確認:
  YOUKAI_TABLE_NAME  ... 通常モードの妖怪テーブル名
  CORE_TABLE_NAME    ... youkai_core テーブル名
  AWS_PROFILE        ... 省略可
"""

import sys
import os
import boto3
from botocore.exceptions import ClientError

sys.stdout.reconfigure(encoding='utf-8', errors='replace')

YOUKAI_TABLE = os.environ.get('YOUKAI_TABLE_NAME', 'youkai-collection-web-YoukaiTable-KBT8SKS1QLZB')
CORE_TABLE   = os.environ.get('CORE_TABLE_NAME',   'youkai-collection-web-YoukaiCoreTable-1BHXDPKQIRVBM')
REGION       = os.environ.get('AWS_DEFAULT_REGION', 'ap-northeast-1')

dynamodb = boto3.resource('dynamodb', region_name=REGION)
youkai_table = dynamodb.Table(YOUKAI_TABLE)
core_table   = dynamodb.Table(CORE_TABLE)


def scan_all(table):
    items = []
    kwargs = {}
    while True:
        resp = table.scan(**kwargs)
        items.extend(resp.get('Items', []))
        if 'LastEvaluatedKey' not in resp:
            break
        kwargs['ExclusiveStartKey'] = resp['LastEvaluatedKey']
    return items


def main():
    print(f'YOUKAI_TABLE: {YOUKAI_TABLE}')
    print(f'CORE_TABLE  : {CORE_TABLE}')

    print('\nYOUKAI_TABLE をスキャン中...')
    youkai_items = scan_all(youkai_table)
    ids = {item['yokai_id'] for item in youkai_items if 'yokai_id' in item}
    print(f'  {len(ids)} 件取得')

    updated = 0
    skipped = 0
    not_found = 0

    print('\nyoukai_core に is_original を付与中...')
    for yokai_id in ids:
        try:
            core_table.update_item(
                Key={'yokai_id': yokai_id},
                UpdateExpression='SET is_original = :v',
                ExpressionAttributeValues={':v': True},
                ConditionExpression='attribute_exists(yokai_id)',
            )
            updated += 1
        except ClientError as e:
            if e.response['Error']['Code'] == 'ConditionalCheckFailedException':
                not_found += 1
            else:
                print(f'  ERROR {yokai_id}: {e}')
                skipped += 1

    print(f'\n完了: updated={updated}, not_in_core={not_found}, error={skipped}')


if __name__ == '__main__':
    main()

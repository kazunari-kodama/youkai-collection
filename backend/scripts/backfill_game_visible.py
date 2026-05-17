"""
youkai_core の既存アイテムに game_visible="true" をセットするバックフィルスクリプト (KDM-164)

kodama_db から移行した 174 件はすべて通常ゲームモードで表示する想定なので
game_visible="true" を付与する。すでにフィールドがあるアイテムはスキップ。

実行方法:
  python backfill_game_visible.py [--dry-run]
"""

import boto3
import argparse
from botocore.exceptions import ClientError

TABLE = 'youkai_core'
REGION = 'ap-northeast-1'


def backfill(dry_run: bool):
    ddb = boto3.client('dynamodb', region_name=REGION)

    items = []
    kwargs = {'TableName': TABLE, 'ProjectionExpression': 'yokai_id, game_visible'}
    while True:
        resp = ddb.scan(**kwargs)
        items.extend(resp['Items'])
        if 'LastEvaluatedKey' not in resp:
            break
        kwargs['ExclusiveStartKey'] = resp['LastEvaluatedKey']

    print(f'[backfill] total scanned: {len(items)} items')

    targets = [item for item in items if 'game_visible' not in item]
    print(f'[backfill] items without game_visible: {len(targets)}')

    if dry_run:
        print('[dry-run] skipping writes')
        return

    updated = 0
    errors = 0
    for item in targets:
        yokai_id = item['yokai_id']['S']
        try:
            ddb.update_item(
                TableName=TABLE,
                Key={'yokai_id': {'S': yokai_id}},
                UpdateExpression='SET game_visible = :v',
                ExpressionAttributeValues={':v': {'S': 'true'}},
                ConditionExpression='attribute_not_exists(game_visible)',
            )
            updated += 1
        except ClientError as e:
            if e.response['Error']['Code'] == 'ConditionalCheckFailedException':
                pass  # already set by concurrent run
            else:
                print(f'  [error] {yokai_id}: {e}')
                errors += 1

    print(f'[backfill] updated: {updated}, errors: {errors}')
    if errors == 0:
        print('[backfill] done')
    else:
        print('[backfill] completed with errors')


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('--dry-run', action='store_true')
    args = parser.parse_args()
    backfill(dry_run=args.dry_run)

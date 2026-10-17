"""
youkai_core の game_visible な妖怪に rarity="common" を付与するバックフィルスクリプト

計算配置（computed spawns）は rarity が無い妖怪を common として扱うので、
このスクリプトを実行しなくても動作は変わらない。管理画面や DynamoDB コンソールで
レア度を確認・編集しやすくするために、既定値を明示的に書き込むためのもの。
すでに rarity を持つアイテムは変更しない。

rarity の値: common / uncommon / rare / legendary
  （legendary は計算配置に出ない。固定配置・イベント限定専用）

実行方法:
  python backfill_rarity.py            # 既定は dry-run（件数を表示するだけ）
  python backfill_rarity.py --apply    # 書き込む
"""

import argparse

import boto3
from botocore.exceptions import ClientError

TABLE = 'youkai_core'
REGION = 'ap-northeast-1'


def backfill(apply: bool):
    ddb = boto3.client('dynamodb', region_name=REGION)

    items = []
    kwargs = {
        'TableName': TABLE,
        'ProjectionExpression': 'yokai_id, rarity, game_visible',
    }
    while True:
        resp = ddb.scan(**kwargs)
        items.extend(resp['Items'])
        if 'LastEvaluatedKey' not in resp:
            break
        kwargs['ExclusiveStartKey'] = resp['LastEvaluatedKey']

    def visible(item):
        gv = item.get('game_visible', {})
        return gv.get('S') == 'true' or gv.get('BOOL') is True

    targets = [i for i in items if visible(i) and 'rarity' not in i]
    print(f'[backfill] scanned: {len(items)}, game_visible without rarity: {len(targets)}')

    if not apply:
        print('[dry-run] 書き込みはスキップしました（--apply で実行）')
        return

    updated = errors = 0
    for item in targets:
        yokai_id = item['yokai_id']['S']
        try:
            ddb.update_item(
                TableName=TABLE,
                Key={'yokai_id': {'S': yokai_id}},
                UpdateExpression='SET rarity = :r',
                ExpressionAttributeValues={':r': {'S': 'common'}},
                ConditionExpression='attribute_not_exists(rarity)',
            )
            updated += 1
        except ClientError as e:
            if e.response['Error']['Code'] != 'ConditionalCheckFailedException':
                print(f'  [error] {yokai_id}: {e}')
                errors += 1

    print(f'[backfill] updated: {updated}, errors: {errors}')


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('--apply', action='store_true')
    backfill(apply=parser.parse_args().apply)

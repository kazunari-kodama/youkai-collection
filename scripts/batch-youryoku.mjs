/**
 * 既存の kodama_db 全件に youryoku を確率割り当てするスクリプト
 * 実行: node scripts/batch-youryoku.mjs
 * 環境変数: AWS_REGION, YOUKAI_TABLE（未設定時はデフォルト値を使用）
 */
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, ScanCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';

const REGION = process.env.AWS_REGION ?? 'ap-northeast-1';
const TABLE  = process.env.YOUKAI_TABLE ?? 'kodama_db';

const DISTRIBUTION = [
  { rank: 1, weight: 40 }, // 迷霊
  { rank: 2, weight: 30 }, // 物怪
  { rank: 3, weight: 20 }, // 精霊
  { rank: 4, weight:  8 }, // 御魂
  { rank: 5, weight:  2 }, // 権現
];
const RANK_NAMES = { 1:'迷霊', 2:'物怪', 3:'精霊', 4:'御魂', 5:'権現' };
const TOTAL_WEIGHT = DISTRIBUTION.reduce((s, d) => s + d.weight, 0);

function randomRank() {
  let r = Math.random() * TOTAL_WEIGHT;
  for (const d of DISTRIBUTION) {
    r -= d.weight;
    if (r <= 0) return d.rank;
  }
  return 1;
}

const client  = new DynamoDBClient({ region: REGION });
const ddb     = DynamoDBDocumentClient.from(client);

async function main() {
  console.log(`Table: ${TABLE}, Region: ${REGION}`);

  // 全件スキャン
  const items = [];
  let lastKey;
  do {
    const res = await ddb.send(new ScanCommand({
      TableName: TABLE,
      ProjectionExpression: 'yokai_id, #n, youryoku',
      ExpressionAttributeNames: { '#n': 'name' },
      ExclusiveStartKey: lastKey,
    }));
    items.push(...(res.Items ?? []));
    lastKey = res.LastEvaluatedKey;
  } while (lastKey);

  console.log(`Total items: ${items.length}`);

  const toUpdate = items.filter(i => i.youryoku == null);
  console.log(`Items needing youryoku: ${toUpdate.length}`);

  const counts = { 1:0, 2:0, 3:0, 4:0, 5:0 };
  let updated = 0;

  for (const item of toUpdate) {
    const rank = randomRank();
    counts[rank]++;
    await ddb.send(new UpdateCommand({
      TableName: TABLE,
      Key: { yokai_id: item.yokai_id },
      UpdateExpression: 'SET youryoku = :r',
      ExpressionAttributeValues: { ':r': rank },
    }));
    updated++;
    if (updated % 20 === 0) process.stdout.write(`  ${updated}/${toUpdate.length}...\r`);
  }

  console.log(`\nDone. Updated ${updated} items.`);
  console.log('Distribution:');
  for (const [r, c] of Object.entries(counts)) {
    console.log(`  ${RANK_NAMES[r]} (${r}): ${c} (${(c/updated*100).toFixed(1)}%)`);
  }
}

main().catch(e => { console.error(e); process.exit(1); });

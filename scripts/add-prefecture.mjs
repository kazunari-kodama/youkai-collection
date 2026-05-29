/**
 * kodama_db 全件の latitude/longitude から都道府県名を Nominatim で取得し、
 * prefecture フィールドを DynamoDB に書き込む。
 * 実行: node scripts/add-prefecture.mjs  (backend/ ディレクトリから実行)
 * Nominatim 利用規約: 1 req/sec 以下、User-Agent 必須
 */

import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, ScanCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';

const REGION = process.env.AWS_REGION ?? 'ap-northeast-1';
const TABLE  = process.env.YOUKAI_TABLE ?? 'kodama_db';
const UA     = 'YokaiCollection/1.0 (kazunari.aida@gmail.com)';

// Nominatim が state を返さない場合の ISO3166-2 フォールバック
const ISO_TO_PREF = {
  'JP-01': '北海道', 'JP-02': '青森県', 'JP-03': '岩手県', 'JP-04': '宮城県',
  'JP-05': '秋田県', 'JP-06': '山形県', 'JP-07': '福島県', 'JP-08': '茨城県',
  'JP-09': '栃木県', 'JP-10': '群馬県', 'JP-11': '埼玉県', 'JP-12': '千葉県',
  'JP-13': '東京都', 'JP-14': '神奈川県', 'JP-15': '新潟県', 'JP-16': '富山県',
  'JP-17': '石川県', 'JP-18': '福井県', 'JP-19': '山梨県', 'JP-20': '長野県',
  'JP-21': '岐阜県', 'JP-22': '静岡県', 'JP-23': '愛知県', 'JP-24': '三重県',
  'JP-25': '滋賀県', 'JP-26': '京都府', 'JP-27': '大阪府', 'JP-28': '兵庫県',
  'JP-29': '奈良県', 'JP-30': '和歌山県', 'JP-31': '鳥取県', 'JP-32': '島根県',
  'JP-33': '岡山県', 'JP-34': '広島県', 'JP-35': '山口県', 'JP-36': '徳島県',
  'JP-37': '香川県', 'JP-38': '愛媛県', 'JP-39': '高知県', 'JP-40': '福岡県',
  'JP-41': '佐賀県', 'JP-42': '長崎県', 'JP-43': '熊本県', 'JP-44': '大分県',
  'JP-45': '宮崎県', 'JP-46': '鹿児島県', 'JP-47': '沖縄県',
};

const client = new DynamoDBClient({ region: REGION });
const ddb    = DynamoDBDocumentClient.from(client);

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function getPrefecture(lat, lon) {
  const url = `https://nominatim.openstreetmap.org/reverse?lat=${lat}&lon=${lon}&format=json&accept-language=ja`;
  const res  = await fetch(url, { headers: { 'User-Agent': UA } });
  if (!res.ok) throw new Error(`Nominatim HTTP ${res.status}`);
  const data = await res.json();
  const addr = data.address ?? {};
  // state → province → ISO3166 コード変換 の順で試みる
  return addr.state ?? addr.province ?? ISO_TO_PREF[addr['ISO3166-2-lvl4']] ?? null;
}

async function main() {
  let lastKey   = undefined;
  let updated   = 0;
  let skipped   = 0;
  let noLatLon  = 0;
  let noResult  = 0;

  do {
    const result = await ddb.send(new ScanCommand({
      TableName: TABLE,
      ProjectionExpression: 'yokai_id, latitude, longitude, prefecture',
      ExclusiveStartKey: lastKey,
    }));

    for (const item of result.Items ?? []) {
      if (item.prefecture) {
        console.log(`  skip (already set): ${item.yokai_id} → ${item.prefecture}`);
        skipped++;
        continue;
      }
      if (item.latitude == null || item.longitude == null) {
        console.log(`  skip (no lat/lon): ${item.yokai_id}`);
        noLatLon++;
        continue;
      }

      let prefecture;
      try {
        prefecture = await getPrefecture(Number(item.latitude), Number(item.longitude));
      } catch (e) {
        console.error(`  error (Nominatim): ${item.yokai_id} - ${e.message}`);
        await sleep(3000);
        continue;
      }

      if (!prefecture) {
        console.log(`  skip (no prefecture): ${item.yokai_id} (${item.latitude}, ${item.longitude})`);
        noResult++;
        await sleep(1100);
        continue;
      }

      await ddb.send(new UpdateCommand({
        TableName: TABLE,
        Key: { yokai_id: item.yokai_id },
        UpdateExpression: 'SET prefecture = :p',
        ExpressionAttributeValues: { ':p': prefecture },
      }));

      console.log(`  updated: ${item.yokai_id} → ${prefecture}`);
      updated++;
      await sleep(1100);
    }

    lastKey = result.LastEvaluatedKey;
  } while (lastKey);

  console.log(`\nDone. updated=${updated} skipped=${skipped} noLatLon=${noLatLon} noResult=${noResult}`);
}

main().catch(e => { console.error(e); process.exit(1); });

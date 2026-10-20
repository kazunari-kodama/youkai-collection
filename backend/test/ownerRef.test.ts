import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { SSMClient } from '@aws-sdk/client-ssm';

let encodeOwnerRef: typeof import('../src/lib/ownerRef').encodeOwnerRef;
let decodeOwnerRef: typeof import('../src/lib/ownerRef').decodeOwnerRef;
const ID = '3f2b8c1e-9a4d-4e6f-8b2a-1c3d5e7f9a0b';

before(async () => {
  (SSMClient.prototype as unknown as { send: unknown }).send =
    async () => ({ Parameter: { Value: 'owner-ref-test-secret-0123456789abcdef' } });
  ({ encodeOwnerRef, decodeOwnerRef } = await import('../src/lib/ownerRef'));
});

test('owner_ref は元の端末IDに戻せ、文字列に端末IDを含まない', async () => {
  const ref = await encodeOwnerRef(ID);
  assert.equal(await decodeOwnerRef(ref), ID);
  assert.ok(!ref.includes(ID.slice(0, 8)));
  assert.notEqual(await encodeOwnerRef(ID), ref); // 毎回違う値（同一人物の追跡に使えない）
});

test('改ざん・不正な owner_ref は null', async () => {
  const ref = await encodeOwnerRef(ID);
  const tampered = ref.slice(0, -2) + (ref.endsWith('A') ? 'BB' : 'AA');
  for (const bad of [tampered, '', 'abc', ID, null, 42, 'x'.repeat(300)]) {
    assert.equal(await decodeOwnerRef(bad), null, String(bad));
  }
});

function _sign(
  ax: number, ay: number,
  bx: number, by: number,
  px: number, py: number,
): number {
  return (px - bx) * (ay - by) - (ax - bx) * (py - by);
}

function isInsideTriangle(
  px: number, py: number,
  ax: number, ay: number,
  bx: number, by: number,
  cx: number, cy: number,
): boolean {
  const d1 = _sign(ax, ay, bx, by, px, py);
  const d2 = _sign(bx, by, cx, cy, px, py);
  const d3 = _sign(cx, cy, ax, ay, px, py);
  const hasNeg = d1 < 0 || d2 < 0 || d3 < 0;
  const hasPos = d1 > 0 || d2 > 0 || d3 > 0;
  return !(hasNeg && hasPos);
}

/** プレイヤーの有効な結界の中に座標が含まれるか判定 */
export function isInsideAnyBarrier(
  lat: number,
  lon: number,
  barriers: Array<{ lats: number[]; lons: number[]; expires_at: string }>,
): boolean {
  const now = new Date().toISOString();
  return barriers.some(
    (b) =>
      b.expires_at > now &&
      isInsideTriangle(
        lat, lon,
        b.lats[0], b.lons[0],
        b.lats[1], b.lons[1],
        b.lats[2], b.lons[2],
      ),
  );
}

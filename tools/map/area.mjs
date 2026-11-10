// 取り込む範囲と、ゲーム内の座標(原点からの m、x = 東、z = 南)への変換
export const AREA = {
  name: 'もりの里・若松・田上・角間',
  lat0: 36.535, lat1: 36.566, lon0: 136.677, lon1: 136.714,
  // 遠景用(山並み)
  far: { lat0: 36.47, lat1: 36.63, lon0: 136.60, lon1: 136.82 },
};
export const ORIGIN = { lat: (AREA.lat0 + AREA.lat1) / 2, lon: (AREA.lon0 + AREA.lon1) / 2 };
const R = 6378137;
const k = Math.PI / 180;
export const M_PER_DEG_LAT = 111132.954 - 559.822 * Math.cos(2 * ORIGIN.lat * k) + 1.175 * Math.cos(4 * ORIGIN.lat * k);
export const M_PER_DEG_LON = (Math.PI / 180) * R * Math.cos(ORIGIN.lat * k) / Math.sqrt(1 - 0.00669438 * Math.sin(ORIGIN.lat * k) ** 2);
export const toLocal = (lat, lon) => [(lon - ORIGIN.lon) * M_PER_DEG_LON, -(lat - ORIGIN.lat) * M_PER_DEG_LAT];
export const toLatLon = (x, z) => [ORIGIN.lat - z / M_PER_DEG_LAT, ORIGIN.lon + x / M_PER_DEG_LON];

// 標準地域メッシュ(3次、約1km)
export function meshCodes(a = AREA) {
  const out = [];
  for (let la = Math.floor(a.lat0 * 120); la <= Math.floor(a.lat1 * 120); la++)
    for (let lo = Math.floor((a.lon0 - 100) * 80); lo <= Math.floor((a.lon1 - 100) * 80); lo++) {
      const p = Math.floor(la / 80), u = Math.floor(lo / 80);
      const q = la - p * 80, v = lo - u * 80;
      out.push(`${p}${u}${Math.floor(q / 10)}${Math.floor(v / 10)}${q % 10}${v % 10}`);
    }
  return out;
}

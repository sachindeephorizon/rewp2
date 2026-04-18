import type { LatLng, OsrmRouteResult } from "../types";

const OSRM_URL = "https://router.project-osrm.org/route/v1/driving";
const ROUTE_TIMEOUT_MS = 8000;

interface OsrmResponse {
  code: string;
  routes?: Array<{
    geometry: string;
    distance: number;
    duration: number;
  }>;
}

/**
 * Decode a Google-encoded polyline string into [{lat, lng}, ...].
 */
export function decodePolyline(str: string, precision = 5): LatLng[] {
  const factor = Math.pow(10, precision);
  let index = 0, lat = 0, lng = 0;
  const coords: LatLng[] = [];
  while (index < str.length) {
    let result = 0, shift = 0, b: number;
    do { b = str.charCodeAt(index++) - 63; result |= (b & 0x1f) << shift; shift += 5; } while (b >= 0x20);
    lat += result & 1 ? ~(result >> 1) : result >> 1;
    result = 0; shift = 0;
    do { b = str.charCodeAt(index++) - 63; result |= (b & 0x1f) << shift; shift += 5; } while (b >= 0x20);
    lng += result & 1 ? ~(result >> 1) : result >> 1;
    coords.push({ lat: lat / factor, lng: lng / factor });
  }
  return coords;
}

/**
 * Fetch a driving route from OSRM.
 */
export async function fetchOsrmRoute(origin: LatLng, destination: LatLng): Promise<OsrmRouteResult> {
  const url = `${OSRM_URL}/${origin.lng},${origin.lat};${destination.lng},${destination.lat}?overview=full&geometries=polyline`;
  const res = await fetch(url, {
    headers: { Accept: "application/json" },
    signal: AbortSignal.timeout(ROUTE_TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`OSRM ${res.status}`);
  const data = await res.json() as OsrmResponse;
  if (data.code !== "Ok" || !data.routes?.length) {
    throw new Error(`OSRM: ${data.code || "no route"}`);
  }
  const best = data.routes[0];
  return {
    route: decodePolyline(best.geometry),
    distance: best.distance,
    duration: best.duration,
  };
}

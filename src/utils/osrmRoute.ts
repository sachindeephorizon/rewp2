import type { LatLng, OsrmRouteResult } from "../types";

const OSRM_BASE = "https://router.project-osrm.org/route/v1";
const ROUTE_TIMEOUT_MS = 8000;

export type OsrmProfile = "driving" | "walking" | "cycling";

// Rough average walking speed in m/s when we have to fall back to a driving
// route for walking trips (public OSRM only ships `driving`, self-hosted
// instances can support all three). 1.4 m/s ≈ 5 km/h.
const WALKING_SPEED_MS = 1.4;

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

async function callOsrm(
  profile: OsrmProfile,
  origin: LatLng,
  destination: LatLng,
): Promise<OsrmRouteResult> {
  const url = `${OSRM_BASE}/${profile}/${origin.lng},${origin.lat};${destination.lng},${destination.lat}?overview=full&geometries=polyline`;
  const res = await fetch(url, {
    headers: { Accept: "application/json" },
    signal: AbortSignal.timeout(ROUTE_TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`OSRM ${res.status} (profile=${profile})`);
  const data = await res.json() as OsrmResponse;
  if (data.code !== "Ok" || !data.routes?.length) {
    throw new Error(`OSRM: ${data.code || "no route"} (profile=${profile})`);
  }
  const best = data.routes[0];
  return {
    route: decodePolyline(best.geometry),
    distance: best.distance,
    duration: best.duration,
  };
}

/**
 * Fetch a route. Tries the requested profile first; if the OSRM instance
 * doesn't have that profile (the public server only ships `driving`),
 * falls back to driving and rescales the duration to match the travel mode.
 *
 * Default profile = driving (backwards-compatible — existing callers without
 * a profile arg keep getting the same behaviour).
 */
export async function fetchOsrmRoute(
  origin: LatLng,
  destination: LatLng,
  profile: OsrmProfile = "driving",
): Promise<OsrmRouteResult & { profileUsed: OsrmProfile }> {
  try {
    const r = await callOsrm(profile, origin, destination);
    return { ...r, profileUsed: profile };
  } catch (e) {
    if (profile === "driving") throw e;
    // Fallback: get a driving route and rescale duration for the requested mode.
    console.warn(
      `[osrm] profile=${profile} failed, falling back to driving:`,
      (e as Error).message,
    );
    const r = await callOsrm("driving", origin, destination);
    let duration = r.duration;
    if (profile === "walking") {
      duration = r.distance / WALKING_SPEED_MS;
    } else if (profile === "cycling") {
      duration = r.distance / 4.2; // ~15 km/h
    }
    return { ...r, duration, profileUsed: "driving" };
  }
}

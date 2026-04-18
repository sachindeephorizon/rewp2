import * as h3 from "h3-js";
import type { LatLng } from "../types";

const DEFAULT_RES = 9;
const EARTH_RADIUS_M = 6_371_000;

// FIX: was 50m — caused massive corridor blob overlap
const MAX_GAP_M = 30;

// ─── Haversine distance (metres) ────────────────────────────────────────────

function haversineM(lat1: number, lng1: number, lat2: number, lng2: number): number {
  const toRad = Math.PI / 180;
  const dLat = (lat2 - lat1) * toRad;
  const dLng = (lng2 - lng1) * toRad;
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1 * toRad) * Math.cos(lat2 * toRad) * Math.sin(dLng / 2) ** 2;
  return 2 * EARTH_RADIUS_M * Math.asin(Math.sqrt(a));
}

// ─── Linear interpolation along a segment ───────────────────────────────────

function interpolateSegment(p1: LatLng, p2: LatLng, maxGap: number): LatLng[] {
  const dist = haversineM(p1.lat, p1.lng, p2.lat, p2.lng);
  if (dist <= maxGap) return [p1];

  const steps = Math.ceil(dist / maxGap);
  const pts: LatLng[] = [];
  for (let i = 0; i < steps; i++) {
    const t = i / steps;
    pts.push({
      lat: p1.lat + t * (p2.lat - p1.lat),
      lng: p1.lng + t * (p2.lng - p1.lng),
    });
  }
  return pts;
}

// ─── Interpolate full route ─────────────────────────────────────────────────

function interpolateRoute(routePoints: LatLng[], maxGap = MAX_GAP_M): LatLng[] {
  if (routePoints.length === 0) return [];
  if (routePoints.length === 1) return [routePoints[0]];

  const out: LatLng[] = [];
  for (let i = 0; i < routePoints.length - 1; i++) {
    const seg = interpolateSegment(routePoints[i], routePoints[i + 1], maxGap);
    for (let j = 0; j < seg.length; j++) out.push(seg[j]);
  }
  out.push(routePoints[routePoints.length - 1]);
  return out;
}

// ─── Public API ─────────────────────────────────────────────────────────────

/**
 * Convert a single lat/lng to its H3 cell index.
 */
export function latLngToH3Cell(lat: number, lng: number, resolution = DEFAULT_RES): string {
  return h3.latLngToCell(lat, lng, resolution);
}

interface CorridorOptions {
  resolution?: number;
  buffer?: number;
}

/**
 * Build an H3 corridor from an OSRM-decoded route.
 */
export function buildH3Corridor(routePoints: LatLng[], opts: CorridorOptions = {}): string[] {
  const resolution = opts.resolution || DEFAULT_RES;
  const buffer = opts.buffer != null ? opts.buffer : 1;

  if (!routePoints || routePoints.length === 0) return [];

  const dense = interpolateRoute(routePoints);
  const cellSet = new Set<string>();

  for (let i = 0; i < dense.length; i++) {
    const center = h3.latLngToCell(dense[i].lat, dense[i].lng, resolution);
    if (!cellSet.has(center)) {
      cellSet.add(center);
      const ring = h3.gridDisk(center, buffer);
      for (let j = 0; j < ring.length; j++) {
        cellSet.add(ring[j]);
      }
    }
  }

  return Array.from(cellSet);
}

/**
 * Check whether an H3 index falls inside a pre-built corridor.
 */
export function isInCorridor(h3Index: string, corridorSet: Set<string>): boolean {
  return corridorSet.has(h3Index);
}

'use strict';

const h3 = require('h3-js');

const DEFAULT_RES = 9;
const EARTH_RADIUS_M = 6_371_000;
const MAX_GAP_M = 50; // interpolate if consecutive points are farther apart

// ─── Haversine distance (metres) ────────────────────────────────────────────

function haversineM(lat1, lng1, lat2, lng2) {
  const toRad = Math.PI / 180;
  const dLat = (lat2 - lat1) * toRad;
  const dLng = (lng2 - lng1) * toRad;
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1 * toRad) * Math.cos(lat2 * toRad) * Math.sin(dLng / 2) ** 2;
  return 2 * EARTH_RADIUS_M * Math.asin(Math.sqrt(a));
}

// ─── Linear interpolation along a segment ───────────────────────────────────

function interpolateSegment(p1, p2, maxGap) {
  const dist = haversineM(p1.lat, p1.lng, p2.lat, p2.lng);
  if (dist <= maxGap) return [p1];

  const steps = Math.ceil(dist / maxGap);
  const pts = [];
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

function interpolateRoute(routePoints, maxGap = MAX_GAP_M) {
  if (routePoints.length === 0) return [];
  if (routePoints.length === 1) return [routePoints[0]];

  const out = [];
  for (let i = 0; i < routePoints.length - 1; i++) {
    const seg = interpolateSegment(routePoints[i], routePoints[i + 1], maxGap);
    for (let j = 0; j < seg.length; j++) out.push(seg[j]);
  }
  // always include the last point
  out.push(routePoints[routePoints.length - 1]);
  return out;
}

// ─── Public API ─────────────────────────────────────────────────────────────

/**
 * Convert a single lat/lng to its H3 cell index.
 * @param {number} lat
 * @param {number} lng
 * @param {number} [resolution=9]
 * @returns {string} H3 index
 */
function latLngToH3Cell(lat, lng, resolution = DEFAULT_RES) {
  return h3.latLngToCell(lat, lng, resolution);
}

/**
 * Build an H3 corridor from an OSRM-decoded route.
 *
 * @param {Array<{lat: number, lng: number}>} routePoints
 * @param {number} [resolution=9]  H3 resolution (default 9, ~174 m edge)
 * @returns {string[]} Unique array of H3 index strings forming the corridor
 */
function buildH3Corridor(routePoints, resolution = DEFAULT_RES) {
  if (!routePoints || routePoints.length === 0) return [];

  // 1. Interpolate so no gap > ~50 m
  const dense = interpolateRoute(routePoints);

  // 2 + 3. Convert to H3 cells and expand with k=1 ring, collecting into a Set
  const cellSet = new Set();

  for (let i = 0; i < dense.length; i++) {
    const center = h3.latLngToCell(dense[i].lat, dense[i].lng, resolution);
    if (!cellSet.has(center)) {
      cellSet.add(center);
      // k-ring at k=1 gives the center cell + 6 neighbours
      const ring = h3.gridDisk(center, 1);
      for (let j = 0; j < ring.length; j++) {
        cellSet.add(ring[j]);
      }
    }
  }

  // 4 + 5. cellSet is already deduplicated — return as array
  return Array.from(cellSet);
}

/**
 * Check whether an H3 index falls inside a pre-built corridor.
 *
 * @param {string} h3Index
 * @param {Set<string>} corridorSet  A Set created from buildH3Corridor output
 * @returns {boolean}
 */
function isInCorridor(h3Index, corridorSet) {
  return corridorSet.has(h3Index);
}

module.exports = {
  buildH3Corridor,
  latLngToH3Cell,
  isInCorridor,
};

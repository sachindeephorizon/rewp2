import type { Request } from "express";
import type { RedisClientType } from "redis";

// ── JWT / Auth ──────────────────────────────────────────────────────

export interface JwtPayload {
  id: number;
  email: string;
  name: string;
}

export interface AuthenticatedRequest extends Request {
  user: JwtPayload;
}

// ── GPS / Location ──────────────────────────────────────────────────

export interface LatLng {
  lat: number;
  lng: number;
}

export interface ProcessedLocation {
  latitude: number;
  longitude: number;
  timestamp: number;
}

export interface KalmanState {
  x: number[] | null;
  v: number[];
  P: number;
  Q: number;
  R: number;
  stationaryCount: number;
}

export interface GpsUserState {
  prev: ProcessedLocation | null;
  kalman: import("./utils/gps").KalmanFilter2D;
  filterStreak: number;
}

// ── Stream Metadata ─────────────────────────────────────────────────

export interface StreamMetadataInput {
  userId: string | number | null | undefined;
  sessionId?: string | number | null;
  rideChannel?: string | null;
  driverId?: string | number | null;
}

export interface StreamMetadata {
  userId: string;
  driverId: string;
  sessionId: string | null;
  rideChannel: string | null;
  streamKey: string;
  roomNames: string[];
}

// ── Location Payload (published via Redis Pub/Sub) ──────────────────

export interface LocationPayload {
  event: string;
  userId: string;
  driverId: string;
  sessionId: string | null;
  streamKey: string;
  rideChannel: string | null;
  lat: number;
  lng: number;
  speed: number | null;
  accuracy: number | null;
  heading: number | null;
  moving: boolean | null;
  distance: number | null;
  activity: string | null;
  source: string | null;
  appState: string | null;
  sequence: number | null;
  gpsIntervalMs: number | null;
  timestamp: string;
  // Client's GPS-fix epoch ms (forwarded from body.timestamp). Used by the
  // socket layer to drop out-of-order publishes — Android batches BG
  // location updates, so a foreground ping with the latest fix can race a
  // background ping carrying older fixes from the same batch. Without an
  // independent client timestamp, server receipt order misorders them and
  // the dashboard dot bounces between old and new positions.
  gpsTimestamp: number | null;
  startedAt: string;
  roomNames: string[];
  h3Cell?: string;
}

// ── Ping Request Body ───────────────────────────────────────────────

export interface PingBody {
  lat: number;
  lng: number;
  accuracy?: number;
  timestamp?: number;
  speed?: number;
  heading?: number;
  moving?: boolean;
  distance?: number;
  activity?: string;
  source?: string;
  appState?: string;
  sequence?: number;
  gpsIntervalMs?: number;
  sessionId?: string;
  rideChannel?: string;
  driverId?: string;
}

// ── Session Meta (stored in Redis) ──────────────────────────────────

export interface SessionMeta {
  userId: string;
  driverId: string;
  sessionId: string | null;
  streamKey: string;
  rideChannel: string | null;
  roomNames: string[];
  startedAt: string;
  latestTimestamp: string;
  appState: string | null;
  source: string | null;
  gpsIntervalMs: number | null;
}

// ── Destination Data (stored in Redis) ──────────────────────────────

export interface DestinationData {
  origin: LatLng;
  destination: LatLng;
  name: string | null;
  distance: number;
  duration: number;
  routePointCount: number;
  innerCellCount: number;
  outerCellCount: number;
  setAt: string;
}

// ── Deviation Alert ─────────────────────────────────────────────────

export interface DeviationAlert {
  userId: string;
  lat: number;
  lng: number;
  h3Cell: string;
  zone: string;
  consecutive: number;
  destinationName: string | null;
  detectedAt: string;
}

// ── Snap Result ─────────────────────────────────────────────────────

export interface SnapResult {
  lat: number;
  lng: number;
  snapped: boolean;
}

// ── OSRM Route Result ───────────────────────────────────────────────

export interface OsrmRouteResult {
  route: LatLng[];
  distance: number;
  duration: number;
}

// ── Nominatim Address ───────────────────────────────────────────────

export interface NominatimAddress {
  road?: string;
  neighbourhood?: string;
  suburb?: string;
  city_district?: string;
  hamlet?: string;
  village?: string;
  city?: string;
  town?: string;
  state_district?: string;
  county?: string;
  state?: string;
  [key: string]: string | undefined;
}

// ── Redis client type alias ─────────────────────────────────────────

export type AppRedisClient = RedisClientType;

import { Server } from "socket.io";
import { createAdapter } from "@socket.io/redis-adapter";
import { subscriber, ioPub, ioSub } from "./redis";
import {
  CHANNEL,
  GLOBAL_EMIT_INTERVAL_MS,
  SOCKET_GLOBAL_EVENT,
  SOCKET_STREAM_EVENT,
  SOCKET_STOP_EVENT,
  SOC_ROOM,
  SOC_ACK_EVENT,
} from "./config";
import { buildStreamMetadata, normalizeToken } from "./utils/stream";
import type { Server as HttpServer } from "http";
import {
  flushPendingSocEventsTo,
  markSocEventAcked,
} from "./services/soc.dispatch.service";

// Module-level singleton so non-socket modules (e.g. the SOC dispatcher)
// can emit without plumbing `io` through function args.
let ioInstance: Server | null = null;
export function getIo(): Server | null {
  return ioInstance;
}

interface LocationData {
  userId?: string;
  sessionId?: string;
  rideChannel?: string;
  driverId?: string;
  stopped?: boolean;
  event?: string;
  roomNames?: string[];
  [key: string]: unknown;
}

export function initSocket(httpServer: HttpServer): Server {
  const io = new Server(httpServer, {
    cors: {
      origin: "*",
      methods: ["GET", "POST"],
    },
    pingTimeout: 30000,
    pingInterval: 25000,
    transports: ["websocket"],
  });

  io.adapter(createAdapter(ioPub, ioSub));
  ioInstance = io;
  console.log("[Socket.io] Redis adapter attached (horizontal scaling ready)");

  io.on("connection", (socket) => {
    console.log(`[Socket.io] Client connected | id=${socket.id}`);

    // SOC dashboard join — on connect, flush every undelivered event as a
    // backlog batch. This is how "SOC was down, now back up" recovers:
    // events piled up in soc_events; the first fresh socket to join drains.
    socket.on("subscribe:soc", async (payload: { agentId?: string } = {}) => {
      const agentId = normalizeToken(payload.agentId ?? null, null);
      socket.join(SOC_ROOM);
      socket.emit("soc:subscribed", { room: SOC_ROOM, agentId });
      try {
        await flushPendingSocEventsTo(socket, agentId);
      } catch (err) {
        console.error("[SOC] backlog flush failed:", (err as Error).message);
      }
    });

    socket.on("unsubscribe:soc", () => {
      socket.leave(SOC_ROOM);
    });

    // Dashboard acks an event — stop retrying it.
    socket.on(SOC_ACK_EVENT, async (payload: { id?: string; agentId?: string } = {}) => {
      if (!payload?.id) return;
      try {
        await markSocEventAcked(payload.id, payload.agentId ?? null, "socket");
      } catch (err) {
        console.error("[SOC] ack failed:", (err as Error).message);
      }
    });

    const joinRoom = (room: string | null): void => {
      if (!room) return;
      socket.join(room);
      socket.emit("stream:subscribed", { room });
    };

    const leaveRoom = (room: string | null): void => {
      if (!room) return;
      socket.leave(room);
      socket.emit("stream:unsubscribed", { room });
    };

    socket.on("subscribe:stream", (payload: { streamKey?: string } = {}) => {
      joinRoom(normalizeToken(payload.streamKey ?? null, null));
    });

    socket.on("unsubscribe:stream", (payload: { streamKey?: string } = {}) => {
      leaveRoom(normalizeToken(payload.streamKey ?? null, null));
    });

    socket.on("subscribe:user", (payload: { userId?: string } = {}) => {
      const userId = normalizeToken(payload.userId ?? null, null);
      if (userId) joinRoom(`user:${userId}`);
    });

    socket.on("subscribe:session", (payload: { sessionId?: string } = {}) => {
      const sessionId = normalizeToken(payload.sessionId ?? null, null);
      if (sessionId) joinRoom(`session:${sessionId}`);
    });

    socket.on("subscribe:ride", (payload: { rideChannel?: string } = {}) => {
      joinRoom(normalizeToken(payload.rideChannel ?? null, null));
    });

    socket.on("disconnect", (reason: string) => {
      console.log(`[Socket.io] Client disconnected | id=${socket.id} reason=${reason}`);
    });
  });

  const lastGlobalEmitTime = new Map<string, number>();
  const pendingGlobalEmit = new Map<string, ReturnType<typeof setTimeout>>();

  const emitGlobalThrottled = (data: LocationData): void => {
    const userId = data.userId;
    if (!userId) {
      io.emit(SOCKET_GLOBAL_EVENT, data);
      return;
    }

    const now = Date.now();
    const lastTime = lastGlobalEmitTime.get(userId) || 0;
    const elapsed = now - lastTime;

    if (elapsed >= GLOBAL_EMIT_INTERVAL_MS) {
      lastGlobalEmitTime.set(userId, now);
      io.emit(SOCKET_GLOBAL_EVENT, data);
      return;
    }

    if (pendingGlobalEmit.has(userId)) clearTimeout(pendingGlobalEmit.get(userId));
    pendingGlobalEmit.set(userId, setTimeout(() => {
      lastGlobalEmitTime.set(userId, Date.now());
      pendingGlobalEmit.delete(userId);
      io.emit(SOCKET_GLOBAL_EVENT, data);
    }, GLOBAL_EMIT_INTERVAL_MS - elapsed));
  };

  const emitToStreamRooms = (data: LocationData, eventName: string): void => {
    const metadata = buildStreamMetadata({
      userId: data.userId,
      sessionId: data.sessionId,
      rideChannel: data.rideChannel,
      driverId: data.driverId,
    });

    metadata.roomNames.forEach((room) => {
      io.to(room).emit(eventName, { ...data, room });
    });
  };

  subscriber.subscribe(CHANNEL, (message: string) => {
    try {
      const data: LocationData = JSON.parse(message);

      if (data.event === "deviation_alert" || data.event === "inactivity_alert" || data.event === "arrival_detected") {
        const eventMap: Record<string, string> = {
          deviation_alert: "deviation:alert",
          inactivity_alert: "inactivity:alert",
          arrival_detected: "arrival:detected",
        };
        const socketEvent = eventMap[data.event];
        if (data.roomNames) {
          data.roomNames.forEach((room) => {
            io.to(room).emit(socketEvent, data);
          });
        }
        io.emit(socketEvent, data);
        return;
      }

      const eventName = data.stopped ? SOCKET_STOP_EVENT : SOCKET_STREAM_EVENT;
      emitToStreamRooms(data, eventName);
      emitGlobalThrottled(data);
    } catch (err) {
      console.error("[PubSub] Failed to parse message:", (err as Error).message);
    }
  });

  console.log(`[Socket.io] Listening for Pub/Sub on channel "${CHANNEL}"`);

  return io;
}

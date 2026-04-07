const { Server } = require("socket.io");
const { createAdapter } = require("@socket.io/redis-adapter");
const { subscriber, ioPub, ioSub } = require("./redis");
const {
  CHANNEL,
  GLOBAL_EMIT_INTERVAL_MS,
  SOCKET_GLOBAL_EVENT,
  SOCKET_STREAM_EVENT,
  SOCKET_STOP_EVENT,
} = require("./config");
const { buildStreamMetadata, normalizeToken } = require("./utils/stream");

function initSocket(httpServer) {
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
  console.log("[Socket.io] Redis adapter attached (horizontal scaling ready)");

  io.on("connection", (socket) => {
    console.log(`[Socket.io] Client connected | id=${socket.id}`);

    const joinRoom = (room) => {
      if (!room) return;
      socket.join(room);
      socket.emit("stream:subscribed", { room });
    };

    const leaveRoom = (room) => {
      if (!room) return;
      socket.leave(room);
      socket.emit("stream:unsubscribed", { room });
    };

    socket.on("subscribe:stream", (payload = {}) => {
      joinRoom(normalizeToken(payload.streamKey, null));
    });

    socket.on("unsubscribe:stream", (payload = {}) => {
      leaveRoom(normalizeToken(payload.streamKey, null));
    });

    socket.on("subscribe:user", (payload = {}) => {
      const userId = normalizeToken(payload.userId, null);
      if (userId) joinRoom(`user:${userId}`);
    });

    socket.on("subscribe:session", (payload = {}) => {
      const sessionId = normalizeToken(payload.sessionId, null);
      if (sessionId) joinRoom(`session:${sessionId}`);
    });

    socket.on("subscribe:ride", (payload = {}) => {
      joinRoom(normalizeToken(payload.rideChannel, null));
    });

    socket.on("disconnect", (reason) => {
      console.log(`[Socket.io] Client disconnected | id=${socket.id} reason=${reason}`);
    });
  });

  const lastGlobalEmitTime = new Map();
  const pendingGlobalEmit = new Map();

  const emitGlobalThrottled = (data) => {
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

  const emitToStreamRooms = (data, eventName) => {
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

  subscriber.subscribe(CHANNEL, (message) => {
    try {
      const data = JSON.parse(message);
      const eventName = data.stopped ? SOCKET_STOP_EVENT : SOCKET_STREAM_EVENT;
      emitToStreamRooms(data, eventName);
      emitGlobalThrottled(data);
    } catch (err) {
      console.error("[PubSub] Failed to parse message:", err.message);
    }
  });

  console.log(`[Socket.io] Listening for Pub/Sub on channel "${CHANNEL}"`);

  return io;
}

module.exports = { initSocket };

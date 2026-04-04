/**
 * ═══════════════════════════════════════════════════════════════════
 *  Redis Stream setup — creates stream + consumer group on startup.
 *  Called once during server bootstrap.
 * ═══════════════════════════════════════════════════════════════════
 */
const { redis } = require("./redis");
const { STREAM_NAME, CONSUMER_GROUP } = require("./config");

async function initStream() {
  try {
    // Create consumer group (and stream if it doesn't exist).
    // MKSTREAM creates the stream automatically.
    // "0" means start reading from the beginning for new consumers.
    await redis.xGroupCreate(STREAM_NAME, CONSUMER_GROUP, "0", { MKSTREAM: true });
    console.log(`[Stream] Created group "${CONSUMER_GROUP}" on stream "${STREAM_NAME}"`);
  } catch (err) {
    // BUSYGROUP = group already exists — safe to ignore
    if (err.message && err.message.includes("BUSYGROUP")) {
      console.log(`[Stream] Group "${CONSUMER_GROUP}" already exists — ok`);
    } else {
      console.error("[Stream] Failed to create group:", err.message);
      throw err;
    }
  }
}

module.exports = { initStream };

/**
 * ═══════════════════════════════════════════════════════════════════
 *  Cluster Mode — spawns one worker per CPU core
 *  Each worker runs its own Express + Socket.io instance.
 *  Redis Pub/Sub + @socket.io/redis-adapter keeps them in sync.
 * ═══════════════════════════════════════════════════════════════════
 */

import cluster from "cluster";
import os from "os";

const NUM_WORKERS = parseInt(process.env.WORKERS || "", 10) || os.cpus().length;

if (cluster.isPrimary) {
  console.log(`[Cluster] Primary ${process.pid} starting ${NUM_WORKERS} workers...`);

  for (let i = 0; i < NUM_WORKERS; i++) {
    cluster.fork();
  }

  cluster.on("exit", (worker, code) => {
    console.log(`[Cluster] Worker ${worker.process.pid} died (code ${code}). Restarting...`);
    cluster.fork();
  });
} else {
  require("./src/index");
}

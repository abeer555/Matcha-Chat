/**
 * Matcha Chat – Ephemeral WebSocket Relay Server
 *
 * Zero database. Zero persistence. Rooms live in memory and
 * are destroyed the instant the last user disconnects.
 *
 * Usage:  node server.js
 * Env:    PORT (default 3000)
 */

const http = require("http");
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const { WebSocketServer } = require("ws");

/**
 * rooms:       Map<roomKey, Map<ws, { username }>>
 * usernameMap: Map<roomKey, Map<username, ws>>   — for direct (peer-to-peer) signaling
 */
const rooms = new Map();
const usernameMap = new Map();

function hashRoom(channel, password) {
  return crypto
    .createHash("sha256")
    .update(`${channel}::${password}`)
    .digest("hex");
}

/** Broadcast to every socket in the room except the optional excluded one. */
function broadcast(roomKey, data, exclude) {
  const room = rooms.get(roomKey);
  if (!room) return;
  const msg = JSON.stringify(data);
  for (const [ws] of room) {
    if (ws !== exclude && ws.readyState === 1) ws.send(msg);
  }
}

/**
 * Send directly to a specific user by username.
 * The server injects `from` so the receiver knows who sent it.
 */
function sendToUser(roomKey, senderName, targetName, data) {
  const umap = usernameMap.get(roomKey);
  if (!umap) return;
  const target = umap.get(targetName);
  if (!target || target.readyState !== 1) return;
  target.send(JSON.stringify({ ...data, from: senderName }));
}

// ── HTTP Server ──────────────────────────────────────────────────────

const PORT = process.env.PORT || 3000;

const server = http.createServer((req, res) => {
  // Serve the chat HTML
  if (req.url === "/" || req.url === "/index.html") {
    const filePath = path.join(__dirname, "index.html");
    fs.readFile(filePath, (err, data) => {
      if (err) {
        res.writeHead(500);
        res.end("Error");
        return;
      }
      res.writeHead(200, { "Content-Type": "text/html" });
      res.end(data);
    });
    return;
  }
  res.writeHead(404);
  res.end("Not Found");
});

// ── WebSocket Server ─────────────────────────────────────────────────

const wss = new WebSocketServer({ server });

// ── Heartbeat ────────────────────────────────────────────────────────
// Ping every client every 30 s.  If a client doesn't respond with pong,
// terminate it to prevent ghost connections from accumulating.
const heartbeatInterval = setInterval(() => {
  for (const ws of wss.clients) {
    if (!ws.isAlive) {
      ws.terminate();
      continue;
    }
    ws.isAlive = false;
    ws.ping();
  }
}, 30_000);

wss.on("close", () => clearInterval(heartbeatInterval));

wss.on("connection", (ws, req) => {
  ws.isAlive = true;
  ws.on("pong", () => {
    ws.isAlive = true;
  });

  const url = new URL(req.url, `http://${req.headers.host}`);
  const channel = url.searchParams.get("channel");
  const password = url.searchParams.get("password");
  const username = url.searchParams.get("username");

  if (!channel || !password || !username) {
    ws.close();
    return;
  }

  const roomKey = hashRoom(channel, password);

  // Ensure room data structures exist
  if (!rooms.has(roomKey)) rooms.set(roomKey, new Map());
  if (!usernameMap.has(roomKey)) usernameMap.set(roomKey, new Map());

  const room = rooms.get(roomKey);
  const umap = usernameMap.get(roomKey);

  // Evict any ghost connection using the same username
  if (umap.has(username)) {
    const ghost = umap.get(username);
    ghost.terminate();
  }

  room.set(ws, { username });
  umap.set(username, ws);

  console.log(
    `[+] ${username} joined #${channel} (room ${roomKey.slice(0, 8)}…) — ${room.size} user(s)`,
  );

  // Tell the new user who's already in the room
  const existingUsers = [];
  for (const [, info] of room) {
    if (info.username !== username) existingUsers.push(info.username);
  }
  ws.send(JSON.stringify({ type: "room_state", users: existingUsers }));

  // Tell everyone else that this user joined
  broadcast(roomKey, { type: "user_joined", username }, ws);

  // ── Message routing ────────────────────────────────────────────────
  ws.on("message", (data) => {
    try {
      const msg = JSON.parse(data.toString());

      // Chat: broadcast to everyone else in the room
      if (msg.type === "chat") {
        broadcast(roomKey, { type: "chat", username, text: msg.text, replyTo: msg.replyTo || null }, ws);
        return;
      }

      // File / photo: broadcast to everyone else in the room
      if (msg.type === "file") {
        broadcast(
          roomKey,
          {
            type: "file",
            username,
            filename: msg.filename,
            mimeType: msg.mimeType,
            size: msg.size,
            dataURL: msg.dataURL,
          },
          ws,
        );
        return;
      }

      // WebRTC + call signaling: point-to-point relay
      const ROUTED = new Set([
        "webrtc_offer",
        "webrtc_answer",
        "webrtc_ice",
        "call_request",
        "call_accepted",
        "call_declined",
        "call_ended",
      ]);

      if (ROUTED.has(msg.type) && msg.target) {
        sendToUser(roomKey, username, msg.target, {
          type: msg.type,
          payload: msg.payload, // undefined for call_request/accepted/etc — fine
        });
        return;
      }
    } catch (_) {
      /* ignore malformed JSON */
    }
  });

  // ── Cleanup on disconnect ──────────────────────────────────────────
  let cleanedUp = false;
  function cleanup() {
    if (cleanedUp) return;
    cleanedUp = true;

    const room = rooms.get(roomKey);
    if (!room) return;

    room.delete(ws);

    // Only remove from usernameMap if this ws is still the current entry
    // (a reconnect by the same username may have replaced it already)
    const umap = usernameMap.get(roomKey);
    if (umap && umap.get(username) === ws) umap.delete(username);

    console.log(
      `[-] ${username} left #${channel} (room ${roomKey.slice(0, 8)}…) — ${room.size} user(s)`,
    );

    if (room.size === 0) {
      rooms.delete(roomKey);
      usernameMap.delete(roomKey);
      console.log(
        `[x] Room #${channel} (${roomKey.slice(0, 8)}…) destroyed — zero users`,
      );
    } else {
      broadcast(roomKey, { type: "user_left", username });
    }
  }

  ws.on("close", cleanup);
  ws.on("error", cleanup);
});

server.listen(PORT, () => {
  console.log(`\n🍵 Matcha Chat server running on http://localhost:${PORT}\n`);
  console.log(`   No database. No logs. Rooms are temporary.\n`);
});

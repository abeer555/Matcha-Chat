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

/** Rooms: Map<roomKey, Map<ws, { username }>> */
const rooms = new Map();

function hashRoom(channel, password) {
  return crypto
    .createHash("sha256")
    .update(`${channel}::${password}`)
    .digest("hex");
}

function broadcast(roomKey, data, exclude) {
  const room = rooms.get(roomKey);
  if (!room) return;
  const msg = JSON.stringify(data);
  for (const [ws] of room) {
    if (ws !== exclude && ws.readyState === 1) {
      ws.send(msg);
    }
  }
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

wss.on("connection", (ws, req) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const channel = url.searchParams.get("channel");
  const password = url.searchParams.get("password");
  const username = url.searchParams.get("username");

  if (!channel || !password || !username) {
    ws.close();
    return;
  }

  const roomKey = hashRoom(channel, password);

  // Create room if it doesn't exist
  if (!rooms.has(roomKey)) {
    rooms.set(roomKey, new Map());
  }

  const room = rooms.get(roomKey);
  room.set(ws, { username });

  console.log(
    `[+] ${username} joined #${channel} (room ${roomKey.slice(0, 8)}…) — ${room.size} user(s)`,
  );

  // Tell the new user who's already in the room
  const existingUsers = [];
  for (const [otherWs, info] of room) {
    if (otherWs !== ws) existingUsers.push(info.username);
  }
  ws.send(JSON.stringify({ type: "room_state", users: existingUsers }));

  // Tell everyone else that this user joined
  broadcast(roomKey, { type: "user_joined", username }, ws);

  // Handle incoming messages
  ws.on("message", (data) => {
    try {
      const msg = JSON.parse(data.toString());
      if (msg.type === "chat") {
        broadcast(
          roomKey,
          {
            type: "chat",
            username,
            text: msg.text,
          },
          ws,
        );
      }
    } catch (e) {
      /* ignore bad json */
    }
  });

  // Cleanup on disconnect
  function cleanup() {
    const room = rooms.get(roomKey);
    if (!room) return;

    room.delete(ws);
    console.log(
      `[-] ${username} left #${channel} (room ${roomKey.slice(0, 8)}…) — ${room.size} user(s)`,
    );

    if (room.size === 0) {
      rooms.delete(roomKey);
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
  console.log(`   No database. No logs. Rooms are ephemeral.\n`);
});

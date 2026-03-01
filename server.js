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

// ── Tiny WebSocket server (no dependencies) ──────────────────────────
// Implements just enough of RFC 6455 to work for text frames.

const MAGIC = "258EAFA5-E914-47DA-95CA-5AB5-40AD6CE";
const GUID = "258EAFA5-E914-47DA-95CA-5AB5A40AD6CE";

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
      sendFrame(ws, msg);
    }
  }
}

function broadcastAll(roomKey, data) {
  broadcast(roomKey, data, null);
}

// ── WebSocket frame helpers ──────────────────────────────────────────

function sendFrame(socket, text) {
  const buf = Buffer.from(text, "utf8");
  let header;
  if (buf.length < 126) {
    header = Buffer.alloc(2);
    header[0] = 0x81; // FIN + text opcode
    header[1] = buf.length;
  } else if (buf.length < 65536) {
    header = Buffer.alloc(4);
    header[0] = 0x81;
    header[1] = 126;
    header.writeUInt16BE(buf.length, 2);
  } else {
    header = Buffer.alloc(10);
    header[0] = 0x81;
    header[1] = 127;
    header.writeBigUInt64BE(BigInt(buf.length), 2);
  }
  socket.write(Buffer.concat([header, buf]));
}

function parseFrames(buffer) {
  const frames = [];
  let offset = 0;

  while (offset < buffer.length) {
    if (offset + 2 > buffer.length) break;

    const firstByte = buffer[offset];
    const secondByte = buffer[offset + 1];
    const opcode = firstByte & 0x0f;
    const masked = (secondByte & 0x80) !== 0;
    let payloadLen = secondByte & 0x7f;
    offset += 2;

    if (payloadLen === 126) {
      if (offset + 2 > buffer.length) break;
      payloadLen = buffer.readUInt16BE(offset);
      offset += 2;
    } else if (payloadLen === 127) {
      if (offset + 8 > buffer.length) break;
      payloadLen = Number(buffer.readBigUInt64BE(offset));
      offset += 8;
    }

    let maskKey = null;
    if (masked) {
      if (offset + 4 > buffer.length) break;
      maskKey = buffer.slice(offset, offset + 4);
      offset += 4;
    }

    if (offset + payloadLen > buffer.length) break;
    const payload = buffer.slice(offset, offset + payloadLen);
    offset += payloadLen;

    if (masked) {
      for (let i = 0; i < payload.length; i++) {
        payload[i] ^= maskKey[i % 4];
      }
    }

    frames.push({ opcode, payload });
  }

  return { frames, remaining: buffer.slice(offset) };
}

// ── HTTP + WS Server ─────────────────────────────────────────────────

const PORT = process.env.PORT || 3000;

const server = http.createServer((req, res) => {
  // Serve the chat HTML
  if (
    req.url === "/" ||
    req.url === "/index.html" 
  ) {
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

server.on("upgrade", (req, socket, head) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const channel = url.searchParams.get("channel");
  const password = url.searchParams.get("password");
  const username = url.searchParams.get("username");

  if (!channel || !password || !username) {
    socket.destroy();
    return;
  }

  // WebSocket handshake
  const key = req.headers["sec-websocket-key"];
  const accept = crypto
    .createHash("sha1")
    .update(key + GUID)
    .digest("base64");

  socket.write(
    "HTTP/1.1 101 Switching Protocols\r\n" +
      "Upgrade: websocket\r\n" +
      "Connection: Upgrade\r\n" +
      `Sec-WebSocket-Accept: ${accept}\r\n` +
      "\r\n",
  );

  // Mark socket as open
  socket.readyState = 1;

  const roomKey = hashRoom(channel, password);

  // Create room if it doesn't exist
  if (!rooms.has(roomKey)) {
    rooms.set(roomKey, new Map());
  }

  const room = rooms.get(roomKey);
  room.set(socket, { username });

  console.log(
    `[+] ${username} joined #${channel} (room ${roomKey.slice(0, 8)}…) — ${room.size} user(s)`,
  );

  // Tell the new user who's already in the room
  const existingUsers = [];
  for (const [ws, info] of room) {
    if (ws !== socket) existingUsers.push(info.username);
  }
  sendFrame(
    socket,
    JSON.stringify({
      type: "room_state",
      users: existingUsers,
    }),
  );

  // Tell everyone else that this user joined
  broadcast(roomKey, { type: "user_joined", username }, socket);

  // Handle incoming data
  let buf = Buffer.alloc(0);

  socket.on("data", (data) => {
    buf = Buffer.concat([buf, data]);
    const { frames, remaining } = parseFrames(buf);
    buf = remaining;

    for (const frame of frames) {
      if (frame.opcode === 0x08) {
        // Close frame
        cleanup();
        socket.end();
        return;
      }
      if (frame.opcode === 0x09) {
        // Ping → Pong
        const pong = Buffer.alloc(2);
        pong[0] = 0x8a;
        pong[1] = 0x00;
        socket.write(pong);
        continue;
      }
      if (frame.opcode === 0x01) {
        // Text frame
        try {
          const msg = JSON.parse(frame.payload.toString("utf8"));
          if (msg.type === "chat") {
            broadcast(
              roomKey,
              {
                type: "chat",
                username,
                text: msg.text,
              },
              socket,
            );
          }
        } catch (e) {
          /* ignore bad json */
        }
      }
    }
  });

  function cleanup() {
    if (socket.readyState === 3) return; // already cleaned up
    socket.readyState = 3;
    const room = rooms.get(roomKey);
    if (!room) return;

    room.delete(socket);
    console.log(
      `[-] ${username} left #${channel} (room ${roomKey.slice(0, 8)}…) — ${room.size} user(s)`,
    );

    if (room.size === 0) {
      // Last person left → destroy room entirely (no traces)
      rooms.delete(roomKey);
      console.log(
        `[x] Room #${channel} (${roomKey.slice(0, 8)}…) destroyed — zero users`,
      );
    } else {
      broadcast(roomKey, { type: "user_left", username });
    }
  }

  socket.on("close", cleanup);
  socket.on("error", cleanup);
});

server.listen(PORT, () => {
  console.log(`\n🍵 Matcha Chat server running on http://localhost:${PORT}\n`);
  console.log(`   No database. No logs. Rooms are ephemeral.\n`);
});

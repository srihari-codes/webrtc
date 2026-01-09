require("dotenv").config();
const WebSocket = require("ws");

const HOST = process.env.HOST || "0.0.0.0";
const PORT = process.env.PORT || 8080;

const wss = new WebSocket.Server({ port: PORT });

// Room-based client tracking
const rooms = new Map(); // roomCode -> Set of WebSocket clients

wss.on("connection", (ws) => {
  console.log("Client connected");
  let currentRoom = null;

  ws.on("message", (msg) => {
    try {
      const data = JSON.parse(msg.toString());

      // Handle room join
      if (data.type === "join") {
        const roomCode = data.room;
        currentRoom = roomCode;

        // Create room if doesn't exist
        if (!rooms.has(roomCode)) {
          rooms.set(roomCode, new Set());
          console.log(`Room created: ${roomCode}`);
        }

        // Add client to room
        rooms.get(roomCode).add(ws);
        console.log(
          `Client joined room: ${roomCode} (${
            rooms.get(roomCode).size
          } clients)`
        );

        // Send join confirmation
        ws.send(JSON.stringify({ type: "joined", room: roomCode }));
        return;
      }

      // Forward message only to clients in same room
      if (currentRoom && rooms.has(currentRoom)) {
        rooms.get(currentRoom).forEach((client) => {
          if (client !== ws && client.readyState === WebSocket.OPEN) {
            client.send(msg.toString());
          }
        });
      }
    } catch (error) {
      console.error("Error handling message:", error);
    }
  });

  ws.on("close", () => {
    // Remove client from room
    if (currentRoom && rooms.has(currentRoom)) {
      rooms.get(currentRoom).delete(ws);
      console.log(
        `Client left room: ${currentRoom} (${
          rooms.get(currentRoom).size
        } clients remaining)`
      );

      // Delete empty rooms
      if (rooms.get(currentRoom).size === 0) {
        rooms.delete(currentRoom);
        console.log(`Room deleted: ${currentRoom}`);
      }
    }
    console.log("Client disconnected");
  });
});

console.log(`Signaling server running on ws://${HOST}:${PORT}`);
console.log(`Use this URL in frontend: ws://${HOST}:${PORT}`);

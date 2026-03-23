// Simple WebSocket echo server — sends back whatever it receives
import { WebSocketServer } from "ws";

const wss = new WebSocketServer({ port: 8080 });

wss.on("connection", (ws, req) => {
    console.log(`WS connected: ${req.url}`);

    ws.on("message", (data, isBinary) => {
        console.log(`Received: ${isBinary ? "[binary]" : data.toString()}`);
        ws.send(data, { binary: isBinary }); // echo back
    });

    ws.on("close", (code, reason) => {
        console.log(`WS closed: ${code} ${reason.toString()}`);
    });
});

console.log("WebSocket echo server on ws://localhost:8080");
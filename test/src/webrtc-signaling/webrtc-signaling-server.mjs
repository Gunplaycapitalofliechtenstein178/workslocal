// Minimal WebRTC signaling server — relays offers/answers/ICE between peers
import { WebSocketServer } from "ws";

const wss = new WebSocketServer({ port: 8080 });
const peers = new Map();

wss.on("connection", (ws, req) => {
    const url = new URL(req.url, "http://localhost");
    const peerId = url.searchParams.get("peerId") || crypto.randomUUID();

    console.log(`Peer connected: ${peerId}`);
    peers.set(peerId, ws);

    // Send peer their ID
    ws.send(JSON.stringify({ type: "id", peerId }));

    // Broadcast peer list to all
    broadcastPeerList();

    ws.on("message", (data) => {
        const msg = JSON.parse(data.toString());
        console.log(`Signal from ${peerId}: ${msg.type} → ${msg.target}`);

        // Forward signaling message to target peer
        const target = peers.get(msg.target);
        if (target && target.readyState === 1) {
            target.send(JSON.stringify({
                type: msg.type,
                from: peerId,
                data: msg.data,
            }));
        }
    });

    ws.on("close", () => {
        console.log(`Peer disconnected: ${peerId}`);
        peers.delete(peerId);
        broadcastPeerList();
    });
});

function broadcastPeerList() {
    const peerList = [...peers.keys()];
    const msg = JSON.stringify({ type: "peers", peers: peerList });
    for (const [, ws] of peers) {
        if (ws.readyState === 1) ws.send(msg);
    }
}

console.log("WebRTC signaling server on ws://localhost:8080");
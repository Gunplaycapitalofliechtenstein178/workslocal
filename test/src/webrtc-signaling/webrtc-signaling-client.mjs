// Simulates two WebRTC peers exchanging signaling through the tunnel
import WebSocket from "ws";

const TUNNEL_URL = "wss://ws-test.workslocal.exposed";

// Peer A
const peerA = new WebSocket(`${TUNNEL_URL}?peerId=alice`);
// Peer B
const peerB = new WebSocket(`${TUNNEL_URL}?peerId=bob`);

let aliceId, bobId;

peerA.on("open", () => console.log("Alice connected"));
peerB.on("open", () => console.log("Bob connected"));

peerA.on("message", (data) => {
    const msg = JSON.parse(data.toString());
    console.log(`Alice received: ${msg.type}`, msg.type === "peers" ? msg.peers : "");

    if (msg.type === "id") aliceId = msg.peerId;

    if (msg.type === "peers" && msg.peers.includes("bob")) {
        // Alice sends an SDP offer to Bob
        console.log("Alice sending offer to Bob...");
        peerA.send(JSON.stringify({
            type: "offer",
            target: "bob",
            data: {
                sdp: "v=0\r\no=- 123 2 IN IP4 127.0.0.1\r\n...(fake SDP)...",
                type: "offer",
            },
        }));
    }

    if (msg.type === "answer") {
        console.log("Alice received answer from Bob!");
        console.log("  SDP:", msg.data.sdp.slice(0, 50) + "...");
        console.log("\n WebRTC signaling exchange complete!");
        peerA.close();
        peerB.close();
        setTimeout(() => process.exit(0), 500);
    }
});

peerB.on("message", (data) => {
    const msg = JSON.parse(data.toString());
    console.log(`Bob received: ${msg.type}`, msg.type === "peers" ? msg.peers : "");

    if (msg.type === "id") bobId = msg.peerId;

    if (msg.type === "offer") {
        console.log("Bob received offer from Alice, sending answer...");
        peerB.send(JSON.stringify({
            type: "answer",
            target: "alice",
            data: {
                sdp: "v=0\r\no=- 456 2 IN IP4 127.0.0.1\r\n...(fake SDP answer)...",
                type: "answer",
            },
        }));
    }
});

peerA.on("error", (err) => console.error("Alice error:", err.message));
peerB.on("error", (err) => console.error("Bob error:", err.message));
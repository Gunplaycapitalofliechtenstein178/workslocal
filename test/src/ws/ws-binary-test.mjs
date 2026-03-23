import WebSocket from "ws";

const ws = new WebSocket("wss://ws-test.workslocal.exposed");

ws.on("open", () => {
    // Send text frame
    ws.send("text message");

    // Send binary frame (Uint8Array)
    const binary = new Uint8Array([0x00, 0x01, 0x02, 0xFF, 0xFE]);
    ws.send(binary);

    // Send JSON as text
    ws.send(JSON.stringify({ type: "test", binary: false }));
});

let messageCount = 0;
ws.on("message", (data, isBinary) => {
    messageCount++;

    if (isBinary) {
        const bytes = new Uint8Array(data);
        console.log(`Message ${messageCount} (binary): [${bytes.join(", ")}]`);
    } else {
        console.log(`Message ${messageCount} (text): ${data.toString()}`);
    }

    if (messageCount === 3) {
        console.log("\nBinary + text frames work");
        ws.close();
        process.exit(0);
    }
});



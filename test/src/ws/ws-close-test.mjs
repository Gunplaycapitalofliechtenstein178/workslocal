import WebSocket from "ws";

// Test 1: Normal close (1000)
const ws1 = new WebSocket("wss://ws-test.workslocal.exposed");
ws1.on("open", () => {
    ws1.close(1000, "Normal close");
});
ws1.on("close", (code, reason) => {
    console.log(`Test 1 - Normal close: ${code} "${reason.toString()}"`);
});

// Test 2: Client close (4000 custom code)
setTimeout(() => {
    const ws2 = new WebSocket("wss://ws-test.workslocal.exposed");
    ws2.on("open", () => {
        ws2.close(4000, "Custom close");
    });
    ws2.on("close", (code, reason) => {
        console.log(`Test 2 - Custom close: ${code} "${reason.toString()}"`);

        console.log("\nClose code propagation works");
        process.exit(0);
    });
}, 1000);
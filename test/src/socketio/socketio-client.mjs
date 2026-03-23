import { io } from "socket.io-client";

const socket = io("https://ws-test.workslocal.exposed", {
    transports: ["websocket"], // Force WebSocket (skip HTTP long-polling)
});

socket.on("connect", () => {
    console.log("Connected:", socket.id);
    socket.emit("chat", "Hello from tunnel!");
});

socket.on("chat", (msg) => {
    console.log("Received:", msg);
    socket.disconnect();
});

socket.on("disconnect", (reason) => {
    console.log("Disconnected:", reason);
    process.exit(0);
});

socket.on("connect_error", (err) => {
    console.error("Connection error:", err.message);
});
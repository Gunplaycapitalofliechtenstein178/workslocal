import { createServer } from "http";
import { Server } from "socket.io";

const httpServer = createServer();
const io = new Server(httpServer, {
    cors: { origin: "*" },
});

io.on("connection", (socket) => {
    console.log(`Socket.io client connected: ${socket.id}`);

    socket.on("chat", (msg) => {
        console.log(`Chat: ${msg}`);
        socket.emit("chat", `Server says: ${msg}`);
    });

    socket.on("disconnect", (reason) => {
        console.log(`Disconnected: ${reason}`);
    });
});

httpServer.listen(8080, () => {
    console.log("Socket.io server on http://localhost:8080");
});
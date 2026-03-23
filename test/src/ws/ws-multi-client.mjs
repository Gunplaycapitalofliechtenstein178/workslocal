import WebSocket from "ws";

const TUNNEL_URL = "wss://ws-test.workslocal.exposed";
const NUM_CLIENTS = 5;
let completed = 0;

for (let i = 0; i < NUM_CLIENTS; i++) {
  const ws = new WebSocket(TUNNEL_URL);

  ws.on("open", () => {
    ws.send(`Hello from client ${i}`);
  });

  ws.on("message", (data) => {
    console.log(`Client ${i} echo: ${data.toString()}`);
    completed++;
    ws.close();

    if (completed === NUM_CLIENTS) {
      console.log(`\n All ${NUM_CLIENTS} clients completed`);
      process.exit(0);
    }
  });

  ws.on("error", (err) => {
    console.error(`Client ${i} error: ${err.message}`);
  });
}
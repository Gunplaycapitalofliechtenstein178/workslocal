const ws = new WebSocket('wss://ws-test.workslocal.exposed');
ws.onopen = () => {
  console.log('Connected');
  ws.send('hello');
  ws.send(JSON.stringify({ type: 'test', data: 123 }));
};
ws.onmessage = (e) => console.log('Echo:', e.data);
ws.onclose = (e) => console.log('Closed:', e.code);
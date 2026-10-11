// Server-Sent Events hub: the server pushes, browsers listen. Requests from the
// browser go through plain JSON POSTs, so no WebSocket library is needed.

export class EventHub {
  #clients = new Set();

  constructor({ heartbeatMs = 25_000 } = {}) {
    // The heartbeat also re-checks each session: an expired, signed-out or
    // removed operator stops receiving events.
    this.heartbeat = setInterval(() => {
      for (const client of this.#clients) {
        if (client.isValid && !client.isValid()) this.#drop(client);
        else client.res.write(': ping\n\n');
      }
    }, heartbeatMs);
    this.heartbeat.unref?.();
  }

  #drop(client) {
    this.#clients.delete(client);
    client.res.end();
  }

  // Ends the streams of the users that match, e.g. right after one is removed.
  disconnect(match) {
    for (const client of this.#clients) if (match(client.user)) this.#drop(client);
  }

  open(req, res, user = null, isValid = null) {
    res.writeHead(200, {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-cache, no-transform',
      connection: 'keep-alive',
      'x-accel-buffering': 'no',
    });
    res.write('retry: 3000\n\n');
    const client = { res, user, isValid };
    this.#clients.add(client);
    req.on('close', () => this.#clients.delete(client));
    return client;
  }

  sendTo(client, event, data) {
    client.res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  }

  // `filter(user)` limits delivery, e.g. to the operator who owns a call.
  send(event, data, filter = null) {
    const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
    for (const client of this.#clients) {
      if (!filter || filter(client.user)) client.res.write(payload);
    }
  }

  get size() {
    return this.#clients.size;
  }

  users() {
    return [...new Set([...this.#clients].map((client) => client.user).filter(Boolean))];
  }

  close() {
    clearInterval(this.heartbeat);
    for (const client of this.#clients) client.res.end();
    this.#clients.clear();
  }
}

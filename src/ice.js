// ICE servers handed to each browser. With TURN_SECRET the credentials are
// short-lived and per operator (coturn "use-auth-secret", TURN REST API).

import { createHmac } from 'node:crypto';

export function iceServersFor(config, user, now = Date.now()) {
  const servers = [...config.iceServers];
  const { urls, secret, username, password, ttlSeconds } = config.turn;
  if (urls.length && secret) {
    const name = `${Math.floor(now / 1000) + ttlSeconds}:${user}`;
    servers.push({ urls, username: name, credential: createHmac('sha1', secret).update(name).digest('base64') });
  } else if (urls.length && username) {
    servers.push({ urls, username, credential: password });
  }
  return servers;
}

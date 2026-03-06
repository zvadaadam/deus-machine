import { Hono } from 'hono';
import { getAllSettings, saveSetting, getSetting } from '../services/settings.service';
import { parseBody } from '../lib/validate';
import { SaveSettingBody } from '../lib/schemas';
import { connectToRelay, disconnectFromRelay } from '../services/relay.service';
import { getRelayCredentials, generateRelayCredentials } from '../services/auth.service';

const DEFAULT_RELAY_URL = "wss://relay.rundeus.com";

const app = new Hono();

app.get('/settings', (c) => {
  return c.json(getAllSettings());
});

app.post('/settings', async (c) => {
  const { key, value } = parseBody(SaveSettingBody, await c.req.json());
  saveSetting(key, value);

  // When remote access is toggled, connect/disconnect the relay tunnel.
  // Auto-provisions relay URL and credentials if missing.
  if (key === "remote_access_enabled") {
    if (value === true) {
      let relayUrl = getSetting("relay_url") as string | null;
      if (!relayUrl) {
        relayUrl = DEFAULT_RELAY_URL;
        saveSetting("relay_url", relayUrl);
      }
      let creds = getRelayCredentials();
      if (!creds) {
        creds = generateRelayCredentials();
      }
      connectToRelay(relayUrl, creds.serverId, creds.relayToken);
    } else {
      disconnectFromRelay();
    }
  }

  return c.json({ success: true, key, value });
});

export default app;

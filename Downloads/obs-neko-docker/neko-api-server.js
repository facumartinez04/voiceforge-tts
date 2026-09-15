// neko-api-server.js
//
// Small authenticated HTTP API that wraps provision-neko-obs.sh /
// list-neko-instances.sh / docker compose, so your own backend can
// create/start/stop/remove Neko+OBS instances over HTTP instead of SSHing
// in and running the scripts by hand.
//
// Every request (except GET /health and POST /auth/login) needs:
//   Authorization: Bearer <API_TOKEN>              -- legacy static token (existing
//                                                      integrations: config-panel.html,
//                                                      instance-control.html, irlsystem)
//   Authorization: Bearer <JWT from /auth/login>   -- new admin panel, per-admin login
//
// Setup:
//   npm install
//   export API_TOKEN="$(openssl rand -hex 32)"   # save this, your backend needs it
//   export NEKO_ADMIN_JWT_SECRET="$(openssl rand -hex 32)"  # for /auth/login JWTs
//   export SUPABASE_URL=... SUPABASE_SERVICE_ROLE_KEY=...   # same project as irlcontrol-backend
//   node neko-api-server.js
// (see neko-api.service for running this as a systemd service instead)
//
// First admin account: node create-admin.js <username> <password>
//
// Endpoints:
//   GET    /health                       -- no auth, liveness check
//   POST   /auth/login                   -- no auth (this IS the login). Body:
//                                            { username, password }. Returns { token }.
//   GET    /auth/me                      -- confirms a stored JWT is still valid
//   GET    /instances                    -- list all instances + status
//   POST   /instances                    -- create one. Body: { name, publicIp?,
//                                            webPort?, obsWsPort?, pluginWsPort?,
//                                            webrtcStart?, webrtcEnd?,
//                                            obsWsPassword?, pluginWsPassword?,
//                                            userPassword?, adminPassword? }
//                                            Only `name` is required -- everything
//                                            else auto-picks/generates same as the
//                                            CLI script.
//   POST   /instances/:name/start        -- starts a stopped instance (no rebuild)
//   POST   /instances/:name/stop         -- stops it (frees CPU/RAM, keeps config)
//   DELETE /instances/:name              -- removes it. ?keepVolume=true to keep
//                                            the persisted OBS config/scenes
//   GET    /config                       -- current RTMP/watch/video defaults
//   PUT    /config                       -- update them. Body: { rtmpServerUrl?,
//                                            streamKeyTemplate?, watchUrlTemplate?,
//                                            disconnectedVideoUrl?, idleStopMinutes?,
//                                            neverStreamedStopMinutes? }.
//                                            streamKeyTemplate and watchUrlTemplate
//                                            support {instance} and {key} placeholders.
//                                            idleStopMinutes: minutes a running,
//                                            NOT-streaming instance can go with no real
//                                            Neko mouse/keyboard activity before the
//                                            idle watchdog `docker compose stop`s it.
//                                            neverStreamedStopMinutes: backstop ceiling,
//                                            stops it after this long never having gone
//                                            live even if there IS Neko activity. Either
//                                            '0' disables that check; an active stream
//                                            always resets both and keeps it up.
//   GET    /instances/:name/noalbs       -- current NOALBS (auto scene switch) config + status
//   PUT    /instances/:name/noalbs       -- update it. Body is a PARTIAL NoalbsConfig --
//                                            only the fields you send are changed, e.g.
//                                            { enabled: false } just toggles it off.
//                                            Fields: enabled, statsUrl, statsFormat
//                                            ("NginxRtmpXml"|"JsonField"), application,
//                                            streamKey, jsonBitrateField, normalScene,
//                                            lowScene, offlineScene, lowBitrateKbps,
//                                            pollIntervalMs, retryAttempts,
//                                            onlySwitchWhenStreaming.
'use strict';

const express = require('express');
const WebSocket = require('ws');
const { execFile } = require('child_process');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { login, requireAuth, logAudit } = require('./auth');

const PORT = process.env.API_PORT || 30800;
const TOKEN = process.env.API_TOKEN;
const SCRIPT_DIR = __dirname;
const REGISTRY_FILE = path.join(os.homedir(), '.neko-instances.tsv');
const CONFIG_FILE = path.join(os.homedir(), '.neko-config.env');
const INGEST_FILE = path.join(os.homedir(), '.neko-ingest.json');

function readIngestUrls() {
    try { return JSON.parse(fs.readFileSync(INGEST_FILE, 'utf8')); } catch { return {}; }
}
function writeIngestUrls(data) {
    fs.writeFileSync(INGEST_FILE, JSON.stringify(data, null, 2));
}
function getIngestUrl(name) {
    const data = readIngestUrls();
    return data[name] || '';
}
function setIngestUrl(name, url) {
    const data = readIngestUrls();
    if (url) {
        data[name] = url;
    } else {
        delete data[name];
    }
    writeIngestUrls(data);
}

const NAME_RE = /^[a-z0-9][a-z0-9_-]*$/;
// Must match gen-caddyfile.sh's own default (and CADDY_DOMAIN_SUFFIX env var,
// if you override it there -- override it here identically too).
const CADDY_DOMAIN_SUFFIX = process.env.CADDY_DOMAIN_SUFFIX || 'servidor.irlcontrol.run';

// Global defaults (RTMP ingest server, watch URL, disconnected-scene video)
// applied to every new instance unless overridden per-instance. Stored as a
// tiny shell-sourceable env file so provision-neko-obs.sh can `source` it
// directly when run by hand from the CLI, not just through this API.
const CONFIG_ENV_KEYS = {
    rtmpServerUrl: 'RTMP_SERVER_URL',
    streamKeyTemplate: 'STREAM_KEY_TEMPLATE',
    watchUrlTemplate: 'WATCH_URL_TEMPLATE',
    // Same idea as watchUrlTemplate, but for the MAIN stream's own watch
    // channel (shared across every instance -- streamKeyTemplate is a
    // fixed literal key now, not {instance}-based, so there's only one
    // "on air" slot at a time). Only {key} makes sense here, no {instance}.
    // Program Preview panels switch to this once the main stream goes
    // live, since the always-on low-res preview encoder stops at that
    // point (see obs-multi-rtmp.cpp) -- the main encode already covers it.
    mainWatchUrlTemplate: 'MAIN_WATCH_URL_TEMPLATE',
    // WHEP (WebRTC-HTTP Egress Protocol) URL for the same always-on
    // internal preview target, served by MediaMTX (RTMP-in/WebRTC-out,
    // fed via rtmp.conf's second `push` in the "ingest" app) instead of
    // nginx-rtmp's HLS -- sub-second latency instead of HLS's ~2-3s floor.
    // Same {key}/{instance} placeholders as watchUrlTemplate.
    webrtcWatchUrlTemplate: 'WEBRTC_WATCH_URL_TEMPLATE',
    // WebSocket + MPEG-TS URL for the same feed, served by THIS process's
    // own /mpegts/:key relay (see the WS upgrade handler near app.listen
    // below) instead of MediaMTX's WHEP. No ICE/DTLS/STUN/TURN negotiation
    // at all -- just a plain WebSocket, so connection setup is close to
    // instant (a client-side mpegts.js player, MSE-based) at the cost of a
    // bit more steady-state latency than WebRTC (~1-2s instead of
    // sub-second). Same {key}/{instance} placeholders as watchUrlTemplate.
    mpegtsWatchUrlTemplate: 'MPEGTS_WATCH_URL_TEMPLATE',
    disconnectedVideoUrl: 'DISCONNECTED_VIDEO_URL',
    idleStopMinutes: 'IDLE_STOP_MINUTES',
    neverStreamedStopMinutes: 'NEVER_STREAMED_STOP_MINUTES',
    webhookUrl: 'WEBHOOK_URL',
    webhookSecret: 'WEBHOOK_SECRET',
    webhookEnabled: 'WEBHOOK_ENABLED',
    webhookEventsEnabled: 'WEBHOOK_EVENTS_ENABLED',
    webhookAlertsEnabled: 'WEBHOOK_ALERTS_ENABLED',
};
const CONFIG_DEFAULTS = {
    rtmpServerUrl: 'rtmp://host.docker.internal:1935/ingest',
    streamKeyTemplate: '{instance}',
    watchUrlTemplate: '',
    mainWatchUrlTemplate: '',
    webrtcWatchUrlTemplate: '',
    mpegtsWatchUrlTemplate: '',
    disconnectedVideoUrl: '',
    // Minutes a RUNNING, NOT-STREAMING instance can go with no real
    // mouse/keyboard activity in Neko before the idle watchdog (see below)
    // stops its container -- docker compose stop, never `down -v`, so the
    // volume (OBS scenes/config) is never touched. '0' disables this check.
    idleStopMinutes: '15',
    // Backstop ceiling: even with ongoing Neko activity (someone poking
    // around but never actually starting the stream), stop after this many
    // minutes of never having gone live. '0' disables this check. Whichever
    // of the two limits is hit first wins; an active stream (outputActive)
    // always resets both and keeps the instance up regardless of either.
    neverStreamedStopMinutes: '40',
    webhookUrl: '',
    webhookSecret: 'wh_irl_k9G4mTzXp2sR7vBnQ8dF',
    webhookEnabled: 'true',
    webhookEventsEnabled: 'true',
    webhookAlertsEnabled: 'true',
};

function readGlobalConfig() {
    const cfg = { ...CONFIG_DEFAULTS };
    if (!fs.existsSync(CONFIG_FILE)) return cfg;
    const byEnvKey = {};
    for (const line of fs.readFileSync(CONFIG_FILE, 'utf8').split('\n')) {
        const m = line.match(/^([A-Z_]+)=(.*)$/);
        if (m) byEnvKey[m[1]] = m[2];
    }
    for (const [camel, envKey] of Object.entries(CONFIG_ENV_KEYS)) {
        if (byEnvKey[envKey] !== undefined) cfg[camel] = byEnvKey[envKey];
    }
    return cfg;
}

function writeGlobalConfig(partial) {
    const merged = { ...readGlobalConfig(), ...partial };
    const lines = Object.entries(CONFIG_ENV_KEYS).map(([camel, envKey]) => `${envKey}=${merged[camel] ?? ''}`);
    fs.writeFileSync(CONFIG_FILE, lines.join('\n') + '\n');
    return merged;
}

function renderTemplate(str, vars) {
    return String(str || '').replace(/\{(\w+)\}/g, (_, k) => (vars[k] !== undefined ? vars[k] : ''));
}

if (!TOKEN) {
    console.error('Error: API_TOKEN env var is required. Generate one with: openssl rand -hex 32');
    process.exit(1);
}

const app = express();
// Skip JSON body parsing for file upload route (needs raw stream)
app.use((req, res, next) => {
    if (req.method === 'POST' && /^\/instances\/[^/]+\/files$/.test(req.path)) return next();
    express.json()(req, res, next);
});

// Dashboard is a static HTML file (file:// or any origin) hitting this API
// directly from the browser -- needs CORS, including preflight for the
// Authorization header, or every fetch() fails with "Failed to fetch".
app.use((req, res, next) => {
    res.header('Access-Control-Allow-Origin', '*');
    res.header('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
    res.header('Access-Control-Allow-Headers', 'Content-Type, Authorization');
    if (req.method === 'OPTIONS') return res.sendStatus(204);
    next();
});

app.get('/health', (req, res) => res.json({ ok: true }));

// No auth: this IS the auth endpoint. Returns a JWT valid for 12h.
app.post('/auth/login', login);

app.use(requireAuth(TOKEN));

// Lets the frontend confirm a stored token is still valid on page load.
app.get('/auth/me', (req, res) => {
    res.json({ ok: true, admin: req.admin || null });
});

function run(cmd, args, timeoutMs = 20 * 60 * 1000, extraEnv = {}) {
    return new Promise((resolve, reject) => {
        const env = { ...process.env, ...extraEnv };
        execFile(cmd, args, { cwd: SCRIPT_DIR, timeout: timeoutMs, maxBuffer: 10 * 1024 * 1024, env }, (err, stdout, stderr) => {
            if (err) return reject(Object.assign(new Error(err.message), { stdout, stderr }));
            resolve({ stdout, stderr });
        });
    });
}

function validName(name) {
    return typeof name === 'string' && NAME_RE.test(name);
}

// Parses ~/.neko-instances.tsv into structured records (columns
// provision-neko-obs.sh appends: name, web, obs_ws, plugin_ws, webrtc_start,
// webrtc_end, user_pw, admin_pw, obs_ws_pw, plugin_ws_pw, ip, publicAlias).
function parseRegistryRows() {
    if (!fs.existsSync(REGISTRY_FILE)) return [];
    const cfg = readGlobalConfig();
    return fs.readFileSync(REGISTRY_FILE, 'utf8').split('\n').filter(Boolean).map((line) => {
        const [
            name, webPort, obsWsPort, pluginWsPort, webrtcStart, webrtcEnd,
            userPassword, adminPassword, obsWsPassword, pluginWsPassword, publicIp, publicAlias,
        ] = line.split('\t');
        const streamKey = renderTemplate(cfg.streamKeyTemplate, { instance: name });
        // The PUBLIC-facing subdomain -- rotates on every start (see POST
        // /instances/:name/start) so a previously shared Neko login link
        // (which embeds the admin password) stops resolving to anything
        // once the instance restarts. Falls back to the instance's own
        // name for registry rows written before this column existed.
        const host = publicAlias || name;
        return {
            name,
            publicAlias: host,
            publicIp,
            webPort: Number(webPort),
            obsWsPort: Number(obsWsPort),
            pluginWsPort: Number(pluginWsPort),
            webrtcStart: Number(webrtcStart),
            webrtcEnd: Number(webrtcEnd),
            userPassword,
            adminPassword,
            obsWsPassword,
            pluginWsPassword,
            panelUrl: `http://${publicIp}:${webPort}`,
            // Only real if Caddy's set up on this box (see gen-caddyfile.sh) --
            // harmless to include otherwise, it just won't resolve/serve.
            panelUrlHttps: `https://${host}.${CADDY_DOMAIN_SUFFIX}`,
            obsWsUrl: `ws://${publicIp}:${obsWsPort}`,
            pluginWsUrl: `ws://${publicIp}:${pluginWsPort}`,
            // Derived from the global RTMP config (~/.neko-config.env), not
            // stored in the registry -- always reflects the *current* config,
            // even for instances created before it was set.
            rtmpServerUrl: cfg.rtmpServerUrl,
            streamKey,
            watchUrl: renderTemplate(cfg.watchUrlTemplate, { key: streamKey, instance: name }) || getIngestUrl(name),
            ingestUrl: getIngestUrl(name),
            ingestWatchUrl: getIngestUrl(name),
            // Same underlying streamKey (a fixed shared literal, not
            // per-instance) -- this is the ONE "on air" channel every
            // instance's main stream shares, used by Program Preview once
            // that instance's own stream actually goes live.
            mainWatchUrl: renderTemplate(cfg.mainWatchUrlTemplate, { key: streamKey }),
            webrtcWatchUrl: renderTemplate(cfg.webrtcWatchUrlTemplate, { key: streamKey, instance: name }),
            mpegtsWatchUrl: renderTemplate(cfg.mpegtsWatchUrlTemplate, { key: streamKey, instance: name }),
        };
    });
}

function readInstanceRecord(name) {
    const rows = parseRegistryRows().filter((r) => r.name === name);
    return rows.length ? rows[rows.length - 1] : null;
}

// Generates a fresh random public subdomain for this instance and rewrites
// the registry's 12th column (see parseRegistryRows) in place, then
// regenerates + reloads Caddy so the OLD alias stops resolving anywhere and
// the new one starts working immediately. Called on every /start so a
// previously shared Neko login link (which embeds the admin password) goes
// dead once the instance restarts, instead of staying valid forever.
function rotatePublicAlias(name) {
    if (!fs.existsSync(REGISTRY_FILE)) return null;
    const crypto = require('crypto');
    const newAlias = `${name}-${crypto.randomBytes(3).toString('hex')}`;
    const lines = fs.readFileSync(REGISTRY_FILE, 'utf8').split('\n');
    let found = false;
    const updated = lines.map((line) => {
        if (!line) return line;
        const cols = line.split('\t');
        if (cols[0] !== name) return line;
        found = true;
        while (cols.length < 12) cols.push('');
        cols[11] = newAlias;
        return cols.join('\t');
    });
    if (!found) return null;
    fs.writeFileSync(REGISTRY_FILE, updated.join('\n'));
    return newAlias;
}

// Talks to obs-multi-rtmp's own WebSocket server (NOT obs-websocket) --
// same protocol as create-scenes.py: no Hello/Identify handshake, auth is a
// "?password=..." query string, requests/responses are flat JSON objects
// with a "command" field (see src/obs-multi-rtmp/src/websocket-server.cpp's
// GetNoalbsConfig/SetNoalbsConfig/GetNoalbsStatus handlers). The API server
// runs on the same host as every instance's container, so the plugin's port
// is always reachable via 127.0.0.1.
function callPluginWs(port, password, command, data = {}, timeoutMs = 8000) {
    return new Promise((resolve, reject) => {
        const url = `ws://127.0.0.1:${port}/` + (password ? `?password=${encodeURIComponent(password)}` : '');
        const ws = new WebSocket(url, { perMessageDeflate: false });
        const messageId = Math.random().toString(36).slice(2, 10);
        const timer = setTimeout(() => {
            ws.terminate();
            reject(new Error('timeout talking to obs-multi-rtmp plugin'));
        }, timeoutMs);

        ws.on('open', () => {
            ws.send(JSON.stringify({ command, message_id: messageId, ...data }));
        });
        ws.on('message', (raw) => {
            let msg;
            try { msg = JSON.parse(raw.toString()); } catch { return; }
            if (msg.message_id !== messageId) return;
            clearTimeout(timer);
            ws.close();
            resolve(msg);
        });
        ws.on('error', (err) => {
            clearTimeout(timer);
            reject(err);
        });
    });
}

function readNoalbsFromIni(name) {
    const base = `/var/lib/docker/volumes/neko-${name}_obs_config/_data/basic/profiles`;
    if (!fs.existsSync(base)) return null;
    try {
        const profiles = fs.readdirSync(base);
        for (const prof of profiles) {
            const p = path.join(base, prof, 'basic.ini');
            if (fs.existsSync(p)) {
                const text = fs.readFileSync(p, 'utf8');
                const m = text.match(/\[obs-multi-rtmp-noalbs\]([\s\S]*?)(?:\n\[|$)/);
                if (!m) return { enabled: false, statsUrl: '' };
                const sec = m[1];
                const enMatch = sec.match(/^Enabled=(.*)$/m);
                const urlMatch = sec.match(/^StatsUrl=(.*)$/m);
                return {
                    enabled: enMatch ? enMatch[1].trim().toLowerCase() === 'true' : false,
                    statsUrl: urlMatch ? urlMatch[1].trim() : '',
                };
            }
        }
    } catch (e) {
        return null;
    }
    return null;
}

function writeNoalbsToIni(name, partial = {}) {
    const base = `/var/lib/docker/volumes/neko-${name}_obs_config/_data/basic/profiles`;
    if (!fs.existsSync(base)) return false;
    try {
        const profiles = fs.readdirSync(base);
        for (const prof of profiles) {
            const p = path.join(base, prof, 'basic.ini');
            if (fs.existsSync(p)) {
                let text = fs.readFileSync(p, 'utf8');
                if (!text.includes('[obs-multi-rtmp-noalbs]')) {
                    text += '\n[obs-multi-rtmp-noalbs]\n';
                }
                if (partial.enabled !== undefined) {
                    const val = partial.enabled ? 'true' : 'false';
                    if (/^Enabled=.*$/m.test(text)) {
                        text = text.replace(/^Enabled=.*$/m, `Enabled=${val}`);
                    } else {
                        text = text.replace(/\[obs-multi-rtmp-noalbs\]/, `[obs-multi-rtmp-noalbs]\nEnabled=${val}`);
                    }
                }
                if (partial.statsUrl !== undefined) {
                    const val = String(partial.statsUrl).trim();
                    if (/^StatsUrl=.*$/m.test(text)) {
                        text = text.replace(/^StatsUrl=.*$/m, `StatsUrl=${val}`);
                    } else {
                        text = text.replace(/\[obs-multi-rtmp-noalbs\]/, `[obs-multi-rtmp-noalbs]\nStatsUrl=${val}`);
                    }
                }
                fs.writeFileSync(p, text, 'utf8');
                return true;
            }
        }
    } catch (e) {
        return false;
    }
    return false;
}

async function getNoalbsQuick(name, instance, dockerStat) {
    if (/up|running/i.test(dockerStat)) {
        try {
            const res = await callPluginWs(instance.pluginWsPort, instance.pluginWsPassword, 'GetNoalbsConfig', {}, 1000);
            if (res && res.config) {
                return {
                    enabled: Boolean(res.config.enabled),
                    statsUrl: res.config.statsUrl || '',
                };
            }
        } catch (e) {}
    }
    const fromDisk = readNoalbsFromIni(name);
    if (fromDisk) return fromDisk;
    return { enabled: false, statsUrl: '' };
}

// Raw obs-websocket v5 client (Hello/Identify/Request) used only by the
// idle watchdog below, to check GetStreamStatus.outputActive without
// pulling in the full obs-websocket-js package for one request. Node's
// built-in crypto covers the SHA256 challenge -- no need for the pure-JS
// implementation the browser-side clients use (this runs server-side).
function getObsStreamStatus(port, password) {
    const crypto = require('crypto');
    const sha256b64 = (s) => crypto.createHash('sha256').update(s).digest('base64');

    return new Promise((resolve, reject) => {
        const ws = new WebSocket(`ws://127.0.0.1:${port}`);
        const requestId = Math.random().toString(36).slice(2, 10);
        const timer = setTimeout(() => { ws.terminate(); reject(new Error('timeout talking to obs-websocket')); }, 8000);

        ws.on('message', (raw) => {
            let msg;
            try { msg = JSON.parse(raw.toString()); } catch { return; }
            if (msg.op === 0) {
                const d = msg.d;
                const identify = { op: 1, d: { rpcVersion: 1 } };
                if (d.authentication) {
                    const secret = sha256b64((password || '') + d.authentication.salt);
                    identify.d.authentication = sha256b64(secret + d.authentication.challenge);
                }
                ws.send(JSON.stringify(identify));
            } else if (msg.op === 2) {
                ws.send(JSON.stringify({ op: 6, d: { requestType: 'GetStreamStatus', requestId, requestData: {} } }));
            } else if (msg.op === 7 && msg.d.requestId === requestId) {
                clearTimeout(timer);
                ws.close();
                resolve(msg.d.responseData || {});
            }
        });
        ws.on('error', (err) => { clearTimeout(timer); reject(err); });
    });
}

// Generic single-request obs-websocket v5 client, same Hello/Identify
// handshake as getObsStreamStatus above -- used by the ingest endpoint
// below (SetInputSettings on "Ingest Player") so it doesn't need its own
// copy of the auth dance.
function obsRequest(port, password, requestType, requestData = {}) {
    const crypto = require('crypto');
    const sha256b64 = (s) => crypto.createHash('sha256').update(s).digest('base64');

    return new Promise((resolve, reject) => {
        const ws = new WebSocket(`ws://127.0.0.1:${port}`);
        const requestId = Math.random().toString(36).slice(2, 10);
        const timer = setTimeout(() => { ws.terminate(); reject(new Error('timeout talking to obs-websocket')); }, 8000);

        ws.on('message', (raw) => {
            let msg;
            try { msg = JSON.parse(raw.toString()); } catch { return; }
            if (msg.op === 0) {
                const d = msg.d;
                const identify = { op: 1, d: { rpcVersion: 1 } };
                if (d.authentication) {
                    const secret = sha256b64((password || '') + d.authentication.salt);
                    identify.d.authentication = sha256b64(secret + d.authentication.challenge);
                }
                ws.send(JSON.stringify(identify));
            } else if (msg.op === 2) {
                ws.send(JSON.stringify({ op: 6, d: { requestType, requestId, requestData } }));
            } else if (msg.op === 7 && msg.d.requestId === requestId) {
                clearTimeout(timer);
                ws.close();
                if (msg.d.requestStatus && msg.d.requestStatus.result === false) {
                    reject(new Error(msg.d.requestStatus.comment || `${requestType} failed`));
                } else {
                    resolve(msg.d.responseData || {});
                }
            }
        });
        ws.on('error', (err) => { clearTimeout(timer); reject(err); });
    });
}

// In-memory cache for delta bitrate and skipped-frame calculation
const monitorHistory = new Map();

// High-speed parallel metrics fetcher from obs-websocket v5
function getObsFullMetrics(port, password, timeoutMs = 2500) {
    const crypto = require('crypto');
    const sha256b64 = (s) => crypto.createHash('sha256').update(s).digest('base64');

    return new Promise((resolve) => {
        let ws;
        let settled = false;
        const finish = (result) => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            if (ws) {
                try { ws.removeAllListeners(); ws.terminate(); } catch {}
            }
            resolve(result);
        };

        const timer = setTimeout(() => {
            finish(null);
        }, timeoutMs);

        try {
            ws = new WebSocket(`ws://127.0.0.1:${port}`);
        } catch (e) {
            return finish(null);
        }

        const pendingRequests = new Map();
        const results = {};

        ws.on('open', () => {});
        ws.on('error', () => finish(null));
        ws.on('close', () => finish(Object.keys(results).length > 0 ? results : null));

        ws.on('message', (raw) => {
            let msg;
            try { msg = JSON.parse(raw.toString()); } catch { return; }

            if (msg.op === 0) {
                // Hello handshake
                const d = msg.d;
                const identify = { op: 1, d: { rpcVersion: 1 } };
                if (d.authentication) {
                    const secret = sha256b64((password || '') + d.authentication.salt);
                    identify.d.authentication = sha256b64(secret + d.authentication.challenge);
                }
                ws.send(JSON.stringify(identify));
            } else if (msg.op === 2) {
                // Identified -> query all status points in one round-trip
                const requests = [
                    { type: 'GetStats', id: 'stats' },
                    { type: 'GetStreamStatus', id: 'stream' },
                    { type: 'GetCurrentProgramScene', id: 'scene' },
                    { type: 'GetRecordStatus', id: 'record' },
                    { type: 'GetVideoSettings', id: 'video' },
                ];
                requests.forEach((r) => {
                    pendingRequests.set(r.id, r.type);
                    ws.send(JSON.stringify({ op: 6, d: { requestType: r.type, requestId: r.id, requestData: {} } }));
                });
            } else if (msg.op === 7) {
                // RequestResponse
                const id = msg.d && msg.d.requestId;
                if (id && pendingRequests.has(id)) {
                    pendingRequests.delete(id);
                    results[id] = msg.d.responseData || {};
                    if (pendingRequests.size === 0) {
                        finish(results);
                    }
                }
            }
        });
    });
}

function computeInstanceMetrics(instance, dockerStat, obsData, noalbsData) {
    const isRunning = /up|running/i.test(dockerStat);
    const now = Date.now();

    if (!isRunning || !obsData) {
        return {
            name: instance.name,
            status: dockerStat || 'stopped',
            connected: false,
            streaming: false,
            recording: false,
            health: isRunning ? 'STANDBY' : 'STOPPED',
            activeFps: 0,
            targetFps: 60,
            bitrateKbps: 0,
            cpuUsage: 0,
            memoryMb: 0,
            currentScene: '',
            encodingOverloaded: false,
            renderLagged: false,
            networkCongested: false,
            renderTimeMs: 0,
            renderTimeBudgetMs: 16.67,
            renderSkippedFrames: 0,
            renderTotalFrames: 0,
            encoderSkippedFrames: 0,
            encoderTotalFrames: 0,
            networkSkippedFrames: 0,
            networkTotalFrames: 0,
            networkCongestion: 0,
            outputTimecode: '00:00:00',
            outputDurationMs: 0,
            noalbs: noalbsData || { enabled: false },
            alerts: isRunning ? ['OBS WebSocket no responde o todavía está iniciando'] : ['Instancia apagada'],
            publicAlias: instance.publicAlias || instance.name,
            panelUrl: instance.panelUrl,
            panelUrlHttps: instance.panelUrlHttps,
            obsWsPort: instance.obsWsPort,
            webPort: instance.webPort,
        };
    }

    const stats = obsData.stats || {};
    const stream = obsData.stream || {};
    const scene = obsData.scene || {};
    const record = obsData.record || {};
    const video = obsData.video || {};

    const targetFps = (video.fpsNumerator && video.fpsDenominator)
        ? Math.round(video.fpsNumerator / video.fpsDenominator)
        : 60;
    const renderTimeBudgetMs = targetFps > 0 ? parseFloat((1000 / targetFps).toFixed(2)) : 16.67;

    const streaming = Boolean(stream.outputActive);
    const reconnecting = Boolean(stream.outputReconnecting);
    const recording = Boolean(record.outputActive);

    const activeFps = typeof stats.activeFps === 'number' ? parseFloat(stats.activeFps.toFixed(1)) : 0;
    const cpuUsage = typeof stats.cpuUsage === 'number' ? parseFloat(stats.cpuUsage.toFixed(1)) : 0;
    const memoryMb = typeof stats.memoryUsage === 'number' ? parseFloat(stats.memoryUsage.toFixed(0)) : 0;
    const renderTimeMs = typeof stats.averageFrameRenderTime === 'number' ? parseFloat(stats.averageFrameRenderTime.toFixed(2)) : 0;

    const encoderSkippedFrames = stats.outputSkippedFrames || 0;
    const encoderTotalFrames = stats.outputTotalFrames || 0;
    const renderSkippedFrames = stats.renderSkippedFrames || 0;
    const renderTotalFrames = stats.renderTotalFrames || 0;

    const networkSkippedFrames = stream.outputSkippedFrames || 0;
    const networkTotalFrames = stream.outputTotalFrames || 0;
    const networkCongestion = typeof stream.outputCongestion === 'number' ? parseFloat((stream.outputCongestion * 100).toFixed(1)) : 0;

    // Calculate deltas between samples
    const prev = monitorHistory.get(instance.name) || null;
    let bitrateKbps = 0;
    let dEncoderSkipped = 0;
    let dRenderSkipped = 0;
    let dNetworkSkipped = 0;

    if (prev && prev.time) {
        const dt = (now - prev.time) / 1000;
        if (dt > 0.4 && dt < 40) {
            const dBytes = Math.max(0, (stream.outputBytes || 0) - (prev.outputBytes || 0));
            bitrateKbps = Math.round((dBytes * 8) / (dt * 1000));
            dEncoderSkipped = Math.max(0, encoderSkippedFrames - (prev.encoderSkippedFrames || 0));
            dRenderSkipped = Math.max(0, renderSkippedFrames - (prev.renderSkippedFrames || 0));
            dNetworkSkipped = Math.max(0, networkSkippedFrames - (prev.networkSkippedFrames || 0));
        }
    }

    monitorHistory.set(instance.name, {
        time: now,
        outputBytes: stream.outputBytes || 0,
        encoderSkippedFrames,
        renderSkippedFrames,
        networkSkippedFrames,
    });

    const encoderSkippedPercent = encoderTotalFrames > 0
        ? parseFloat(((encoderSkippedFrames / encoderTotalFrames) * 100).toFixed(2))
        : 0;

    const renderSkippedPercent = renderTotalFrames > 0
        ? parseFloat(((renderSkippedFrames / renderTotalFrames) * 100).toFixed(2))
        : 0;

    const networkSkippedPercent = networkTotalFrames > 0
        ? parseFloat(((networkSkippedFrames / networkTotalFrames) * 100).toFixed(2))
        : 0;

    // Encoding Overload detection ("Encoding Loader" / Sobrecarga del codificador)
    // Occurs when hardware/software encoder is unable to keep up in real time
    const encodingOverloaded = (streaming || recording) && (
        dEncoderSkipped > 0 ||
        encoderSkippedPercent > 0.8 ||
        (encoderSkippedFrames > 10 && encoderSkippedPercent > 0.3)
    );

    const renderLagged = dRenderSkipped > 0 || renderTimeMs > (renderTimeBudgetMs * 1.05);
    const networkCongested = dNetworkSkipped > 0 || networkCongestion > 15;
    const fpsDropped = activeFps > 0 && activeFps < (targetFps * 0.88);

    const alerts = [];
    if (reconnecting) alerts.push('Reconectando stream con el servidor ingest/RTMP');
    if (encodingOverloaded) alerts.push(`⚠️ SOBRECARGA DE CODIFICADOR (descartando frames: +${dEncoderSkipped} frames, total ${encoderSkippedPercent}%)`);
    if (renderLagged) alerts.push(`Renderizado GPU al límite (${renderTimeMs}ms de ${renderTimeBudgetMs}ms)`);
    if (networkCongested) alerts.push(`Congestión de red (${networkCongestion}% / descartados: +${dNetworkSkipped})`);
    if (fpsDropped) alerts.push(`FPS caídos (${activeFps} de ${targetFps} FPS)`);

    let health = 'OK';
    if (!streaming) {
        health = isRunning ? 'STANDBY' : 'STOPPED';
    } else if (reconnecting || encodingOverloaded || (activeFps > 0 && activeFps < (targetFps * 0.75))) {
        health = 'CRITICAL';
    } else if (networkCongested || renderLagged || fpsDropped || cpuUsage > 85) {
        health = 'WARNING';
    } else {
        health = 'OK';
    }

    return {
        name: instance.name,
        status: dockerStat,
        connected: true,
        streaming,
        reconnecting,
        recording,
        health,
        activeFps,
        targetFps,
        bitrateKbps,
        cpuUsage,
        memoryMb,
        currentScene: scene.currentProgramSceneName || '',
        encodingOverloaded,
        encoderSkippedFrames,
        encoderTotalFrames,
        encoderSkippedPercent,
        dEncoderSkipped,
        renderLagged,
        renderTimeMs,
        renderTimeBudgetMs,
        renderSkippedFrames,
        renderTotalFrames,
        renderSkippedPercent,
        dRenderSkipped,
        networkCongested,
        networkSkippedFrames,
        networkTotalFrames,
        networkSkippedPercent,
        networkCongestion,
        dNetworkSkipped,
        outputTimecode: stream.outputTimecode || '00:00:00',
        outputDurationMs: stream.outputDuration || 0,
        outputBytes: stream.outputBytes || 0,
        baseResolution: video.baseWidth && video.baseHeight ? `${video.baseWidth}x${video.baseHeight}` : '1920x1080',
        outputResolution: video.outputWidth && video.outputHeight ? `${video.outputWidth}x${video.outputHeight}` : '1920x1080',
        noalbs: noalbsData || { enabled: false },
        alerts,
        publicAlias: instance.publicAlias || instance.name,
        panelUrl: instance.panelUrl,
        panelUrlHttps: instance.panelUrlHttps,
        obsWsPort: instance.obsWsPort,
        webPort: instance.webPort,
    };
}

async function getMonitoringData() {
    const rows = parseRegistryRows();
    const instances = await Promise.all(
        rows.map(async (instance) => {
            const dockerStat = await dockerStatus(instance.name);
            let obsData = null;
            let noalbsData = null;
            if (/up|running/i.test(dockerStat)) {
                try {
                    const [obsRes, noalbsRes] = await Promise.all([
                        getObsFullMetrics(instance.obsWsPort, instance.obsWsPassword, 2500),
                        getNoalbsQuick(instance.name, instance, dockerStat).catch(() => null),
                    ]);
                    obsData = obsRes;
                    noalbsData = noalbsRes;
                } catch {}
            }
            return computeInstanceMetrics(instance, dockerStat, obsData, noalbsData);
        })
    );

    let runningCount = 0;
    let streamingCount = 0;
    let okCount = 0;
    let warnCount = 0;
    let criticalCount = 0;
    let totalBitrateKbps = 0;
    let fpsSum = 0;
    let fpsCount = 0;
    let cpuSum = 0;
    let cpuCount = 0;
    let encodingOverloadCount = 0;

    instances.forEach((inst) => {
        if (/up|running/i.test(inst.status)) runningCount++;
        if (inst.streaming) {
            streamingCount++;
            if (inst.encodingOverloaded) encodingOverloadCount++;
            if (inst.health === 'OK') okCount++;
            else if (inst.health === 'WARNING') warnCount++;
            else if (inst.health === 'CRITICAL') criticalCount++;
            if (inst.bitrateKbps > 0) totalBitrateKbps += inst.bitrateKbps;
        } else {
            if (inst.health === 'OK' || inst.health === 'STANDBY') okCount++;
        }

        if (inst.connected && inst.activeFps > 0) {
            fpsSum += inst.activeFps;
            fpsCount++;
        }
        if (inst.connected && inst.cpuUsage > 0) {
            cpuSum += inst.cpuUsage;
            cpuCount++;
        }
    });

    const summary = {
        totalInstances: instances.length,
        runningCount,
        streamingCount,
        encodingOverloadCount,
        okCount,
        warnCount,
        criticalCount,
        totalBitrateKbps,
        avgFps: fpsCount > 0 ? parseFloat((fpsSum / fpsCount).toFixed(1)) : 0,
        avgCpu: cpuCount > 0 ? parseFloat((cpuSum / cpuCount).toFixed(1)) : 0,
    };

    return { summary, instances, timestamp: Date.now() };
}

async function applySavedIngest(name) {
    const watchUrl = getIngestUrl(name);
    if (!watchUrl) return;
    const instance = readInstanceRecord(name);
    if (!instance) return;
    for (let i = 0; i < 20; i++) {
        await new Promise((r) => setTimeout(r, 2000));
        try {
            await obsRequest(instance.obsWsPort, instance.obsWsPassword, 'SetInputSettings', {
                inputName: 'Ingest Player',
                inputSettings: { url: watchUrl },
                overlay: true,
            });
            console.log(`[ingest] restored Ingest Player url for '${name}'`);
            return;
        } catch {
            // Keep retrying while OBS starts up
        }
    }
    console.warn(`[ingest] timed out restoring Ingest Player url for '${name}'`);
}

// ---- Idle watchdog: stops (never deletes) instances that are neither
// streaming nor being actively used, to save VPS resources. Never touches
// the volume -- only `docker compose stop`, so OBS scenes/config/
// multi-rtmp targets/NOALBS config are all still there next time it's
// started again.
//
// Two independent timers per instance, whichever fires first wins (an
// active stream resets both and always keeps it up regardless of either):
//   - lastInput: real mouse/keyboard activity in Neko (see the WS listener
//     below) -- stop after idleStopMinutes with none.
//   - notStreamingSince: how long the stream has been continuously NOT
//     live -- stop after neverStreamedStopMinutes even if there IS Neko
//     activity, so someone can't keep an instance up forever without ever
//     actually going live.
const ACTIVITY_FILE = path.join(os.homedir(), '.neko-activity.json');

function readActivity() {
    try { return JSON.parse(fs.readFileSync(ACTIVITY_FILE, 'utf8')); } catch { return {}; }
}
function writeActivity(activity) {
    fs.writeFileSync(ACTIVITY_FILE, JSON.stringify(activity));
}
// Used by instance create/start endpoints below, and by the Neko activity
// listener when it sees real input -- resets the "someone's using it" clock.
function touchActivity(name) {
    const activity = readActivity();
    activity[name] = { ...(activity[name] || {}), lastInput: Date.now() };
    writeActivity(activity);
}

function nekoLogin(webPort, password) {
    return new Promise((resolve, reject) => {
        const http = require('http');
        const body = JSON.stringify({ username: 'admin', password });
        const req = http.request({
            host: '127.0.0.1', port: webPort, path: '/api/login', method: 'POST',
            headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
            timeout: 8000,
        }, (res) => {
            let data = '';
            res.on('data', (c) => { data += c; });
            res.on('end', () => {
                try { resolve(JSON.parse(data).token); } catch (e) { reject(e); }
            });
        });
        req.on('error', reject);
        req.on('timeout', () => req.destroy(new Error('timeout logging into neko')));
        req.write(body);
        req.end();
    });
}

// One persistent WS per running instance, watching for real interaction
// (control/host fires when someone takes control -- implicit hosting means
// that happens on first click/keypress; session/state connect events cover
// someone just opening the panel). This is the only activity signal Neko's
// API actually exposes -- it doesn't broadcast individual mouse-move/
// keydown events on this channel, so "activity" here means "someone
// started interacting", not a continuous per-pixel timestamp. Good enough
// for a multi-minute idle window.
const nekoActivitySockets = new Map();

async function ensureNekoActivityListener(instance) {
    if (nekoActivitySockets.has(instance.name)) return;
    nekoActivitySockets.set(instance.name, null); // claim it before the first await, avoid double-connect races
    try {
        const token = await nekoLogin(instance.webPort, instance.adminPassword);
        const ws = new WebSocket(`ws://127.0.0.1:${instance.webPort}/api/ws?token=${encodeURIComponent(token)}`);
        ws.on('message', (raw) => {
            let msg;
            try { msg = JSON.parse(raw.toString()); } catch { return; }
            if (msg.event === 'control/host' || (msg.event === 'session/state' && msg.payload && msg.payload.is_connected)) {
                touchActivity(instance.name);
            }
        });
        const cleanup = () => { nekoActivitySockets.delete(instance.name); };
        ws.on('close', cleanup);
        ws.on('error', cleanup);
        nekoActivitySockets.set(instance.name, ws);
    } catch (e) {
        nekoActivitySockets.delete(instance.name);
        console.error(`[idle-watchdog] Failed to open Neko activity listener for '${instance.name}':`, e.message);
    }
}

function dropNekoActivityListener(name) {
    const ws = nekoActivitySockets.get(name);
    if (ws) { try { ws.terminate(); } catch { /* already gone */ } }
    nekoActivitySockets.delete(name);
}

async function runIdleWatchdog() {
    const cfg = readGlobalConfig();
    const idleMinutes = Number(cfg.idleStopMinutes);
    const neverStreamedMinutes = Number(cfg.neverStreamedStopMinutes);
    if ((!idleMinutes || idleMinutes <= 0) && (!neverStreamedMinutes || neverStreamedMinutes <= 0)) return;

    const activity = readActivity();
    const now = Date.now();
    let changed = false;
    const runningNames = new Set();

    for (const instance of parseRegistryRows()) {
        const status = await dockerStatus(instance.name);
        if (!/up|running/i.test(status)) continue;
        runningNames.add(instance.name);

        ensureNekoActivityListener(instance).catch(() => {});

        let rec = activity[instance.name];
        if (!rec) {
            // First time we've seen this running instance -- start both
            // clocks now instead of stopping it immediately.
            rec = { lastInput: now, notStreamingSince: now };
            activity[instance.name] = rec;
            changed = true;
        }

        try {
            const streamStatus = await getObsStreamStatus(instance.obsWsPort, instance.obsWsPassword);
            if (streamStatus.outputActive) {
                rec.lastInput = now;
                rec.notStreamingSince = now;
                changed = true;
                continue;
            }
        } catch {
            // obs-websocket unreachable (container still booting, etc.) --
            // don't count this tick as streaming, but don't stop it over a
            // single failed check either; the age checks below still apply.
        }

        // GetStreamStatus above only reports OBS's own native "Start
        // Streaming" output -- an account streaming ONLY through an
        // obs-multi-rtmp "Destino" (a target with sync-start off, started
        // independently of the native output) was invisible to it, so the
        // watchdog stopped the instance mid-stream. Cross-check the
        // plugin's own GetStatus for any REAL target (name not starting
        // with "_") reporting "active". "_internal_preview" is explicitly
        // excluded: it's active almost exactly when the account is NOT
        // live (obs-multi-rtmp.cpp stops it the moment the real stream
        // starts) -- counting it would treat "idle" as "streaming" and
        // defeat the watchdog entirely.
        try {
            const pluginStatus = await callPluginWs(instance.pluginWsPort, instance.pluginWsPassword, 'GetStatus');
            const anyTargetActive = (pluginStatus.targets || []).some(
                (t) => !String(t.name || '').startsWith('_') && t.status === 'active'
            );
            if (anyTargetActive) {
                rec.lastInput = now;
                rec.notStreamingSince = now;
                changed = true;
                continue;
            }
        } catch {
            // plugin WS unreachable -- same "don't count this tick, don't
            // stop over one failed check" reasoning as the block above.
        }

        const idleFor = now - rec.lastInput;
        const neverStreamedFor = now - rec.notStreamingSince;
        const hitIdle = idleMinutes > 0 && idleFor > idleMinutes * 60 * 1000;
        const hitCeiling = neverStreamedMinutes > 0 && neverStreamedFor > neverStreamedMinutes * 60 * 1000;

        if (hitIdle || hitCeiling) {
            const reason = hitIdle
                ? `no Neko activity for ${Math.round(idleFor / 60000)}m (limit ${idleMinutes}m)`
                : `never streamed for ${Math.round(neverStreamedFor / 60000)}m (limit ${neverStreamedMinutes}m)`;
            console.log(`[idle-watchdog] Stopping '${instance.name}' (${reason})`);
            try {
                await run('docker', ['compose', '-p', `neko-${instance.name}`, '-f', path.join(SCRIPT_DIR, 'docker-compose.yml'), 'stop'], 60 * 1000);
                logAudit({ admin: null }, 'instance.autostop', instance.name, { reason });
                dispatchWebhook('neko.stopped', { instance: instance.name, reason: `Inactividad (${reason})` });
            } catch (e) {
                console.error(`[idle-watchdog] Failed to stop '${instance.name}':`, e.message);
            }
            delete activity[instance.name];
            dropNekoActivityListener(instance.name);
            changed = true;
        }
    }

    // Drop listeners for instances that stopped/were removed since the last tick.
    for (const name of Array.from(nekoActivitySockets.keys())) {
        if (!runningNames.has(name)) dropNekoActivityListener(name);
    }

    if (changed) writeActivity(activity);
}

setInterval(() => { runIdleWatchdog().catch((e) => console.error('[idle-watchdog] tick failed:', e.message)); }, 2 * 60 * 1000);

async function dockerStatus(name) {
    try {
        const { stdout } = await run('docker', [
            'compose', '-p', `neko-${name}`, '-f', path.join(SCRIPT_DIR, 'docker-compose.yml'),
            'ps', '--status', 'running', '--format', '{{.Status}}',
        ], 15 * 1000);
        const status = stdout.split('\n')[0].trim();
        return status || 'stopped';
    } catch {
        return 'unknown';
    }
}

// ---- POST /instances ----
app.post('/instances', async (req, res) => {
    const { name } = req.body || {};
    if (!validName(name)) {
        return res.status(400).json({ ok: false, error: "missing or invalid 'name' (lowercase alphanumeric, - or _)" });
    }

    const flagMap = {
        publicIp: '--public-ip',
        webPort: '--web-port',
        obsWsPort: '--obs-ws-port',
        pluginWsPort: '--plugin-ws-port',
        webrtcStart: '--webrtc-start',
        webrtcEnd: '--webrtc-end',
        obsWsPassword: '--obs-ws-password',
        pluginWsPassword: '--plugin-ws-password',
        userPassword: '--user-password',
        adminPassword: '--admin-password',
    };
    const args = [path.join(SCRIPT_DIR, 'provision-neko-obs.sh'), name];
    for (const [key, flag] of Object.entries(flagMap)) {
        const val = (req.body || {})[key];
        if (val !== undefined && val !== null && val !== '') {
            args.push(flag, String(val));
        }
    }

    // RTMP server/key/disconnected-video default to the global config
    // (~/.neko-config.env, editable via /config or the config panel) unless
    // this request overrides them explicitly.
    const cfg = readGlobalConfig();
    const body = req.body || {};
    const streamKey = body.streamKey || renderTemplate(cfg.streamKeyTemplate, { instance: name });
    const extraEnv = {
        RTMP_SERVER_URL: body.rtmpServerUrl || cfg.rtmpServerUrl || 'rtmp://host.docker.internal:1935/ingest',
        STREAM_KEY: streamKey,
        DISCONNECTED_VIDEO_URL: body.disconnectedVideoUrl || cfg.disconnectedVideoUrl || '',
        INSTANCE_NAME: name,
    };

    try {
        const { stdout } = await run('bash', args, undefined, extraEnv);
        const instance = readInstanceRecord(name);
        touchActivity(name);
        logAudit(req, 'instance.create', name, { body });
        res.json({ ok: true, instance, output: stdout });
    } catch (e) {
        res.status(500).json({ ok: false, error: e.message, stdout: e.stdout, stderr: e.stderr });
    }
});

// ---- GET /config ----
app.get('/config', (req, res) => {
    res.json({ ok: true, config: readGlobalConfig() });
});

// ---- PUT /config ----
// Body: { rtmpServerUrl?, streamKeyTemplate?, watchUrlTemplate?, disconnectedVideoUrl? }
// Only touches the keys present in the body -- omit any you don't want to change.
app.put('/config', (req, res) => {
    const allowed = Object.keys(CONFIG_DEFAULTS);
    const partial = {};
    for (const k of allowed) {
        if (req.body && req.body[k] !== undefined) partial[k] = String(req.body[k]);
    }
    const merged = writeGlobalConfig(partial);
    logAudit(req, 'config.update', null, { partial });
    res.json({ ok: true, config: merged });
});

// ---- GET /instances ----

// ---- POST /config/webhook/test ----
app.post('/config/webhook/test', async (req, res) => {
    try {
        const cfg = readGlobalConfig();
        const testUrl = req.body?.webhookUrl || cfg.webhookUrl;
        const testSecret = req.body?.webhookSecret || cfg.webhookSecret || 'wh_irl_k9G4mTzXp2sR7vBnQ8dF';

        if (!testUrl) {
            return res.status(400).json({ ok: false, error: 'No hay webhookUrl configurada para probar.' });
        }

        const payload = {
            event: 'neko.critical',
            timestamp: Date.now(),
            instance: 'test-obs',
            alerts: ['⚠️ Mensaje de prueba desde OBS Monitor: Webhook conectado exitosamente'],
            metrics: {
                activeFps: 60,
                targetFps: 60,
                bitrateKbps: 6000,
                cpuUsage: 14.5,
                encoderSkippedPercent: 0,
                networkCongestion: 0
            }
        };

        const response = await fetch(testUrl, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'x-webhook-secret': testSecret,
                'User-Agent': 'Neko-OBS-Monitor-Test/1.0'
            },
            body: JSON.stringify(payload),
            signal: AbortSignal.timeout(8000)
        });

        if (!response.ok) {
            const errText = await response.text().catch(() => '');
            return res.status(502).json({ ok: false, error: `El servidor webhook respondió con HTTP ${response.status}: ${errText.slice(0, 200)}` });
        }

        const respData = await response.json().catch(() => ({}));
        res.json({ ok: true, message: 'Webhook de prueba enviado y recibido con éxito', response: respData });
    } catch (e) {
        res.status(500).json({ ok: false, error: `Error enviando webhook de prueba: ${e.message}` });
    }
});

app.get('/instances', async (req, res) => {
    try {
        const rows = parseRegistryRows();
        const instances = await Promise.all(
            rows.map(async (r) => {
                const status = await dockerStatus(r.name);
                const noalbs = await getNoalbsQuick(r.name, r, status);
                return {
                    ...r,
                    status,
                    noalbsEnabled: noalbs.enabled,
                    noalbsStatsUrl: noalbs.statsUrl,
                    noalbs,
                };
            })
        );
        res.json({ ok: true, instances });
    } catch (e) {
        res.status(500).json({ ok: false, error: e.message });
    }
});

// ---- GET /instances/:name ----
app.get('/instances/:name', async (req, res) => {
    const { name } = req.params;
    if (!validName(name)) return res.status(400).json({ ok: false, error: 'invalid name' });
    const instance = readInstanceRecord(name);
    if (!instance) return res.status(404).json({ ok: false, error: 'not found' });
    instance.status = await dockerStatus(name);
    res.json({ ok: true, instance });
});


// ==========================================
// WEBHOOK DISPATCHER & REAL-TIME ALERT WATCHER
// ==========================================

async function dispatchWebhook(event, payload = {}) {
    try {
        const cfg = readGlobalConfig();
        if (!cfg.webhookUrl || cfg.webhookEnabled === 'false') return;

        const isEvent = event.startsWith('neko.started') || event.startsWith('neko.stopped') || event.startsWith('neko.stream') || event.startsWith('stream.');
        const isAlert = event.startsWith('neko.critical') || event.startsWith('neko.recovered');

        if (isEvent && cfg.webhookEventsEnabled === 'false') return;
        if (isAlert && cfg.webhookAlertsEnabled === 'false') return;
        const secret = cfg.webhookSecret || 'wh_irl_k9G4mTzXp2sR7vBnQ8dF';
        const argTime = new Date().toLocaleTimeString('es-AR', {
            timeZone: 'America/Argentina/Buenos_Aires',
            hour: '2-digit',
            minute: '2-digit',
            second: '2-digit',
            hour12: false
        }) + ' (🇦🇷 ARG)';

        const body = JSON.stringify({
            event,
            timestamp: Date.now(),
            time: argTime,
            ...payload
        });

        fetch(cfg.webhookUrl, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'x-webhook-secret': secret,
                'User-Agent': 'Neko-OBS-Monitor/1.0'
            },
            body,
            signal: AbortSignal.timeout(6000)
        }).then((res) => {
            if (!res.ok) {
                console.warn(`[webhook] Server returned HTTP ${res.status} for ${event}`);
            } else {
                console.log(`[webhook] Successfully delivered ${event}`);
            }
        }).catch((err) => {
            console.warn(`[webhook] Delivery failed for ${event}:`, err.message);
        });
    } catch (e) {
        console.warn('[webhook] Error in dispatchWebhook:', e.message);
    }
}

const alertTracker = new Map(); // instanceName -> { lastAlertTime: number, isAlerting: boolean }

async function runAlertWatcher() {
    try {
        const cfg = readGlobalConfig();
        if (!cfg.webhookUrl || cfg.webhookEnabled === 'false' || cfg.webhookAlertsEnabled === 'false') {
            return;
        }

        const data = await getMonitoringData();
        const instances = data.instances || [];
        const now = Date.now();

        for (const inst of instances) {
            const isRunning = /up|running/i.test(inst.status);
            if (!isRunning) {
                alertTracker.delete(inst.name);
                continue;
            }

            const isCritical = inst.health === 'CRITICAL' || inst.encodingOverloaded;
            const hasSevereIssue = inst.streaming && (
                inst.renderLagged ||
                inst.networkCongested ||
                (inst.activeFps > 0 && inst.activeFps < inst.targetFps * 0.75)
            );
            const isAlerting = isCritical || hasSevereIssue;

            const tracked = alertTracker.get(inst.name) || { lastAlertTime: 0, isAlerting: false };

            if (isAlerting) {
                const cooldownMs = 5 * 60 * 1000; // 5 min cooldown
                const shouldSend = !tracked.isAlerting || (now - tracked.lastAlertTime > cooldownMs);

                if (shouldSend) {
                    dispatchWebhook('neko.critical', {
                        instance: inst.name,
                        alerts: inst.alerts || [],
                        metrics: {
                            activeFps: inst.activeFps,
                            targetFps: inst.targetFps,
                            bitrateKbps: inst.bitrateKbps,
                            cpuUsage: inst.cpuUsage,
                            encoderSkippedPercent: inst.encoderSkippedPercent,
                            networkCongestion: inst.networkCongestion
                        }
                    });
                    alertTracker.set(inst.name, { lastAlertTime: now, isAlerting: true });
                }
            } else if (tracked.isAlerting && inst.health === 'OK') {
                dispatchWebhook('neko.recovered', {
                    instance: inst.name
                });
                alertTracker.set(inst.name, { lastAlertTime: 0, isAlerting: false });
            }
        }
    } catch (e) {
        // Suppress alert watcher error noise
    }
}

setInterval(() => {
    runAlertWatcher().catch(() => {});
}, 15 * 1000);


// ==========================================
// AUTOMATIC CONTAINER & STREAM STATE WATCHER (PRENDER / APAGAR)
// ==========================================
const containerStates = new Map();
const streamingStates = new Map();

async function runStateWatcher() {
    try {
        const rows = parseRegistryRows();
        for (const row of rows) {
            const name = row.name;
            const stat = await dockerStatus(name);
            const isRunning = /up|running/i.test(stat);

            // Container start/stop tracking
            if (!containerStates.has(name)) {
                containerStates.set(name, isRunning);
            } else {
                const wasRunning = containerStates.get(name);
                if (!wasRunning && isRunning) {
                    console.log(`[state-watcher] 🟢 Instancia '${name}' ENCENDIDA detectada`);
                    containerStates.set(name, true);
                    dispatchWebhook('neko.started', {
                        instance: name,
                        publicAlias: row.publicAlias || name,
                        trigger: 'Detección Docker'
                    });
                } else if (wasRunning && !isRunning) {
                    console.log(`[state-watcher] 🔴 Instancia '${name}' APAGADA detectada`);
                    containerStates.set(name, false);
                    streamingStates.set(name, false);
                    dispatchWebhook('neko.stopped', {
                        instance: name,
                        reason: 'Contenedor detenido'
                    });
                }
            }

            // OBS Stream start/stop tracking (Transmisión En Vivo)
            if (isRunning) {
                try {
                    const obsData = await getObsFullMetrics(row.obsWsPort, row.obsWsPassword, 1800);
                    if (obsData && obsData.stream) {
                        const isStreaming = Boolean(obsData.stream.outputActive);
                        if (!streamingStates.has(name)) {
                            streamingStates.set(name, isStreaming);
                        } else {
                            const wasStreaming = streamingStates.get(name);
                            if (!wasStreaming && isStreaming) {
                                console.log(`[state-watcher] 🟢 Transmisión OBS INICIADA en '${name}'`);
                                streamingStates.set(name, true);
                                dispatchWebhook('neko.stream.started', {
                                    instance: name,
                                    publicAlias: row.publicAlias || name,
                                    trigger: 'OBS Stream En Vivo',
                                    timecode: obsData.stream.outputTimecode || '00:00:00'
                                });
                            } else if (wasStreaming && !isStreaming) {
                                console.log(`[state-watcher] 🔴 Transmisión OBS DETENIDA en '${name}'`);
                                streamingStates.set(name, false);
                                dispatchWebhook('neko.stream.stopped', {
                                    instance: name,
                                    publicAlias: row.publicAlias || name,
                                    reason: 'OBS Stream Detenido'
                                });
                            }
                        }
                    }
                } catch {}
            }
        }
    } catch (e) {
        // Suppress
    }
}

setInterval(() => {
    runStateWatcher().catch(() => {});
}, 3500);

// ---- GET /monitor/instances (Full multi-instance real-time snapshot) ----
app.get('/monitor/instances', async (req, res) => {
    try {
        const data = await getMonitoringData();
        res.json({ ok: true, ...data });
    } catch (e) {
        res.status(500).json({ ok: false, error: e.message });
    }
});

// ---- GET /monitor/stream (Server-Sent Events near real-time stream) ----
app.get('/monitor/stream', async (req, res) => {
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.flushHeaders?.();

    let active = true;
    const sendUpdate = async () => {
        if (!active) return;
        try {
            const data = await getMonitoringData();
            if (active) {
                res.write(`data: ${JSON.stringify(data)}\n\n`);
            }
        } catch (err) {
            if (active) {
                res.write(`event: error\ndata: ${JSON.stringify({ error: err.message })}\n\n`);
            }
        }
    };

    // Send immediately on connect
    await sendUpdate();

    // Push tick every 1500ms
    const interval = setInterval(sendUpdate, 1500);

    req.on('close', () => {
        active = false;
        clearInterval(interval);
        res.end();
    });
});

// ---- GET /instances/:name/metrics (Deep dive metrics for a single instance) ----
app.get('/instances/:name/metrics', async (req, res) => {
    const { name } = req.params;
    if (!validName(name)) return res.status(400).json({ ok: false, error: 'invalid name' });
    const instance = readInstanceRecord(name);
    if (!instance) return res.status(404).json({ ok: false, error: 'not found' });

    try {
        const dockerStat = await dockerStatus(name);
        let obsData = null;
        let noalbsData = null;
        if (/up|running/i.test(dockerStat)) {
            const [obsRes, noalbsRes] = await Promise.all([
                getObsFullMetrics(instance.obsWsPort, instance.obsWsPassword, 3000),
                getNoalbsQuick(name, instance, dockerStat).catch(() => null),
            ]);
            obsData = obsRes;
            noalbsData = noalbsRes;
        }
        const metrics = computeInstanceMetrics(instance, dockerStat, obsData, noalbsData);
        res.json({ ok: true, metrics, raw: obsData });
    } catch (e) {
        res.status(500).json({ ok: false, error: e.message });
    }
});

// ---- POST /instances/:name/action (Quick remote actions from monitor: start/stop stream, switch scene) ----
app.post('/instances/:name/action', async (req, res) => {
    const { name } = req.params;
    if (!validName(name)) return res.status(400).json({ ok: false, error: 'invalid name' });
    const instance = readInstanceRecord(name);
    if (!instance) return res.status(404).json({ ok: false, error: 'not found' });

    const { action, sceneName } = req.body || {};
    try {
        let result = null;
        if (action === 'startStream') {
            result = await obsRequest(instance.obsWsPort, instance.obsWsPassword, 'StartStream');
            logAudit(req, 'instance.action_startStream', name);
            streamingStates.set(name, true);
            dispatchWebhook('neko.stream.started', {
                instance: name,
                publicAlias: instance.publicAlias || name,
                trigger: 'panel/monitor action'
            });
        } else if (action === 'stopStream') {
            result = await obsRequest(instance.obsWsPort, instance.obsWsPassword, 'StopStream');
            logAudit(req, 'instance.action_stopStream', name);
            streamingStates.set(name, false);
            dispatchWebhook('neko.stream.stopped', {
                instance: name,
                publicAlias: instance.publicAlias || name,
                reason: 'panel/monitor action'
            });
        } else if (action === 'setScene' && sceneName) {
            result = await obsRequest(instance.obsWsPort, instance.obsWsPassword, 'SetCurrentProgramScene', { sceneName });
            logAudit(req, 'instance.action_setScene', name, { sceneName });
        } else {
            return res.status(400).json({ ok: false, error: 'Acción no válida o faltan parámetros (startStream, stopStream, setScene)' });
        }
        touchActivity(name);
        res.json({ ok: true, action, result });
    } catch (e) {
        res.status(500).json({ ok: false, error: e.message });
    }
});

// ---- POST /instances/:name/start ----
app.post('/instances/:name/start', async (req, res) => {
    const { name } = req.params;
    if (!validName(name)) return res.status(400).json({ ok: false, error: 'invalid name' });
    try {
        const newAlias = rotatePublicAlias(name);
        if (newAlias) {
            await run('bash', [path.join(SCRIPT_DIR, 'gen-caddyfile.sh')]).catch(() => {});
        }
        await run('docker', ['compose', '-p', `neko-${name}`, '-f', path.join(SCRIPT_DIR, 'docker-compose.yml'), 'start'], 60 * 1000);
        touchActivity(name);
        applySavedIngest(name).catch((e) => console.warn(`[ingest] auto-apply error for ${name}:`, e.message));
        logAudit(req, 'instance.start', name, { publicAlias: newAlias });
        dispatchWebhook('neko.started', { instance: name, publicAlias: newAlias, trigger: 'panel/api' });
        res.json({ ok: true, status: 'started', publicAlias: newAlias });
    } catch (e) {
        res.status(500).json({ ok: false, error: e.message, stdout: e.stdout, stderr: e.stderr });
    }
});

// ---- POST /instances/:name/stop ----
app.post('/instances/:name/stop', async (req, res) => {
    const { name } = req.params;
    if (!validName(name)) return res.status(400).json({ ok: false, error: 'invalid name' });
    try {
        await run('docker', ['compose', '-p', `neko-${name}`, '-f', path.join(SCRIPT_DIR, 'docker-compose.yml'), 'stop'], 60 * 1000);
        logAudit(req, 'instance.stop', name);
        dispatchWebhook('neko.stopped', { instance: name, reason: 'Manual / API' });
        res.json({ ok: true, status: 'stopped' });
    } catch (e) {
        res.status(500).json({ ok: false, error: e.message, stdout: e.stdout, stderr: e.stderr });
    }
});

// ---- POST /instances/:name/restart ----
// Same as start but uses `docker compose restart` instead of `start`.
// Rotates the public alias (invalidates old URLs), regenerates Caddy
// config, re-applies the saved ingest, and touches the activity timer.
app.post('/instances/:name/restart', async (req, res) => {
    const { name } = req.params;
    if (!validName(name)) return res.status(400).json({ ok: false, error: 'invalid name' });
    try {
        const newAlias = rotatePublicAlias(name);
        if (newAlias) {
            await run('bash', [path.join(SCRIPT_DIR, 'gen-caddyfile.sh')]).catch(() => {});
        }
        await run('docker', ['compose', '-p', `neko-${name}`, '-f', path.join(SCRIPT_DIR, 'docker-compose.yml'), 'restart'], 60 * 1000);
        touchActivity(name);
        applySavedIngest(name).catch((e) => console.warn(`[ingest] auto-apply error for ${name}:`, e.message));
        logAudit(req, 'instance.restart', name, { publicAlias: newAlias });
        dispatchWebhook('neko.started', { instance: name, publicAlias: newAlias, trigger: 'panel/restart' });
        res.json({ ok: true, status: 'restarted', publicAlias: newAlias });
    } catch (e) {
        res.status(500).json({ ok: false, error: e.message, stdout: e.stdout, stderr: e.stderr });
    }
});

// ---- PUT /instances/:name/ingest ----
// Body: { watchUrl } (or { ingestUrl }, { url }). Points the "Ingest Player" Media Source (created by
// create-scenes.py in the VIDEO-FEEDS scene, locked from customer edits via
// obs-kiosk-lock) at the field camera's own SRT/RTMP watch URL. Admin-only
// action -- this is what lets an operator load a customer's IRL backpack
// feed into their OBS without touching the instance themselves.
app.put('/instances/:name/ingest', async (req, res) => {
    const { name } = req.params;
    if (!validName(name)) return res.status(400).json({ ok: false, error: 'invalid name' });
    const instance = readInstanceRecord(name);
    if (!instance) return res.status(404).json({ ok: false, error: 'not found' });

    const watchUrl = (req.body && (req.body.watchUrl ?? req.body.url ?? req.body.ingestUrl)) || '';
    setIngestUrl(name, watchUrl);

    let obsUpdated = false;
    let obsError = null;
    try {
        await obsRequest(instance.obsWsPort, instance.obsWsPassword, 'SetInputSettings', {
            inputName: 'Ingest Player',
            inputSettings: { url: watchUrl },
            overlay: true,
        });
        obsUpdated = true;
    } catch (e) {
        obsError = e.message;
        console.warn(`[ingest] could not update OBS directly for ${name} (instance may be stopped): ${e.message}`);
    }

    logAudit(req, 'instance.ingest_update', name, { watchUrl, obsUpdated });
    res.json({ ok: true, watchUrl, ingestUrl: watchUrl, obsUpdated, obsError });
});

// ---- GET /instances/:name/ingest ----
app.get('/instances/:name/ingest', async (req, res) => {
    const { name } = req.params;
    if (!validName(name)) return res.status(400).json({ ok: false, error: 'invalid name' });
    const instance = readInstanceRecord(name);
    if (!instance) return res.status(404).json({ ok: false, error: 'not found' });

    let watchUrl = getIngestUrl(name);
    if (!watchUrl) {
        try {
            const settings = await obsRequest(instance.obsWsPort, instance.obsWsPassword, 'GetInputSettings', {
                inputName: 'Ingest Player',
            });
            if (settings && settings.inputSettings && settings.inputSettings.url) {
                watchUrl = settings.inputSettings.url;
                setIngestUrl(name, watchUrl);
            }
        } catch { /* obs unreachable */ }
    }
    res.json({ ok: true, watchUrl, ingestUrl: watchUrl });
});

// ---- GET /instances/:name/noalbs ----
app.get('/instances/:name/noalbs', async (req, res) => {
    const { name } = req.params;
    if (!validName(name)) return res.status(400).json({ ok: false, error: 'invalid name' });
    const instance = readInstanceRecord(name);
    if (!instance) return res.status(404).json({ ok: false, error: 'not found' });

    try {
        const [configResp, statusResp] = await Promise.all([
            callPluginWs(instance.pluginWsPort, instance.pluginWsPassword, 'GetNoalbsConfig'),
            callPluginWs(instance.pluginWsPort, instance.pluginWsPassword, 'GetNoalbsStatus'),
        ]);
        if (configResp.status === 'error') return res.status(502).json({ ok: false, error: configResp.error });
        res.json({ ok: true, config: configResp.config, status: statusResp.noalbs });
    } catch (e) {
        const iniConfig = readNoalbsFromIni(name);
        if (iniConfig) {
            return res.json({
                ok: true,
                config: {
                    enabled: iniConfig.enabled,
                    statsUrl: iniConfig.statsUrl,
                    normalScene: 'LIVE',
                    lowScene: 'LOW',
                    offlineScene: 'DISCONNECTED',
                },
                status: { enabled: iniConfig.enabled, switchType: 'offline', bitrateKbps: 0, currentScene: '' },
                offline: true,
            });
        }
        res.status(502).json({ ok: false, error: e.message });
    }
});

// ---- PUT /instances/:name/noalbs ----
// Body is a PARTIAL NoalbsConfig -- e.g. { "enabled": false } just toggles
// auto-switching off without touching statsUrl/scenes/thresholds. See the
// header comment at the top of this file for the full field list.
app.put('/instances/:name/noalbs', async (req, res) => {
    const { name } = req.params;
    if (!validName(name)) return res.status(400).json({ ok: false, error: 'invalid name' });
    const instance = readInstanceRecord(name);
    if (!instance) return res.status(404).json({ ok: false, error: 'not found' });

    try {
        const resp = await callPluginWs(instance.pluginWsPort, instance.pluginWsPassword, 'SetNoalbsConfig', {
            config: req.body || {},
        });
        if (resp.status === 'error') return res.status(502).json({ ok: false, error: resp.error });
        writeNoalbsToIni(name, req.body || {});
        logAudit(req, 'noalbs.update', name, { partial: req.body || {} });
        res.json({ ok: true, status: resp.status });
    } catch (e) {
        const updated = writeNoalbsToIni(name, req.body || {});
        if (updated) {
            logAudit(req, 'noalbs.update', name, { partial: req.body || {}, offline: true });
            return res.json({ ok: true, status: 'ok', offline: true });
        }
        res.status(502).json({ ok: false, error: e.message });
    }
});

// ---- DELETE /instances/:name ----

// ==========================================
// MULTI-RTMP TARGETS (SALIDAS / DESTINOS)
// ==========================================

// GET /instances/:name/targets
app.get('/instances/:name/targets', async (req, res) => {
    const { name } = req.params;
    if (!validName(name)) return res.status(400).json({ ok: false, error: 'invalid name' });
    const instance = readInstanceRecord(name);
    if (!instance) return res.status(404).json({ ok: false, error: 'not found' });

    try {
        const resp = await callPluginWs(instance.pluginWsPort, instance.pluginWsPassword, 'GetStatus');
        const rawTargets = resp.targets || [];
        const targets = rawTargets.map((t) => ({
            id: String(t.id),
            name: t.name,
            protocol: t.protocol || 'RTMP',
            url: t.url,
            key: t.rtmp || t.key || '',
            status: t.status,
            syncStart: Boolean(t['sync-start'] ?? t.syncStart),
            syncStop: Boolean(t['sync-stop'] ?? t.syncStop),
            active: t.status === 'active' || t.status === 'live' || t.status === 'streaming'
        }));
        res.json({ ok: true, targets });
    } catch (e) {
        res.status(502).json({ ok: false, error: e.message });
    }
});

// POST /instances/:name/targets
app.post('/instances/:name/targets', async (req, res) => {
    const { name } = req.params;
    if (!validName(name)) return res.status(400).json({ ok: false, error: 'invalid name' });
    const instance = readInstanceRecord(name);
    if (!instance) return res.status(404).json({ ok: false, error: 'not found' });

    const { targetName, protocol, url, key, syncStart } = req.body || {};
    if (!targetName || !url) return res.status(400).json({ ok: false, error: 'targetName y url son obligatorios' });

    const isSync = syncStart !== false;
    const streamKey = (key || '').trim();
    try {
        const resp = await callPluginWs(instance.pluginWsPort, instance.pluginWsPassword, 'AddTarget', {
            name: targetName.trim(),
            protocol: protocol || 'RTMP',
            url: url.trim(),
            key: streamKey,
            rtmp: streamKey,
            'sync-start': isSync,
            'sync-stop': isSync
        });
        logAudit(req, 'target.add', name, { targetName, syncStart: isSync });
        res.json({ ok: true, resp });
    } catch (e) {
        res.status(502).json({ ok: false, error: e.message });
    }
});

// PUT /instances/:name/targets/:id
app.put('/instances/:name/targets/:id', async (req, res) => {
    const { name, id } = req.params;
    if (!validName(name)) return res.status(400).json({ ok: false, error: 'invalid name' });
    const instance = readInstanceRecord(name);
    if (!instance) return res.status(404).json({ ok: false, error: 'not found' });

    const { targetName, protocol, url, key, syncStart } = req.body || {};
    const isSync = syncStart !== false;
    const streamKey = key !== undefined ? key.trim() : undefined;
    try {
        const payload = {
            id,
            name: targetName ? targetName.trim() : undefined,
            protocol: protocol || 'RTMP',
            url: url ? url.trim() : undefined,
            'sync-start': isSync,
            'sync-stop': isSync
        };
        if (streamKey !== undefined) {
            payload.key = streamKey;
            payload.rtmp = streamKey;
        }
        const resp = await callPluginWs(instance.pluginWsPort, instance.pluginWsPassword, 'EditTarget', payload);
        logAudit(req, 'target.edit', name, { id, targetName, syncStart: isSync });
        res.json({ ok: true, resp });
    } catch (e) {
        res.status(502).json({ ok: false, error: e.message });
    }
});

// POST /instances/:name/targets/:id/toggle-sync
app.post('/instances/:name/targets/:id/toggle-sync', async (req, res) => {
    const { name, id } = req.params;
    if (!validName(name)) return res.status(400).json({ ok: false, error: 'invalid name' });
    const instance = readInstanceRecord(name);
    if (!instance) return res.status(404).json({ ok: false, error: 'not found' });

    try {
        const getResp = await callPluginWs(instance.pluginWsPort, instance.pluginWsPassword, 'GetStatus');
        const target = (getResp.targets || []).find((t) => String(t.id) === String(id));
        if (!target) return res.status(404).json({ ok: false, error: 'Target no encontrado' });

        const currentSync = Boolean(target['sync-start'] ?? target.syncStart);
        const newSync = !currentSync;
        const streamKey = target.rtmp || target.key || '';

        await callPluginWs(instance.pluginWsPort, instance.pluginWsPassword, 'EditTarget', {
            id: target.id,
            name: target.name,
            protocol: target.protocol || 'RTMP',
            url: target.url,
            key: streamKey,
            rtmp: streamKey,
            'sync-start': newSync,
            'sync-stop': newSync
        });
        logAudit(req, 'target.toggle_sync', name, { id, syncStart: newSync });
        res.json({ ok: true, syncStart: newSync });
    } catch (e) {
        res.status(502).json({ ok: false, error: e.message });
    }
});

// POST /instances/:name/targets/:id/toggle-stream
app.post('/instances/:name/targets/:id/toggle-stream', async (req, res) => {
    const { name, id } = req.params;
    if (!validName(name)) return res.status(400).json({ ok: false, error: 'invalid name' });
    const instance = readInstanceRecord(name);
    if (!instance) return res.status(404).json({ ok: false, error: 'not found' });

    try {
        const getResp = await callPluginWs(instance.pluginWsPort, instance.pluginWsPassword, 'GetStatus');
        const target = (getResp.targets || []).find((t) => String(t.id) === String(id));
        if (!target) return res.status(404).json({ ok: false, error: 'Target no encontrado' });

        const isStreaming = target.status === 'active' || target.status === 'live' || target.status === 'streaming';
        const cmd = isStreaming ? 'Stop' : 'Start';
        const resp = await callPluginWs(instance.pluginWsPort, instance.pluginWsPassword, cmd, { id: target.id });
        logAudit(req, 'target.toggle_stream', name, { id, action: cmd });
        res.json({ ok: true, action: cmd, resp });
    } catch (e) {
        res.status(502).json({ ok: false, error: e.message });
    }
});

// DELETE /instances/:name/targets/:id
app.delete('/instances/:name/targets/:id', async (req, res) => {
    const { name, id } = req.params;
    if (!validName(name)) return res.status(400).json({ ok: false, error: 'invalid name' });
    const instance = readInstanceRecord(name);
    if (!instance) return res.status(404).json({ ok: false, error: 'not found' });

    try {
        const resp = await callPluginWs(instance.pluginWsPort, instance.pluginWsPassword, 'DeleteTarget', { id });
        logAudit(req, 'target.delete', name, { id });
        res.json({ ok: true, resp });
    } catch (e) {
        res.status(502).json({ ok: false, error: e.message });
    }
});

app.delete('/instances/:name', async (req, res) => {
    const { name } = req.params;
    if (!validName(name)) return res.status(400).json({ ok: false, error: 'invalid name' });

    const downArgs = ['compose', '-p', `neko-${name}`, '-f', path.join(SCRIPT_DIR, 'docker-compose.yml'), 'down'];
    if (req.query.keepVolume !== 'true') downArgs.push('-v');

    try {
        await run('docker', downArgs, 60 * 1000);
        if (fs.existsSync(REGISTRY_FILE)) {
            const remaining = fs.readFileSync(REGISTRY_FILE, 'utf8')
                .split('\n')
                .filter((line) => line && !line.startsWith(`${name}\t`));
            fs.writeFileSync(REGISTRY_FILE, remaining.length ? remaining.join('\n') + '\n' : '');
        }
        // Drop this instance's Caddy route (https://<name>.CADDY_DOMAIN_SUFFIX)
        // -- unlike POST (which shells out to provision-neko-obs.sh, which
        // already does this itself), DELETE never touches provision-neko-obs.sh
        // or remove-neko-instance.sh, so it has to be called here explicitly.
        await run('bash', [path.join(SCRIPT_DIR, 'gen-caddyfile.sh')]).catch(() => {});
        const activity = readActivity();
        delete activity[name];
        fs.writeFileSync(ACTIVITY_FILE, JSON.stringify(activity));
        setIngestUrl(name, '');
        logAudit(req, 'instance.delete', name, { keepVolume: req.query.keepVolume === 'true' });
        res.json({ ok: true, status: 'removed' });
    } catch (e) {
        res.status(500).json({ ok: false, error: e.message, stdout: e.stdout, stderr: e.stderr });
    }
});

// ---- FILE MANAGEMENT (docker exec into /irlcontrol volume) ----
// Proxies file operations into the running container's /irlcontrol directory
// so the frontend can list/upload/download/delete files without needing
// direct WebRTC file-transfer (which requires an active Neko session).

const CONTAINER_FILES_DIR = '/irlcontrol';

function containerName(instanceName) {
    return `neko-${instanceName}-obs-1`;
}

// GET /instances/:name/files  — list files in /irlcontrol
app.get('/instances/:name/files', async (req, res) => {
    const { name } = req.params;
    if (!validName(name)) return res.status(400).json({ ok: false, error: 'invalid name' });
    try {
        // stat each entry: name, size, mtime
        const { stdout } = await run('docker', [
            'exec', containerName(name),
            'find', CONTAINER_FILES_DIR, '-maxdepth', '1', '-type', 'f',
            '-printf', '%f\\t%s\\t%T@\\n',
        ], 10000);
        const files = stdout.trim().split('\n').filter(Boolean).map((line) => {
            const [fname, size, mtime] = line.split('\t');
            return { name: fname, size: Number(size), mtime: Number(mtime) };
        });
        res.json({ ok: true, files });
    } catch (e) {
        // If container is not running, say so clearly
        if (/No such container|is not running/i.test(e.message || e.stderr || '')) {
            return res.status(409).json({ ok: false, error: 'La instancia no está corriendo' });
        }
        res.status(500).json({ ok: false, error: e.message });
    }
});

// GET /instances/:name/files/:filename  — download a file
app.get('/instances/:name/files/:filename', async (req, res) => {
    const { name, filename } = req.params;
    if (!validName(name)) return res.status(400).json({ ok: false, error: 'invalid name' });
    if (!filename || /[\/\0]/.test(filename)) return res.status(400).json({ ok: false, error: 'invalid filename' });
    const filePath = `${CONTAINER_FILES_DIR}/${filename}`;
    try {
        // Check file exists and get size
        const { stdout: statOut } = await run('docker', [
            'exec', containerName(name), 'stat', '-c', '%s', filePath,
        ], 5000);
        const size = parseInt(statOut.trim(), 10);

        res.setHeader('Content-Disposition', `attachment; filename="${encodeURIComponent(filename)}"`);
        res.setHeader('Content-Length', size);
        res.setHeader('Content-Type', 'application/octet-stream');

        // Stream file content via docker exec cat
        const { spawn: spawnProc } = require('child_process');
        const proc = spawnProc('docker', ['exec', containerName(name), 'cat', filePath]);
        proc.stdout.pipe(res);
        proc.stderr.on('data', () => {});
        proc.on('error', (err) => { if (!res.headersSent) res.status(500).json({ ok: false, error: err.message }); });
        proc.on('close', (code) => { if (code !== 0 && !res.headersSent) res.status(500).end(); });
    } catch (e) {
        if (!res.headersSent) res.status(500).json({ ok: false, error: e.message });
    }
});

// POST /instances/:name/files  — upload a file (raw body, filename in header)
// Content-Type: application/octet-stream, X-Filename: <name>
app.post('/instances/:name/files', (req, res) => {
    const { name } = req.params;
    if (!validName(name)) return res.status(400).json({ ok: false, error: 'invalid name' });
    const filename = req.headers['x-filename'];
    if (!filename || /[\/\0]/.test(filename)) return res.status(400).json({ ok: false, error: 'Missing or invalid X-Filename header' });
    const filePath = `${CONTAINER_FILES_DIR}/${filename}`;

    const { spawn: spawnProc } = require('child_process');
    const proc = spawnProc('docker', [
        'exec', '-i', containerName(name), 'tee', filePath,
    ], { stdio: ['pipe', 'pipe', 'pipe'] });

    req.pipe(proc.stdin);
    let stderr = '';
    proc.stderr.on('data', (d) => { stderr += d; });
    proc.stdout.on('data', () => {}); // tee echoes to stdout, ignore it

    proc.on('close', (code) => {
        if (code !== 0) {
            return res.status(500).json({ ok: false, error: `Upload failed: ${stderr}` });
        }
        logAudit(req, 'file.upload', name, { filename });
        res.json({ ok: true, filename });
    });
    proc.on('error', (err) => {
        if (!res.headersSent) res.status(500).json({ ok: false, error: err.message });
    });
});

// DELETE /instances/:name/files/:filename  — delete a file
app.delete('/instances/:name/files/:filename', async (req, res) => {
    const { name, filename } = req.params;
    if (!validName(name)) return res.status(400).json({ ok: false, error: 'invalid name' });
    if (!filename || /[\/\0]/.test(filename)) return res.status(400).json({ ok: false, error: 'invalid filename' });
    const filePath = `${CONTAINER_FILES_DIR}/${filename}`;
    try {
        await run('docker', ['exec', containerName(name), 'rm', '-f', filePath], 5000);
        logAudit(req, 'file.delete', name, { filename });
        res.json({ ok: true });
    } catch (e) {
        res.status(500).json({ ok: false, error: e.message });
    }
});

// ---- WS + MPEG-TS relay for Program Preview (mpegtsWatchUrl above) ----
// Remuxes (no re-encode, -c copy) the live RTMP feed into MPEG-TS chunks
// over a plain WebSocket -- no ICE/DTLS/STUN/TURN negotiation at all, so
// connection setup is close to instant (a client-side mpegts.js player,
// MSE-based) compared to WebRTC/WHEP, at the cost of a bit more
// steady-state latency (~1-2s instead of sub-second). Pulls from
// nginx-rtmp's "watch" app (rtmp.conf), the SAME source MediaMTX's WebRTC
// path and the HLS fallback both already use -- whichever encoder is
// currently live under this key (the always-on dedicated preview one, or
// the main stream's reused one once it swaps in, see obs-multi-rtmp.cpp)
// just keeps flowing through unchanged.
const { spawn } = require('child_process');
const mpegtsWss = new WebSocket.Server({ noServer: true });
mpegtsWss.on('connection', (ws, req, key) => {
    const ff = spawn('ffmpeg', [
        '-i', `rtmp://127.0.0.1:1935/watch/${key}`,
        '-c', 'copy',
        '-f', 'mpegts',
        '-mpegts_flags', '+initial_discontinuity',
        '-flush_packets', '1',
        'pipe:1',
    ]);
    ff.stdout.on('data', (chunk) => {
        if (ws.readyState === WebSocket.OPEN) ws.send(chunk, { binary: true });
    });
    ff.stderr.on('data', () => {}); // swallow ffmpeg's own log noise
    ff.on('error', () => { try { ws.close(); } catch {} });
    ff.on('close', () => { try { ws.close(); } catch {} });
    ws.on('close', () => { try { ff.kill('SIGKILL'); } catch {} });
    ws.on('error', () => { try { ff.kill('SIGKILL'); } catch {} });
});

const server = app.listen(PORT, () => {
    console.log(`neko-api-server listening on :${PORT}`);
});
server.on('upgrade', (req, socket, head) => {
    let pathname;
    try {
        pathname = new URL(req.url, 'http://x').pathname;
    } catch {
        socket.destroy();
        return;
    }
    const m = pathname.match(/^\/mpegts\/([^/]+)$/);
    if (!m) {
        socket.destroy();
        return;
    }
    const key = decodeURIComponent(m[1]);
    mpegtsWss.handleUpgrade(req, socket, head, (ws) => {
        mpegtsWss.emit('connection', ws, req, key);
    });
});

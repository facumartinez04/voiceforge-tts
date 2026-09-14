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
};
const CONFIG_DEFAULTS = {
    rtmpServerUrl: '',
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
        const ws = new WebSocket(url);
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
        RTMP_SERVER_URL: body.rtmpServerUrl || cfg.rtmpServerUrl || '',
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

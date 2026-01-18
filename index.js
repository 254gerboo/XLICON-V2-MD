const { default: makeWASocket, useMultiFileAuthState, DisconnectReason, downloadMediaMessage, generateWAMessageFromContent, fetchLatestWaWebVersion, proto } = require('@whiskeysockets/baileys');
const pino = require('pino');
const fs = require('fs');
const path = require('path');
const http = require('http');
const QRCode = require('qrcode');
const { Boom } = require('@hapi/boom');
const { sendButtons, sendInteractiveMessage } = require('gifted-btns');
const serializeMessage = require('./handler.js');

global.generateWAMessageFromContent = generateWAMessageFromContent;
global.proto = proto;
require('./config')

if (!fs.existsSync(__dirname + '/session/creds.json') && global.sessionid) {
    try {
        const sessionData = JSON.parse(global.sessionid);
        fs.mkdirSync(__dirname + '/session', { recursive: true });
        fs.writeFileSync(__dirname + '/session/creds.json', JSON.stringify(sessionData, null, 2));
    } catch (err) {
        console.error('Error restoring session:', err);
    }
}

global.BOT_PREFIX = '.';
const AUTH_FOLDER = './session';
const PLUGIN_FOLDER = './plugins';
const PORT = process.env.PORT || 3000;

let latestQR = '';
let botStatus = 'disconnected';
let pairingCodes = new Map();
let presenceInterval = null;
let sock = null;
let isConnecting = false;

function loadPrefix() {
    const configPath = path.join(__dirname, 'config.json');
    if (fs.existsSync(configPath)) {
        try {
            const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
            if (config.prefix) {
                global.BOT_PREFIX = config.prefix;
                console.log(`Loaded prefix: ${global.BOT_PREFIX}`);
            }
        } catch (err) {
            console.error('Error loading config:', err);
        }
    }
    startBot();
}

function startBot() {
    console.log('Starting WhatsApp Bot...');
    isConnecting = true;
    
    if (!fs.existsSync(AUTH_FOLDER)) {
        fs.mkdirSync(AUTH_FOLDER, { recursive: true });
    }
    
    const credsPath = path.join(AUTH_FOLDER, 'creds.json');
    if (fs.existsSync(credsPath)) {
        try {
            const creds = JSON.parse(fs.readFileSync(credsPath, 'utf8'));
            if (creds.noiseKey && creds.noiseKey.private) {
                console.log('Using existing session...');
            } else {
                console.log('Invalid session detected, will create new one...');
            }
        } catch (err) {
            console.log('Corrupted session, will create new one...');
        }
    }

    (async () => {
        try {
            const { version, isLatest } = await fetchLatestWaWebVersion();
            console.log(`Using WA v${version.join(".")}, isLatest: ${isLatest}`);

            const { state, saveCreds } = await useMultiFileAuthState(AUTH_FOLDER);
            
            sock = makeWASocket({
                version, 
                logger: pino({ level: 'info' }),
                auth: state,
                printQRInTerminal: true,
                keepAliveIntervalMs: 10000,
                markOnlineOnConnect: true,
                syncFullHistory: false,
                browser: ['Bot', 'Chrome', '1.0.0']
            });
            
            sock.ev.on('connection.update', async (update) => {
                const { connection, lastDisconnect, qr } = update;

                if (qr) {
                    console.log('Generating QR code...');
                    QRCode.toDataURL(qr, (err, url) => { 
                        if (!err) {
                            latestQR = url;
                        }
                    });
                }

                if (connection === 'close') {
                    botStatus = 'disconnected';
                    isConnecting = false;
                    if (presenceInterval) {
                        clearInterval(presenceInterval);
                        presenceInterval = null;
                    }

                    const statusCode = (lastDisconnect?.error instanceof Boom)
                        ? lastDisconnect.error.output.statusCode
                        : 0;

                    const shouldReconnect = statusCode !== DisconnectReason.loggedOut;

                    console.log(
                        "Connection closed:",
                        lastDisconnect?.error?.message,
                        "reconnecting:",
                        shouldReconnect
                    );

                    if (shouldReconnect) {
                        console.log('Reconnecting in 5 seconds...');
                        setTimeout(() => startBot(), 5000);
                    } else {
                        console.log('Logged out. Cleaning up session...');
                        if (fs.existsSync(AUTH_FOLDER)) {
                            fs.rmSync(AUTH_FOLDER, { recursive: true, force: true });
                            console.log('Session folder removed');
                        }
                        setTimeout(() => startBot(), 3000);
                    }
                } else if (connection === 'open') {
                    botStatus = 'connected';
                    isConnecting = false;
                    console.log('Bot is connected!');

                    presenceInterval = setInterval(() => {
                        if (sock?.ws?.readyState === 1) {
                            sock.sendPresenceUpdate('available');
                        }
                    }, 10000);

                    try { 
                        await sock.sendMessage(sock.user.id, { 
                            text: `Bot linked successfully!\nPrefix: ${global.BOT_PREFIX}\nConnected: ${new Date().toLocaleString()}` 
                        }); 
                    } catch (err) { 
                        console.error('Could not send welcome message:', err); 
                    }
                } else if (connection === 'connecting') {
                    botStatus = 'connecting';
                    isConnecting = true;
                    console.log('Bot is connecting...');
                }
            });

            sock.ev.on('creds.update', async () => {
                await saveCreds();
                console.log('Credentials updated');
            });

            const plugins = new Map();
            const pluginPath = path.join(__dirname, PLUGIN_FOLDER);
            
            if (fs.existsSync(pluginPath)) {
                try {
                    const pluginFiles = fs.readdirSync(pluginPath).filter(file => file.endsWith('.js'));
                    
                    for (const file of pluginFiles) {
                        try {
                            const plugin = require(path.join(pluginPath, file));
                            if (plugin.name && typeof plugin.execute === 'function') {
                                plugins.set(plugin.name.toLowerCase(), plugin);
                                if (Array.isArray(plugin.aliases)) {
                                    plugin.aliases.forEach(alias => {
                                        plugins.set(alias.toLowerCase(), plugin);
                                    });
                                }
                                console.log(`Loaded plugin: ${plugin.name}`);
                            } else {
                                console.warn(`Invalid plugin structure in ${file}`);
                            }
                        } catch (error) {
                            console.error(`Failed to load plugin ${file}:`, error.message);
                        }
                    }
                    console.log(`Total plugins loaded: ${plugins.size}`);
                } catch (error) {
                    console.error('Error loading plugins:', error);
                }
            } else {
                console.log('No plugins folder found');
            }
           
            sock.ev.on('messages.upsert', async ({ messages, type }) => {
                if (type !== 'notify') return;
                
                for (const rawMsg of messages) {
                    if (rawMsg.key.remoteJid === 'status@broadcast' && rawMsg.key.participant) {
                        try {
                            await sock.readMessages([rawMsg.key]);
                            continue;
                        } catch (err) {
                            console.log('Status viewer error:', err.message);
                        }
                    }
                }

                const rawMsg = messages[0];
                if (!rawMsg.message) return;

                const m = await serializeMessage(sock, rawMsg);
                
                if (m.body.startsWith(global.BOT_PREFIX)) {
                    const args = m.body.slice(global.BOT_PREFIX.length).trim().split(/\s+/);
                    const commandName = args.shift().toLowerCase();
                    const plugin = plugins.get(commandName);
                    
                    if (plugin) {
                        try { 
                            await plugin.execute(sock, m, args); 
                        } catch (err) { 
                            console.error(`Plugin error (${commandName}):`, err); 
                            await m.reply('Error running command.'); 
                        }
                    }
                }
                
                for (const plugin of plugins.values()) {
                    if (typeof plugin.onMessage === 'function') {
                        try { 
                            await plugin.onMessage(sock, m); 
                        } catch (err) { 
                            console.error(`onMessage error (${plugin.name}):`, err); 
                        }
                    }
                }
            });

            sock.ev.on('group-participants.update', async (update) => {
                console.log('Group update:', update);
            });

            sock.ev.on('messages.reaction', async (reactions) => {
                console.log('Reaction update:', reactions);
            });

        } catch (error) {
            console.error('Bot startup error:', error);
            isConnecting = false;
            setTimeout(() => startBot(), 10000);
        }
    })();
}

const server = http.createServer((req, res) => {
    const url = req.url;
    
    if (url === '/api/status') {
        res.writeHead(200, { 
            'Content-Type': 'application/json',
            'Access-Control-Allow-Origin': '*'
        });
        res.end(JSON.stringify({ 
            status: botStatus,
            hasQR: !!latestQR,
            qr: latestQR,
            prefix: global.BOT_PREFIX,
            timestamp: new Date().toISOString(),
            uptime: process.uptime()
        }));
    } else {
        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ 
            error: 'Not found',
            available_endpoints: ['/api/status']
        }));
    }
});

server.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
    console.log(`Status API: http://localhost:${PORT}/api/status`);
    loadPrefix();
});

process.on('SIGINT', () => {
    console.log('Shutting down...');
    if (presenceInterval) clearInterval(presenceInterval);
    if (sock) sock.end();
    process.exit(0);
});

process.on('uncaughtException', (err) => {
    console.error('Uncaught Exception:', err);
});

process.on('unhandledRejection', (reason, promise) => {
    console.error('Unhandled Rejection:', reason);
});

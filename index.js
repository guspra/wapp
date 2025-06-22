// Polyfill for the Web Crypto API
const { webcrypto } = require('crypto');
if (typeof globalThis.crypto === 'undefined') {
  globalThis.crypto = webcrypto;
}

const { default: makeWASocket, useMultiFileAuthState, DisconnectReason, fetchLatestBaileysVersion } = require('@whiskeysockets/baileys');
const pino = require('pino');
const express = require('express');
const path = require('path');
const http = require('http');
const { Server } = require("socket.io");
const fs = require('fs/promises');
const QRCode = require('qrcode');

const app = express();
const server = http.createServer(app);
const io = new Server(server);
const port = process.env.PORT || 3000;

// Middleware
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, 'public')));

// Centralized application state
let sock;
let connectionStatus = {
    connected: false,
    message: 'Initializing...',
    user: null,
    qr: null,
};
let isConnecting = false;

// Function to broadcast the current status to all clients
function broadcastStatus() {
    io.emit('status', connectionStatus);
}

async function cleanSession() {
    console.log('Attempting to clean session data...');
    try {
        const sessionDir = 'baileys_auth_info';
        const files = await fs.readdir(sessionDir);
        await Promise.all(files.map(file => fs.unlink(path.join(sessionDir, file))));
        console.log('Session files cleaned successfully.');
    } catch (error) {
        if (error.code !== 'ENOENT') { // Ignore if the directory doesn't exist
            console.error('Error cleaning session files:', error);
        }
    }
}

function handleLogoutAndRestart(message) {
    console.log(message);
    connectionStatus = { ...connectionStatus, message: 'Session ended. Restarting...', qr: null };
    broadcastStatus();

    cleanSession().finally(() => {
        // A short delay to allow the status message to be sent before exiting.
        setTimeout(() => process.exit(1), 1000);
    });
}

/**
 * Connects to WhatsApp and sets up event listeners.
 */
async function connectToWhatsApp() {
    if (isConnecting) {
        console.log('Connection attempt already in progress. Skipping.');
        return;
    }
    isConnecting = true;
    connectionStatus = { connected: false, message: 'Connecting to WhatsApp...', user: null, qr: null };
    broadcastStatus();

    const { state, saveCreds } = await useMultiFileAuthState('baileys_auth_info');
    const { version, isLatest } = await fetchLatestBaileysVersion();
    console.log(`Using WA version v${version.join('.')}, isLatest: ${isLatest}`);

    sock = makeWASocket({
        version,
        auth: state,
        printQRInTerminal: false,
        logger: pino({ level: 'silent' }),
    });

    sock.ev.on('creds.update', saveCreds);

    sock.ev.on('connection.update', (update) => {
        const { connection, lastDisconnect, qr } = update;

        if (qr) {
            console.log('QR code received, generating data URL...');
            QRCode.toDataURL(qr, (err, url) => {
                if (err) {
                    console.error('Failed to generate QR data URL', err);
                    connectionStatus = { ...connectionStatus, message: 'Error generating QR code.' };
                } else {
                    console.log('QR data URL generated.');
                    connectionStatus = { connected: false, message: 'QR code received. Please scan.', user: null, qr: url };
                }
                broadcastStatus();
            });
        }

        if (connection === 'close') {
            sock = null;
            isConnecting = false;
            const statusCode = (lastDisconnect.error)?.output?.statusCode;
            const shouldReconnect = statusCode !== DisconnectReason.loggedOut;
            
            if (shouldReconnect) {
                console.log('Connection lost. Reconnecting...');
                connectionStatus = { connected: false, message: 'Connection lost. Reconnecting...', user: null, qr: null };
                broadcastStatus();
                setTimeout(connectToWhatsApp, 5000);
            } else {
                // This is a definitive logout.
                handleLogoutAndRestart('Session logged out. Forcing container restart...');
            }
        } else if (connection === 'open') {
            const { id, name } = sock.user;
            const number = id.split('@')[0].split(':')[0]; // This now removes the device ID
            connectionStatus = {
                connected: true,
                message: 'Connected',
                user: { id, name, number },
                qr: null
            };
            console.log(`WhatsApp connection opened successfully. Connected as: ${name || 'No Name'} (${number}) [Device ID: ${id.split(':')[1]?.split('@')[0] || 'N/A'}]`);
            broadcastStatus();
            isConnecting = false;
        }
    });

    return sock;
}

// API endpoint to send a message
app.post('/send-message', async (req, res) => {
    const { number, message } = req.body;

    if (!number || !message) {
        return res.status(400).json({ success: false, message: 'Number and message are required.' });
    }

    if (!sock || !connectionStatus.connected) {
        return res.status(500).json({ success: false, message: 'Client not connected. Cannot send message.' });
    }

    try {
        const jid = number.includes('@s.whatsapp.net') ? number : `${number}@s.whatsapp.net`;
        const [result] = await sock.onWhatsApp(jid);
        if (!result?.exists) {
             return res.status(400).json({ success: false, message: `Number ${number} is not on WhatsApp.` });
        }

        await sock.sendMessage(jid, { text: message });
        res.json({ success: true, message: 'Message sent successfully.' });
    } catch (error) {
        console.error('Error sending message:', error);
        res.status(500).json({ success: false, message: 'Failed to send message.' });
    }
});

// API endpoint to get connection status
app.get('/status', (req, res) => {
    res.json({
        success: true,
        ...connectionStatus
    });
});

// API endpoint to log out
app.post('/logout', async (req, res) => {
    if (sock) {
        await sock.logout();
        res.json({ success: true, message: 'Logout initiated successfully.' });
    } else {
        handleLogoutAndRestart('No active session found. Forcing restart...');
        res.json({ success: true, message: 'No active session. Initiating restart.' });
    }
});

// Handle Socket.IO connections
io.on('connection', (socket) => {
    console.log('A user connected to the frontend.');
    broadcastStatus();
    socket.on('disconnect', () => {
        console.log('User disconnected from the frontend.');
    });
});

server.listen(port, () => {
    console.log(`Server is running on http://localhost:${port}`);
    connectToWhatsApp().catch(err => console.log("Unexpected error during initial connection: " + err));
});

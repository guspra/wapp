// Polyfill for the Web Crypto API
const { webcrypto } = require('crypto');
if (typeof globalThis.crypto === 'undefined') {
  globalThis.crypto = webcrypto;
}

const { default: makeWASocket, useMultiFileAuthState, DisconnectReason, fetchLatestBaileysVersion } = require('@whiskeysockets/baileys');
const pino = require('pino');
const express = require('express');
const qrcode = require('qrcode-terminal');
const path = require('path');

const app = express();
const port = process.env.PORT || 3000;

// Middleware
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, 'public')));

let sock;

/**
 * Connects to WhatsApp and sets up event listeners.
 */
async function connectToWhatsApp() {
    const { state, saveCreds } = await useMultiFileAuthState('baileys_auth_info');
    const { version, isLatest } = await fetchLatestBaileysVersion();
    console.log(`Using WA version v${version.join('.')}, isLatest: ${isLatest}`);

    sock = makeWASocket({
        version,
        auth: state,
        printQRInTerminal: false, // We'll handle QR display ourselves
        logger: pino({ level: 'silent' }), // Set to 'info' for detailed logs
    });

    // Handle saving credentials
    sock.ev.on('creds.update', saveCreds);

    // Handle connection updates
    sock.ev.on('connection.update', (update) => {
        const { connection, lastDisconnect, qr } = update;

        if (qr) {
            console.log('QR code received, please scan with your phone:');
            qrcode.generate(qr, { small: true });
        }

        if (connection === 'close') {
            const shouldReconnect = (lastDisconnect.error)?.output?.statusCode !== DisconnectReason.loggedOut;
            console.log('Connection closed due to', lastDisconnect.error, ', reconnecting:', shouldReconnect);
            if (shouldReconnect) {
                connectToWhatsApp();
            }
        } else if (connection === 'open') {
            const { id, name } = sock.user;
            const number = id.split('@')[0];
            console.log(`WhatsApp connection opened successfully. Connected as: ${name || 'No Name'} (${number})`);
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

    try {
        // Format the number to WhatsApp JID (e.g., 1234567890@s.whatsapp.net)
        const jid = number.includes('@s.whatsapp.net') ? number : `${number}@s.whatsapp.net`;
        
        // Check if the number exists on WhatsApp
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
    if (sock && sock.user) {
        res.json({
            success: true,
            message: 'Connected',
            user: {
                id: sock.user.id,
                name: sock.user.name,
                number: sock.user.id.split('@')[0]
            }
        });
    } else {
        // Use 503 Service Unavailable, as the service is running but not ready
        res.status(503).json({ success: false, message: 'Client not connected. Please scan the QR code.' });
    }
});

app.listen(port, () => {
    console.log(`Server is running on http://localhost:${port}`);
    connectToWhatsApp().catch(err => console.log("Unexpected error during connection: " + err));
});
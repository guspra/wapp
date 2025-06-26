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
const schedule = require('node-schedule');
const { zonedTimeToUtc, format } = require('date-fns-tz');

const app = express();
const router = express.Router();
const server = http.createServer(app);
const io = new Server(server, {
  path: '/wapp/socket.io',
});
const port = process.env.PORT || 3000;

// Middleware
// Serve static files from the root of the /wapp path
router.use(express.static(path.join(__dirname, 'public')));
app.use(express.json()); // Apply to main app for new API endpoint
app.use(express.urlencoded({ extended: true })); // Apply to main app

// Centralized application state
let sock;
let connectionStatus = {
    connected: false,
    message: 'Initializing...',
    user: null,
    qr: null,
};
const activeScheduledJobs = new Map(); // Map<jobId, { number: string, message: string, scheduledTime: Date, timezone: string, jobInstance: Job }>
let isConnecting = false;

// Reusable function to send a WhatsApp message
async function sendMessage(number, message) {
    if (!sock || !connectionStatus.connected) {
        throw new Error('Client not connected.');
    }
    const jid = number.includes('@s.whatsapp.net') ? number : `${number}@s.whatsapp.net`;
    const [result] = await sock.onWhatsApp(jid);
    if (!result?.exists) {
        throw new Error(`Number ${number} is not on WhatsApp.`);
    }
    await sock.sendMessage(jid, { text: message });
}


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
            broadcastScheduledJobs(); // Broadcast scheduled jobs on successful connection
        }
    });

    // NEW FEATURE: Listen for "scrapcmax" and reply
    sock.ev.on('messages.upsert', async ({ messages }) => {
        for (const m of messages) {
            if (m.key.fromMe || !m.message) continue; // Ignore outgoing messages or messages without content

            const incomingText = m.message.conversation || m.message.extendedTextMessage?.text;

            if (incomingText && incomingText.toLowerCase() === 'scrapcmax') {
                console.log(`Received "scrapcmax" from ${m.key.remoteJid}. Triggering scraper API...`);
                try {
                    // Using GET request to the host machine's scraper API
                    // 'host.docker.internal' is a special DNS name that resolves to the host machine's IP from within a Docker container.
                    const response = await fetch('http://host.docker.internal:3001/scraper/api', { method: 'GET' });
                    if (response.ok) {
                        console.log(`Scraper API triggered successfully. Status: ${response.status}, Response: ${await response.text()}`);
                    } else {
                        console.error(`Failed to trigger scraper API. Status: ${response.status}, Message: ${await response.text()}`);
                    }
                } catch (error) {
                    console.error('Error calling scraper API:', error.message);
                }
            }
        }
    });

    return sock;
}

// API endpoint to send a message
// Function to broadcast the current list of scheduled jobs to all clients
function broadcastScheduledJobs() {
    const jobsData = Array.from(activeScheduledJobs.entries()).map(([id, jobInfo]) => ({
        id: id,
        number: jobInfo.number,
        message: jobInfo.message,
        scheduledTime: jobInfo.scheduledTime.toISOString(), // Send as ISO string
        timezone: jobInfo.timezone,
    }));
    io.emit('scheduledJobsUpdate', jobsData);
    console.log('Broadcasting scheduled jobs update:', jobsData.length, 'jobs');
}

// API endpoint to send a message or schedule it (for the web UI)
router.post('/send-message', async (req, res) => {
    const { number, message, schedule: scheduleOptions } = req.body;

    if (!number || !message) {
        return res.status(400).json({ success: false, message: 'Number and message are required.' });
    }

    if (scheduleOptions) {
        const { date, time, timezone } = scheduleOptions;
        const dateTimeString = `${date}T${time}:00`;
        const jobId = `job-${Date.now()}-${Math.random().toString(36).substring(2, 9)}`; // Unique ID for the job

        try {
            const scheduledDate = zonedTimeToUtc(dateTimeString, timezone);

            if (scheduledDate < new Date()) {
                return res.status(400).json({ success: false, message: 'Scheduled time is in the past.' });
            }

            // Schedule the job
            const job = schedule.scheduleJob(jobId, scheduledDate, () => {
                console.log(`Executing scheduled job for ${number}`);
                sendMessage(number, message).catch(err => {
                    console.error(`Failed to send scheduled message to ${number}:`, err.message);
                }).finally(() => {
                    // Remove job from active list after execution
                    activeScheduledJobs.delete(jobId);
                    broadcastScheduledJobs();
                });
            });

            // Store job details
            activeScheduledJobs.set(jobId, {
                number,
                message,
                scheduledTime: scheduledDate,
                timezone,
                jobInstance: job, // Store the job instance for cancellation
            });

            // Format a user-friendly response
            const formattedDate = format(scheduledDate, 'yyyy-MM-dd HH:mm:ss zzz', { timeZone: timezone });
            const responseMessage = `Message scheduled for ${formattedDate}.`;
            console.log(responseMessage);
            broadcastScheduledJobs(); // Broadcast update after scheduling

            res.json({ success: true, message: responseMessage });
        } catch (error) {
            console.error('Error scheduling message:', error);
            return res.status(500).json({ success: false, message: 'Invalid date, time, or timezone for scheduling.' });
        }
    } else {
        // Send immediately
        try {
            await sendMessage(number, message);
            res.json({ success: true, message: 'Message sent successfully.' });
        } catch (error) {
            console.error('Error sending message:', error.message);
            res.status(500).json({ success: false, message: error.message || 'Failed to send message.' });
        }
    }
});

// NEW: Simple API endpoint to send a chat message (for external use)
app.post('/wapp/api/sendchat', async (req, res) => {
    const { number, text } = req.body;

    if (!number || !text) {
        return res.status(400).json({ success: false, message: 'Recipient number and text are required.' });
    }

    try {
        await sendMessage(number, text);
        res.json({ success: true, message: 'Message sent successfully.' });
    } catch (error) {
        console.error('API Error sending message:', error.message);
        if (error.message.includes('not connected')) {
            return res.status(503).json({ success: false, message: error.message, hint: 'WhatsApp client is not connected. Scan QR code.' });
        }
        if (error.message.includes('not on WhatsApp')) {
            return res.status(404).json({ success: false, message: error.message });
        }
        res.status(500).json({ success: false, message: error.message || 'Failed to send message.' });
    }
});



// API endpoint to get all scheduled messages
router.get('/scheduled-messages', (req, res) => {
    const jobsData = Array.from(activeScheduledJobs.entries()).map(([id, jobInfo]) => ({
        id: id,
        number: jobInfo.number,
        message: jobInfo.message,
        scheduledTime: jobInfo.scheduledTime.toISOString(),
        timezone: jobInfo.timezone,
    }));
    res.json({ success: true, scheduledJobs: jobsData });
});

// API endpoint to cancel a scheduled message
router.post('/cancel-schedule', (req, res) => {
    const { jobId } = req.body;
    const jobInfo = activeScheduledJobs.get(jobId);

    if (jobInfo && jobInfo.jobInstance.cancel()) {
        activeScheduledJobs.delete(jobId);
        broadcastScheduledJobs(); // Broadcast update after cancellation
        res.json({ success: true, message: `Scheduled message ${jobId} cancelled.` });
    } else {
        res.status(404).json({ success: false, message: `Scheduled message ${jobId} not found or could not be cancelled.` });
    }
});

// API endpoint to get connection status
router.get('/status', (req, res) => {
    res.json({
        success: true,
        ...connectionStatus
    });
});

// API endpoint to log out
router.post('/logout', async (req, res) => {
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
        // No need to broadcast status here, as the connection status is handled by Baileys events
        console.log('User disconnected from the frontend.');
    });
});

// Mount the router to the /wapp path
app.use('/wapp', router);

server.listen(port, () => {
    console.log(`Server is running on http://localhost:${port}`);
    connectToWhatsApp().catch(err => console.log("Unexpected error during initial connection: " + err));
});

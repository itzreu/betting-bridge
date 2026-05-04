const { Client, LocalAuth } = require('whatsapp-web.js');
const qrcode = require('qrcode');
const fetch = require('node-fetch');
const express = require('express');
const chromium = require('@sparticuz/chromium');

const APPS_SCRIPT_URL = process.env.APPS_SCRIPT_URL;
const BRIDGE_TOKEN = process.env.BRIDGE_TOKEN;
const ADMIN_NUMBER = process.env.ADMIN_NUMBER;
const PORT = process.env.PORT || 3000;

const app = express();
app.use(express.json());

let qrDataUrl = null;
let clientStatus = 'disconnected';
let lastConnectedTime = null;
let qrGenerated = false;
let client = null;

// ==========================================
// ✅ NEW: Robust LID to Phone Number Converter
// ==========================================
async function resolveNumber(waId) {
    try {
        // The ID passed to getContactById can be in any format: @c.us, @lid, etc.
        const contact = await client.getContactById(waId);
        // The contact object has a 'number' property which is always the clean phone number.
        return contact.number;
    } catch (err) {
        console.error('Could not resolve contact for ID:', waId, err);
        // Fallback: if we can't resolve it, try to extract digits as a last resort.
        const digits = waId.replace(/\D/g, '');
        return digits || null;
    }
}

// ========== Routes (Mostly unchanged) ==========
app.get('/health', (req, res) => res.send('OK'));

app.get('/qr', (req, res) => {
    if (clientStatus === 'connected') {
        res.send(`<html><head><title>Already connected</title><meta http-equiv="refresh" content="3;url=/dashboard?token=${BRIDGE_TOKEN}"></head>
        <body style="font-family:sans-serif;text-align:center;padding:50px;"><h1>✅ Already connected!</h1><p>Redirecting to dashboard...</p></body></html>`);
        return;
    }
    if (!qrDataUrl) {
        res.send('<h2>QR code not ready yet. Refresh in a few seconds.</h2>');
        return;
    }
    res.send(`<html><head><title>WhatsApp QR</title>
        <meta http-equiv="refresh" content="15">
        <script>
          setInterval(async () => {
            const r = await fetch('/status');
            const s = await r.json();
            if (s.status === 'connected') window.location.href = '/qr-connected?token=${BRIDGE_TOKEN}';
          }, 5000);
        </script>
        </head>
        <body style="text-align:center;background:#111;color:white;font-family:sans-serif;">
          <h1>Scan with WhatsApp</h1>
          <img src="${qrDataUrl}" style="border:10px solid white;border-radius:20px;">
          <p>Settings → Linked Devices → Link a Device</p>
        </body></html>`);
});

app.get('/qr-connected', (req, res) => {
    res.send(`<html><head><title>Connected ✅</title>
        <script>setTimeout(() => window.close(), 3000);</script></head>
        <body style="font-family:sans-serif;text-align:center;padding:50px;">
          <h1>✅ WhatsApp is connected!</h1><p>You can close this tab.</p>
        </body></html>`);
});

app.get('/status', (req, res) => {
    res.json({
        status: clientStatus,
        qrReady: qrGenerated,
        lastConnected: lastConnectedTime ? lastConnectedTime.toISOString() : null,
        estimatedExpiry: lastConnectedTime ? new Date(lastConnectedTime.getTime() + 7*24*60*60*1000).toISOString() : null
    });
});

app.get('/dashboard', async (req, res) => {
    if (req.query.token !== BRIDGE_TOKEN) return res.status(403).send('Forbidden');
    try {
        const dataResp = await fetch(`${APPS_SCRIPT_URL}?token=${BRIDGE_TOKEN}&action=dashboard`);
        const data = await dataResp.json();
        const statusResp = await fetch(`http://localhost:${PORT}/status`);
        const botStatus = await statusResp.json();
        res.send(generateDashboardHTML(data, botStatus));
    } catch (err) {
        res.send('Error loading dashboard: ' + err.message);
    }
});

// Payout and Logout routes remain unchanged from your last working version...

// ========== WhatsApp Client ==========
async function startClient() {
    const execPath = await chromium.executablePath();
    console.log('Chromium executable:', execPath);

    client = new Client({
        authStrategy: new LocalAuth(),
        puppeteer: {
            executablePath: execPath,
            headless: 'new',
            args: [
                ...chromium.args,
                '--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage',
                '--disable-gpu', '--single-process', '--no-zygote', '--renderer-process-limit=1',
                '--js-flags=--max-old-space-size=128',
                '--disable-background-timer-throttling', '--disable-backgrounding-occluded-windows',
                '--disable-renderer-backgrounding', '--disable-features=Translate,BackForwardCache',
                '--metrics-recording-only', '--mute-audio', '--no-first-run',
                '--safebrowsing-disable-auto-update', '--disable-extensions', '--disable-default-apps'
            ],
            protocolTimeout: 240000,
        }
    });

    client.on('qr', async (qrText) => {
        qrGenerated = true; clientStatus = 'disconnected';
        qrDataUrl = await qrcode.toDataURL(qrText, { scale: 6 });
        console.log('📱 QR ready. Scan now: /qr');
        await sendStatusUpdate('disconnected').catch(() => {});
    });

    client.on('ready', async () => {
        qrGenerated = false; qrDataUrl = null; clientStatus = 'connected';
        lastConnectedTime = new Date();
        console.log('✅ WhatsApp bridge is connected.');
        await sendStatusUpdate('connected').catch(() => {});
        try {
            const resp = await fetch(`${APPS_SCRIPT_URL}?token=${BRIDGE_TOKEN}&action=balance&number=${ADMIN_NUMBER}`);
            const data = await resp.json();
            if (data.balance !== undefined) {
                // Use the admin number with @c.us to send the message
                await client.sendMessage(`${ADMIN_NUMBER}@c.us`, `🤖 Bot online. Your balance: ₹${data.balance}`);
                console.log('📤 Admin balance alert sent.');
            }
        } catch(e) { console.error('Balance alert failed:', e); }
    });

    client.on('message', async msg => {
        if (msg.from === 'status@broadcast' || msg.isStatus || !msg.body) return;

        const isGroup = msg.from.endsWith('@g.us');
        let rawId;
        if (isGroup) {
            if (!msg.author) return;
            rawId = msg.author;
        } else {
            rawId = msg.from;
        }

        // ✅ THE KEY FIX: Use the new resolveNumber function
        const fromNumber = await resolveNumber(rawId);
        if (!fromNumber) {
            console.error('❌ Could not extract phone number from ID:', rawId);
            return;
        }

        console.log('📩 Message from', fromNumber, ':', msg.body);

        const payload = {
            token: BRIDGE_TOKEN,
            from: fromNumber,
            message: msg.body,
            isGroup: isGroup
        };

        try {
            const response = await fetch(APPS_SCRIPT_URL, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(payload)
            });
            const data = await response.json();
            console.log('📨 Apps Script reply:', data.reply || '(no reply)');
            if (data.reply) {
                await msg.reply(data.reply);
                console.log('✅ Reply sent.');
            }
        } catch (err) {
            console.error('❌ Error forwarding message:', err);
        }
    });

    client.on('disconnected', async (reason) => {
        console.log('🔌 Disconnected:', reason);
        clientStatus = 'disconnected';
        await sendStatusUpdate('disconnected').catch(() => {});
        setTimeout(() => startClient(), 10000);
    });

    console.log('🚀 Initializing...');
    await client.initialize();
}

async function sendStatusUpdate(status) {
    try {
        const url = `${APPS_SCRIPT_URL}?token=${BRIDGE_TOKEN}&action=updateBotStatus&status=${status}&timestamp=${encodeURIComponent(new Date().toISOString())}`;
        await fetch(url);
    } catch(e) {}
}

app.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
    startClient().catch(err => { console.error('Start failed:', err); setTimeout(() => startClient(), 10000); });
});

// --- Dashboard HTML Generator (Include the full, detailed version you had before) ---
function generateDashboardHTML(data, botStatus) {
    // ... paste the complete generateDashboardHTML from the previous final version ...
    // It should include the Session card, the User Balances table, and the full layout.
}

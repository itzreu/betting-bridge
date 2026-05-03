const { Client, LocalAuth } = require('whatsapp-web.js');
const qrcode = require('qrcode-terminal');
const fetch = require('node-fetch');
const express = require('express');

// Read secrets from environment variables (Render will set them)
const APPS_SCRIPT_URL = process.env.APPS_SCRIPT_URL;
const BRIDGE_TOKEN = process.env.BRIDGE_TOKEN;
const ADMIN_NUMBER = process.env.ADMIN_NUMBER;
const PORT = process.env.PORT || 3000;

// Express server to keep alive
const app = express();
app.get('/health', (req, res) => res.send('OK'));
app.listen(PORT, () => console.log(`Keep-alive server running on port ${PORT}`));

// WhatsApp client
const client = new Client({
    authStrategy: new LocalAuth(),
    puppeteer: { headless: true, args: ['--no-sandbox', '--disable-setuid-sandbox'] }
});

client.on('qr', qr => {
    qrcode.generate(qr, { small: true });
    console.log('📱 Scan the QR code above with WhatsApp (Linked Devices)');
});

client.on('ready', () => {
    console.log('✅ WhatsApp bridge is connected.');
});

client.on('message', async msg => {
    if (msg.from === 'status@broadcast' || msg.isStatus || !msg.body) return;

    const isGroup = msg.from.endsWith('@g.us');
    let fromNumber;

    if (isGroup) {
        if (!msg.author) return;
        fromNumber = msg.author.replace('@c.us', '');
    } else {
        fromNumber = msg.from.replace('@c.us', '');
    }

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
        if (data.reply) {
            msg.reply(data.reply);
        }
    } catch (err) {
        console.error('Error:', err);
    }
});

client.initialize();

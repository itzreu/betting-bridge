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

// We'll store the current bridge status here
let bridgeStatus = 'WAITING';   // WAITING, CONNECTED, ERROR
let qrDataUrl = '';

// Health check that also reports status
app.get('/health', (req, res) => {
  res.json({ status: bridgeStatus });
});

// QR code image page
app.get('/qr', (req, res) => {
  if (bridgeStatus === 'CONNECTED') {
    res.send('<h2>✅ Bridge is connected. No QR needed.</h2>');
    return;
  }
  if (!qrDataUrl) {
    res.send('<h2>QR code not ready yet. Please wait a few seconds and refresh.</h2>');
    return;
  }
  res.send(`
    <html>
    <head><title>WhatsApp QR Code</title>
      <meta http-equiv="refresh" content="10" />
    </head>
    <body style="text-align:center; background:#111; color:white; font-family:sans-serif;">
      <h1>Scan this with WhatsApp</h1>
      <img src="${qrDataUrl}" alt="QR Code" style="border:10px solid white; border-radius:20px;" />
      <p>Open WhatsApp → Settings → Linked Devices → Link a Device</p>
    </body>
    </html>
  `);
});

app.listen(PORT, () => console.log(`Keep-alive server running on port ${PORT}`));
console.log(`🔗 When ready, open your Render URL + /qr to scan.`);

// ---- WhatsApp client ----
async function startClient() {
  const executablePath = await chromium.executablePath();
  console.log('Using Chromium from:', executablePath);

  const client = new Client({
    authStrategy: new LocalAuth(),
    puppeteer: {
      executablePath: executablePath,
      headless: true,
      args: [
        ...chromium.args,
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        '--disable-gpu',
        '--disable-accelerated-2d-canvas',
        '--no-first-run',
        '--no-zygote',
        '--single-process',            // helps low-memory servers
        '--disable-features=site-per-process'
      ]
    }
  });

  // ------ Event handling ------
  client.on('qr', async (qrText) => {
    bridgeStatus = 'WAITING';
    try {
      qrDataUrl = await qrcode.toDataURL(qrText, { scale: 8 });
      console.log('📱 New QR code generated. Scan it now.');
    } catch (err) {
      console.error('QR image error:', err);
    }
  });

  client.on('authenticated', () => {
    console.log('🔐 Authenticated successfully.');
  });

  client.on('ready', () => {
    bridgeStatus = 'CONNECTED';
    qrDataUrl = ''; // clear QR image
    console.log('✅ WhatsApp bridge is connected.');
  });

  client.on('auth_failure', (msg) => {
    bridgeStatus = 'ERROR';
    console.error('❌ Authentication failed:', msg);
  });

  client.on('disconnected', (reason) => {
    bridgeStatus = 'WAITING';
    console.log('⚠️ Disconnected:', reason);
    // Attempt to restart (will generate new QR)
    client.destroy();
    startClient();
  });

  // Message handler (same as before)
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
}

startClient().catch(err => {
  bridgeStatus = 'ERROR';
  console.error('Failed to start client:', err);
});

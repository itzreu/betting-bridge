const { Client, LocalAuth } = require('whatsapp-web.js');
const qrcode = require('qrcode');                 // image QR generator
const fetch = require('node-fetch');
const express = require('express');
const chromium = require('@sparticuz/chromium');

const APPS_SCRIPT_URL = process.env.APPS_SCRIPT_URL;
const BRIDGE_TOKEN = process.env.BRIDGE_TOKEN;
const ADMIN_NUMBER = process.env.ADMIN_NUMBER;
const PORT = process.env.PORT || 3000;

const app = express();

// We'll store the latest QR code data URL here
let qrDataUrl = '';

// Serve a simple health check page
app.get('/health', (req, res) => res.send('OK'));

// Serve an HTML page that shows the QR code image
app.get('/qr', (req, res) => {
  if (!qrDataUrl) {
    res.send('<h2>QR code not ready yet. Please wait a moment and refresh.</h2>');
    return;
  }
  res.send(`
    <html>
    <head><title>WhatsApp QR Code</title>
      <meta http-equiv="refresh" content="10" />  <!-- auto-refresh every 10s -->
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
console.log(`🔗 When the QR code appears, open: http://localhost:3000/qr (or your Render URL) to scan it.`);

// Function to start WhatsApp client
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
        '--disable-setuid-sandbox'
      ]
    }
  });

  client.on('qr', async (qrText) => {
    // Generate a nice image QR code (data URL) from the text
    try {
      qrDataUrl = await qrcode.toDataURL(qrText, { scale: 8 });
      console.log('✅ QR code image generated. Open your /qr page to scan.');
    } catch (err) {
      console.error('Failed to generate QR image:', err);
    }
  });

  client.on('ready', () => {
    console.log('✅ WhatsApp bridge is connected.');
    qrDataUrl = ''; // clear QR now that we're connected
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
}

startClient().catch(err => {
  console.error('Failed to start client:', err);
});

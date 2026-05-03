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

let qrDataUrl = null;
let clientStatus = 'disconnected';
let lastConnectedTime = null;
let qrGenerated = false;
let client = null;

// ========== Minimal routes (keep only what's essential) ==========
app.get('/health', (req, res) => res.send('OK'));

app.get('/qr', (req, res) => {
  if (!qrDataUrl) return res.send('<h2>QR code not ready yet. Refresh in a few seconds.</h2>');
  res.send(`<html><head><title>WhatsApp QR</title><meta http-equiv="refresh" content="15"></head>
    <body style="text-align:center;background:#111;color:white;font-family:sans-serif">
      <h1>Scan with WhatsApp</h1>
      <img src="${qrDataUrl}" style="border:10px solid white;border-radius:20px;">
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

// Dashboard – now just a simple page that calls Apps Script directly (no extra memory for big HTML)
app.get('/dashboard', (req, res) => {
  if (req.query.token !== BRIDGE_TOKEN) return res.status(403).send('Forbidden');
  // Redirect to a static dashboard served from Apps Script? Keep it lightweight.
  res.send(`<html><head><title>Dashboard</title>
    <meta http-equiv="refresh" content="30">
    <style>body{font-family:Arial;margin:20px}.card{background:white;padding:15px;border-radius:8px;margin:10px 0;box-shadow:0 2px 5px rgba(0,0,0,0.1)}</style></head>
    <body>
      <h1>🏇 Dashboard</h1>
      <div class="card">
        <p>Bot status: <span id="status">checking...</span></p>
        <p><button onclick="window.open('/qr','_blank')">Show QR</button>
        <button onclick="logout()">Logout & Restart</button></p>
      </div>
      <div class="card">Full dashboard data is fetched directly from Apps Script.</div>
      <script>
        fetch('/status').then(r=>r.json()).then(s=>{
          document.getElementById('status').innerHTML = s.status==='connected'?'🟢 ONLINE':'🔴 OFFLINE';
        });
        async function logout(){
          if(!confirm('Restart bot?')) return;
          await fetch('/logout?token=${BRIDGE_TOKEN}', {method:'POST'});
          setTimeout(()=>location.reload(),5000);
        }
      </script>
    </body></html>`);
});

// Logout endpoint (same as before)
app.post('/logout', async (req, res) => {
  if (req.query.token !== BRIDGE_TOKEN) return res.status(403).json({error:'Forbidden'});
  try {
    if (client) { await client.destroy(); client = null; }
    setTimeout(() => startClient(), 3000);
    res.json({result:'OK'});
  } catch(e) { res.json({error:e.message}); }
});

// ========== WhatsApp client ==========
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
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        '--disable-gpu',
        '--single-process',
        '--no-zygote',
        '--renderer-process-limit=1',          // only one renderer
        '--js-flags=--max-old-space-size=128', // cap JS heap at 128 MB
        '--disable-background-timer-throttling',
        '--disable-backgrounding-occluded-windows',
        '--disable-renderer-backgrounding',
        '--disable-features=Translate,BackForwardCache',
        '--metrics-recording-only',
        '--mute-audio',
        '--no-first-run',
        '--safebrowsing-disable-auto-update',
        '--disable-extensions',
        '--disable-default-apps'
      ],
      protocolTimeout: 240000,
    }
  });

  client.on('qr', async (qrText) => {
    qrGenerated = true; clientStatus = 'disconnected';
    qrDataUrl = await qrcode.toDataURL(qrText, { scale: 6 });  // smaller QR = less memory
    console.log('📱 QR ready. Scan now: /qr');
    await sendStatusUpdate('disconnected').catch(() => {});
  });

  client.on('ready', async () => {
    qrGenerated = false; qrDataUrl = null; clientStatus = 'connected';
    lastConnectedTime = new Date();
    console.log('✅ WhatsApp bridge is connected.');
    await sendStatusUpdate('connected').catch(() => {});

    // Balance alert (uses a direct Apps Script call, not the dashboard)
    try {
      const resp = await fetch(`${APPS_SCRIPT_URL}?token=${BRIDGE_TOKEN}&action=balance&number=${ADMIN_NUMBER}`);
      const data = await resp.json();
      if (data.balance !== undefined) {
        await client.sendMessage(ADMIN_NUMBER + '@c.us', `🤖 Bot online. Your balance: ₹${data.balance}`);
        console.log('📤 Admin balance alert sent.');
      }
    } catch(e) { console.error('Balance alert failed:', e); }
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
  startClient().catch(err => {
    console.error('Start failed:', err);
    setTimeout(() => startClient(), 10000);
  });
});

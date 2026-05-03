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
let clientStatus = 'disconnected';   // 'connected' or 'disconnected'
let lastConnectedTime = null;
let qrGenerated = false;            // true when QR is waiting to be scanned

// ========== Express routes ==========

app.get('/health', (req, res) => res.send('OK'));

app.get('/qr', (req, res) => {
  if (!qrDataUrl) {
    res.send('<h2>QR code not ready or already scanned. Wait a moment and refresh.</h2>');
    return;
  }
  res.send(`
    <html>
    <head><title>WhatsApp QR Code</title>
      <meta http-equiv="refresh" content="15" />
    </head>
    <body style="text-align:center; background:#111; color:white; font-family:sans-serif;">
      <h1>Scan this with WhatsApp</h1>
      <img src="${qrDataUrl}" alt="QR Code" style="border:10px solid white; border-radius:20px;" />
      <p>Settings → Linked Devices → Link a Device</p>
    </body>
    </html>
  `);
});

// Status for dashboard (JSON)
app.get('/status', (req, res) => {
  res.json({
    status: clientStatus,
    qrReady: qrGenerated,
    lastConnected: lastConnectedTime ? lastConnectedTime.toISOString() : null,
    estimatedExpiry: lastConnectedTime ? new Date(lastConnectedTime.getTime() + 7*24*60*60*1000).toISOString() : null
  });
});

// Dashboard HTML (fetches data from Apps Script + local status)
app.get('/dashboard', async (req, res) => {
  if (req.query.token !== BRIDGE_TOKEN) return res.status(403).send('Forbidden');
  try {
    const dataResp = await fetch(`${APPS_SCRIPT_URL}?token=${BRIDGE_TOKEN}&action=dashboard`);
    const data = await dataResp.json();
    const statusResp = await fetch(`http://localhost:${PORT}/status`);  // self
    const botStatus = await statusResp.json();
    res.send(generateDashboardHTML(data, botStatus));
  } catch (err) {
    res.send('Error loading dashboard: ' + err.message);
  }
});

// Payout trigger
app.post('/triggerPayout', async (req, res) => {
  if (req.query.token !== BRIDGE_TOKEN) return res.status(403).json({error:'Forbidden'});
  const { race, first, second, third } = req.body;
  if (!race || !first || !second || !third) return res.status(400).json({error:'Missing fields'});
  try {
    const resp = await fetch(`${APPS_SCRIPT_URL}?token=${BRIDGE_TOKEN}&action=triggerPayout&race=${race}&first=${first}&second=${second}&third=${third}`);
    const result = await resp.json();
    res.json(result);
  } catch (err) {
    res.json({reply: 'Error: ' + err.message});
  }
});

// ========== Dashboard HTML generator ==========
function generateDashboardHTML(data, botStatus) {
  const { raceName, status, runnerCount, playFee, userBalances, recentBets } = data;
  const balanceRows = userBalances.map(u => `<tr><td>${u.number}</td><td>${u.deposits}</td><td>${u.withdraws}</td><td>${u.totalBets}</td><td><strong>${u.balance}</strong></td></tr>`).join('');
  const betRows = recentBets.map(b => `<tr><td>${b.betId}</td><td>${b.race}</td><td>${b.user}</td><td>${b.horse} ${b.position}</td><td>${b.amount}</td><td>${b.win||'-'}</td><td>${b.lose||'-'}</td></tr>`).join('');
  
  const botOnline = botStatus.status === 'connected';
  const qrAlert = botStatus.qrReady;
  const lastConn = botStatus.lastConnected ? new Date(botStatus.lastConnected).toLocaleString() : 'Never';
  const expires = botStatus.estimatedExpiry ? new Date(botStatus.estimatedExpiry).toLocaleString() : 'Unknown';
  
  return `
<!DOCTYPE html>
<html><head><title>Betting Dashboard</title>
<meta name="viewport" content="width=device-width, initial-scale=1">
<style>
  body { font-family: Arial; background: #f4f4f4; margin: 20px; }
  .card { background: white; padding: 15px; border-radius: 8px; margin-bottom: 20px; box-shadow: 0 2px 5px rgba(0,0,0,0.1); }
  table { width: 100%; border-collapse: collapse; margin-top: 10px; }
  th, td { border: 1px solid #ddd; padding: 8px; text-align: left; }
  th { background: #007bff; color: white; }
  .status-active { color: green; font-weight: bold; }
  .status-closed { color: red; font-weight: bold; }
  .bot-online { color: green; font-weight: bold; }
  .bot-offline { color: red; font-weight: bold; }
  .qr-alert { background: #ffcccc; padding: 10px; border-radius: 5px; }
  button { padding: 10px 20px; background: #28a745; color: white; border: none; border-radius: 5px; cursor: pointer; }
  input, select { padding: 8px; margin: 5px; }
</style></head>
<body>
  <h1>🏇 Race Dashboard</h1>
  
  <div class="card">
    <h3>🤖 Bot Status</h3>
    <p>Status: <span class="${botOnline ? 'bot-online' : 'bot-offline'}">${botOnline ? '🟢 ONLINE' : '🔴 OFFLINE'}</span></p>
    <p>Last Connected: ${lastConn}</p>
    <p>Session Expires (est.): ${expires}</p>
    ${qrAlert ? '<div class="qr-alert"><strong>⚠️ QR code waiting to be scanned!</strong> <a href="/qr">Open QR page</a></div>' : ''}
  </div>
  
  <div class="card">
    <p><strong>Race:</strong> ${raceName} 
       <span class="${status==='ACTIVE'?'status-active':'status-closed'}">(${status})</span>
    </p>
    <p>Runners: ${runnerCount} | Play Fee: ${playFee}%</p>
  </div>
  
  <!-- Balances & bets tables same as before -->
  <div class="card">
    <h3>💼 User Balances</h3>
    <table>${balanceRows}</table>
  </div>
  <div class="card">
    <h3>📋 Recent Bets</h3>
    <table>${betRows}</table>
  </div>
  <div class="card">
    <h3>🏆 Payout Control</h3>
    <p>Set status to CLOSED on sheet first!</p>
    <label>Race: <input type="text" id="prace" value="${raceName}"></label>
    <label>1st: <input type="number" id="pfirst"></label>
    <label>2nd: <input type="number" id="psecond"></label>
    <label>3rd: <input type="number" id="pthird"></label>
    <button onclick="triggerPayout()">Run Payout</button>
    <p id="payoutResult"></p>
  </div>
  <script>
    const token = '${BRIDGE_TOKEN}';
    async function triggerPayout() {
      const race = document.getElementById('prace').value;
      const first = document.getElementById('pfirst').value;
      const second = document.getElementById('psecond').value;
      const third = document.getElementById('pthird').value;
      const res = await fetch('/triggerPayout?token=' + token, {
        method: 'POST',
        headers: {'Content-Type': 'application/json'},
        body: JSON.stringify({race,first,second,third})
      });
      const data = await res.json();
      document.getElementById('payoutResult').innerText = data.reply || 'Done';
    }
  </script>
</body></html>`;
}

// ========== WhatsApp Client ==========
async function startClient() {
  const executablePath = await chromium.executablePath();
  console.log('Using Chromium from:', executablePath);

  const client = new Client({
    authStrategy: new LocalAuth(),
    puppeteer: {
      executablePath: executablePath,
      headless: true,
      args: [...chromium.args, '--no-sandbox', '--disable-setuid-sandbox']
    }
  });

  client.on('qr', async (qrText) => {
    qrGenerated = true;
    clientStatus = 'disconnected';
    try {
      qrDataUrl = await qrcode.toDataURL(qrText, { scale: 8 });
      console.log('📱 QR ready. Open /qr to scan.');
    } catch (err) {
      console.error('QR image error:', err);
    }
    // Notify Apps Script that we are disconnected (so dashboard updates)
    sendStatusUpdate('disconnected');
  });

  client.on('ready', () => {
    qrGenerated = false;
    qrDataUrl = null;
    clientStatus = 'connected';
    lastConnectedTime = new Date();
    console.log('✅ WhatsApp bridge is connected.');
    sendStatusUpdate('connected');
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
      if (data.reply) {
        console.log('✅ Replying:', data.reply);
        await msg.reply(data.reply);
      }
    } catch (err) {
      console.error('❌ Error forwarding message:', err);
    }
  });

  client.initialize();
}

// ========== Status updater (calls Apps Script) ==========
async function sendStatusUpdate(status) {
  try {
    await fetch(`${APPS_SCRIPT_URL}?token=${BRIDGE_TOKEN}&action=updateBotStatus&status=${status}&timestamp=${new Date().toISOString()}`);
  } catch (err) {
    console.error('Could not send status update to Apps Script:', err);
  }
}

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
  startClient().catch(err => console.error('Failed to start client:', err));
});

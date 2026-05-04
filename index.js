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

// ========== Robust LID to Phone Number Converter ==========
async function resolveNumber(waId) {
  try {
    const contact = await client.getContactById(waId);
    return contact.number;
  } catch (err) {
    console.error('Could not resolve contact for ID:', waId, err);
    const digits = waId.replace(/\D/g, '');
    return digits || null;
  }
}

// ========== Routes ==========
app.get('/health', (req, res) => res.send('OK'));

app.get('/qr', (req, res) => {
  if (clientStatus === 'connected') {
    res.send(`<html><head><title>Already connected</title><meta http-equiv="refresh" content="3;url=/dashboard?token=${BRIDGE_TOKEN}"></head>
    <body style="font-family:sans-serif;text-align:center;padding:50px;"><h1>✅ Already connected!</h1></body></html>`);
    return;
  }
  if (!qrDataUrl) {
    res.send('<h2>QR code not ready. Refresh in a few seconds.</h2>');
    return;
  }
  res.send(`<html><head><title>WhatsApp QR</title><meta http-equiv="refresh" content="15">
    <script>setInterval(async()=>{const r=await fetch('/status');const s=await r.json();if(s.status==='connected')window.location.href='/qr-connected';},5000);</script>
    </head><body style="text-align:center;background:#111;color:white;font-family:sans-serif;">
      <h1>Scan with WhatsApp</h1><img src="${qrDataUrl}" style="border:10px solid white;border-radius:20px;">
      <p>Settings → Linked Devices → Link a Device</p></body></html>`);
});

app.get('/qr-connected', (req,res)=>{
  res.send(`<html><head><title>Connected ✅</title><script>setTimeout(()=>window.close(),3000);</script></head>
    <body style="font-family:sans-serif;text-align:center;padding:50px;"><h1>✅ Connected!</h1></body></html>`);
});

app.get('/status', (req, res) => {
  res.json({status: clientStatus, qrReady: qrGenerated, lastConnected: lastConnectedTime ? lastConnectedTime.toISOString() : null,
    estimatedExpiry: lastConnectedTime ? new Date(lastConnectedTime.getTime() + 7*24*60*60*1000).toISOString() : null});
});

// Dashboard (full HTML)
app.get('/dashboard', async (req, res) => {
  if (req.query.token !== BRIDGE_TOKEN) return res.status(403).send('Forbidden');
  try {
    const dataResp = await fetch(`${APPS_SCRIPT_URL}?token=${BRIDGE_TOKEN}&action=dashboard`);
    const data = await dataResp.json();
    const statusResp = await fetch(`http://localhost:${PORT}/status`);
    const botStatus = await statusResp.json();
    res.send(generateDashboardHTML(data, botStatus));
  } catch (err) { res.send('Error loading dashboard: ' + err.message); }
});

// Payout + Logout endpoints (unchanged)
app.post('/triggerPayout', async (req,res)=>{ /* same as before */ });
app.post('/logout', async (req,res)=>{ /* same as before */ });

// WhatsApp Client
async function startClient() {
  const execPath = await chromium.executablePath();
  console.log('Chromium executable:', execPath);

  client = new Client({
    authStrategy: new LocalAuth(),
    puppeteer: {
      executablePath: execPath, headless: 'new',
      args: [...chromium.args, '--no-sandbox','--disable-setuid-sandbox','--disable-dev-shm-usage',
        '--disable-gpu','--single-process','--no-zygote','--renderer-process-limit=1',
        '--js-flags=--max-old-space-size=128','--disable-background-timer-throttling',
        '--disable-backgrounding-occluded-windows','--disable-renderer-backgrounding',
        '--disable-features=Translate,BackForwardCache','--metrics-recording-only','--mute-audio',
        '--no-first-run','--safebrowsing-disable-auto-update','--disable-extensions','--disable-default-apps'],
      protocolTimeout: 240000,
    }
  });

  client.on('qr', async (qrText) => {
    qrGenerated = true; clientStatus = 'disconnected';
    qrDataUrl = await qrcode.toDataURL(qrText, { scale: 6 });
    console.log('📱 QR ready. Scan now: /qr');
    await sendStatusUpdate('disconnected').catch(()=>{});
  });

  client.on('ready', async () => {
    qrGenerated = false; qrDataUrl = null; clientStatus = 'connected';
    lastConnectedTime = new Date();
    console.log('✅ WhatsApp bridge is connected.');
    await sendStatusUpdate('connected').catch(()=>{});
    try {
      const resp = await fetch(`${APPS_SCRIPT_URL}?token=${BRIDGE_TOKEN}&action=balance&number=${ADMIN_NUMBER}`);
      const data = await resp.json();
      if (data.balance !== undefined) {
        await client.sendMessage(`${ADMIN_NUMBER}@c.us`, `🤖 Bot online. Your balance: ₹${data.balance}`);
        console.log('📤 Admin balance alert sent.');
      }
    } catch(e) { console.error('Balance alert failed:', e); }
  });

client.on('message', async msg => {
    // Ignore system messages and empty body
    if (msg.from === 'status@broadcast' || msg.isStatus || !msg.body) return;

    // ------ 1. Get the REAL phone number (works with @c.us AND @lid) ------
    let fromNumber = null;
    try {
        const contact = await msg.getContact();   // ← built-in, always returns a valid contact
        fromNumber = contact.number;              // e.g. "918451943503"
    } catch (e) {
        console.error('⚠️ Could not get contact from message. Skipping message.');
        return;   // Don't process messages we can't identify
    }

    // ------ 2. Now we know who sent it – log and forward ------
    const isGroup = msg.from.endsWith('@g.us');
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
    await sendStatusUpdate('disconnected').catch(()=>{});
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

app.listen(PORT, () => { console.log(`Server running on port ${PORT}`); startClient().catch(err => { console.error('Start failed:', err); setTimeout(() => startClient(), 10000); }); });

// ========== Dashboard HTML generator ==========
function generateDashboardHTML(data, botStatus) {
  // ... same as before, but we'll add a Session card
  const { raceName, status, runnerCount, playFee, userBalances, recentBets } = data;
  const balanceRows = userBalances.map(u => `<tr><td>${u.number}</td><td>${u.deposits}</td><td>${u.withdraws}</td><td>${u.totalBets}</td><td><strong>${u.balance}</strong></td></tr>`).join('');
  const betRows = recentBets.map(b => `<tr><td>${b.betId}</td><td>${b.race}</td><td>${b.user}</td><td>${b.horse} ${b.position}</td><td>${b.amount}</td><td>${b.win||'-'}</td><td>${b.lose||'-'}</td></tr>`).join('');
  const botOnline = botStatus.status === 'connected';
  const qrAlert = botStatus.qrReady;
  const lastConn = botStatus.lastConnected ? new Date(botStatus.lastConnected).toLocaleString() : 'Never';
  const expires = botStatus.estimatedExpiry ? new Date(botStatus.estimatedExpiry).toLocaleString() : 'Unknown';
  return `<!DOCTYPE html>
<html><head><title>Betting Dashboard</title>
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta http-equiv="refresh" content="30">
<style>
  body { font-family: Arial; background: #f4f4f4; margin: 20px; }
  .card { background: white; padding: 15px; border-radius: 8px; margin-bottom: 20px; box-shadow: 0 2px 5px rgba(0,0,0,0.1); }
  table { width: 100%; border-collapse: collapse; margin-top: 10px; }
  th, td { border: 1px solid #ddd; padding: 8px; text-align: left; }
  th { background: #007bff; color: white; }
  .bot-online { color: green; font-weight: bold; }
  .bot-offline { color: red; font-weight: bold; }
  .qr-alert { background: #ffcccc; padding: 10px; border-radius: 5px; }
  button { padding: 10px 20px; background: #28a745; color: white; border: none; border-radius: 5px; cursor: pointer; margin: 5px; }
  .logout-btn { background: #dc3545; }
  input, select { padding: 8px; margin: 5px; }
</style></head>
<body>
  <h1>🏇 Race Dashboard</h1>
  <div class="card">
    <h3>📱 Session</h3>
    <p>Status: <span class="${botOnline ? 'bot-online' : 'bot-offline'}">${botOnline ? '🟢 ONLINE' : '🔴 OFFLINE'}</span></p>
    <p>Last Connected: ${lastConn}</p>
    <p>Expires (est.): ${expires}</p>
    ${qrAlert ? '<div class="qr-alert"><strong>⚠️ QR ready!</strong> <a href="/qr" target="_blank">Open QR page</a></div>' : ''}
    <div>
      <button onclick="window.open('/qr','_blank')">📷 Show QR</button>
      <button class="logout-btn" onclick="logoutBot()">🚪 Logout & Reconnect</button>
      ${botOnline ? '<button onclick="window.open(\'/qr-connected\',\'_blank\')">✅ Show Connection</button>' : ''}
    </div>
  </div>
  <div class="card">
    <p><strong>Race:</strong> ${raceName} <span class="${status==='ACTIVE'?'status-active':'status-closed'}">(${status})</span></p>
    <p>Runners: ${runnerCount} | Play Fee: ${playFee}%</p>
  </div>
  <div class="card"><h3>💼 User Balances</h3><table><tr><th>Number</th><th>Deposits</th><th>Withdrawals</th><th>Total Bets</th><th>Balance</th></tr>${balanceRows}</table></div>
  <div class="card"><h3>📋 Recent Bets</h3><table><tr><th>ID</th><th>Race</th><th>User</th><th>Horse</th><th>Amount</th><th>Win</th><th>Lose</th></tr>${betRows}</table></div>
  <div class="card">
    <h3>🏆 Payout Control</h3>
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
    async function logoutBot() {
      if(!confirm('Logout and restart bot?')) return;
      await fetch('/logout?token=' + token, {method:'POST'});
      setTimeout(() => location.reload(), 5000);
    }
  </script>
</body></html>`;
}

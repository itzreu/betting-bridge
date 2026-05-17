const { Client, LocalAuth } = require('whatsapp-web.js');
const qrcode = require('qrcode');
const fetch = require('node-fetch');
const express = require('express');
const chromium = require('@sparticuz/chromium');

const APPS_SCRIPT_URL = process.env.APPS_SCRIPT_URL;
const BRIDGE_TOKEN   = process.env.BRIDGE_TOKEN;
const ADMIN_NUMBER   = String(process.env.ADMIN_NUMBER || '').trim();
const PORT           = process.env.PORT || 3000;

const app = express();
app.use(express.json());

let qrDataUrl         = null;
let clientStatus      = 'disconnected';
let lastConnectedTime = null;
let qrGenerated       = false;
let client            = null;
let knownNumbers      = new Set();
let isStarting        = false;        // 🛡️ Only one start at a time
let lastDisconnectTime = 0;           // 🛡️ Minimum cooldown between restarts

async function destroyClient() {
  if (client) { try { await client.destroy(); } catch(e) {} client = null; }
}

// ========== Routes ==========
app.get('/health', (_, res) => res.send('OK'));

app.get('/start', async (req, res) => {
  if (req.query.token !== BRIDGE_TOKEN) return res.status(403).send('Forbidden');
  if (clientStatus === 'connected') return res.send('<h2>✅ Bot already connected.</h2>');
  if (isStarting) return res.send('<h2>⏳ Bot is already starting. Please wait…</h2>');

  const now = Date.now();
  const cooldown = 120000; // 2 minutes
  if (now - lastDisconnectTime < cooldown) {
    const wait = Math.ceil((cooldown - (now - lastDisconnectTime)) / 1000);
    return res.send(`<h2>⏳ Please wait ${wait} seconds before starting again.</h2>`);
  }

  isStarting = true;
  lastDisconnectTime = now;    // record the time we started

  try {
    await startClient();
    res.send('<h2>🔄 Bot starting… Open <a href="/qr">QR page</a> to scan.</h2>');
  } catch(e) {
    isStarting = false;
    res.send('<h2>❌ Failed to start bot. Try again later.</h2>');
  }
});

app.get('/qr', (req, res) => {
  if (clientStatus === 'connected') {
    res.send('<html><head><meta http-equiv="refresh" content="3;url=/dashboard?token='+BRIDGE_TOKEN+'"></head><body><h1>✅ Connected!</h1></body></html>');
    return;
  }
  if (!qrDataUrl) return res.send('<h2>QR not ready. Use /start first.</h2>');
  res.send(`<html><head><title>WhatsApp QR</title><meta http-equiv="refresh" content="15">
    <script>setInterval(async()=>{const r=await fetch('/status');const s=await r.json();if(s.status==='connected')window.location.href='/qr-connected';},5000);</script>
    </head><body style="text-align:center;background:#111;color:white;font-family:sans-serif;">
      <h1>Scan with WhatsApp</h1><img src="${qrDataUrl}" style="border:10px solid white;border-radius:20px;">
      <p>Linked Devices → Link a Device</p></body></html>`);
});

app.get('/qr-connected', (_, res) => res.send('<html><head><title>Connected ✅</title><script>setTimeout(()=>window.close(),3000);</script></head><body><h1>✅ Connected!</h1></body></html>'));

app.get('/status', (_, res) => {
  res.json({
    status: clientStatus, qrReady: qrGenerated,
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
  } catch(e) { res.send('Error loading dashboard: ' + e.message); }
});

app.post('/triggerPayout', async (req, res) => {
  if (req.query.token !== BRIDGE_TOKEN) return res.status(403).json({error:'Forbidden'});
  const { race, first, second, third } = req.body;
  if (!race || !first || !second || !third) return res.status(400).json({error:'Missing fields'});
  try {
    const resp = await fetch(`${APPS_SCRIPT_URL}?token=${BRIDGE_TOKEN}&action=triggerPayout&race=${race}&first=${first}&second=${second}&third=${third}`);
    const data = await resp.json();
    res.json(data);
  } catch(e) { res.json({reply:'Error: '+e.message}); }
});

app.post('/logout', async (req, res) => {
  if (req.query.token !== BRIDGE_TOKEN) return res.status(403).json({error:'Forbidden'});
  try {
    if (client) { await client.destroy(); client = null; }
    isStarting = false;  // allow new starts after logout
    setTimeout(() => startClient().catch(console.error), 3000);
    res.json({result:'Logged out, restarting...'});
  } catch(e) { res.json({error:e.message}); }
});

// ========== Dashboard HTML (WITH Add User + Register User) ==========
function generateDashboardHTML(data, botStatus) {
  const { raceName, status, runnerCount, playFee, userBalances, recentBets, raceHistory } = data;
  const balanceRows = userBalances.map(u => `<tr><td>${u.number}</td><td>${u.deposits}</td><td>${u.withdraws}</td><td>${u.totalBets}</td><td><strong>${u.balance}</strong></td></tr>`).join('');
  const betRows = recentBets.map(b => `<tr><td>${b.betId}</td><td>${b.race}</td><td>${b.user}</td><td>${b.horse} ${b.position}</td><td>${b.amount}</td><td>${b.win||'-'}</td><td>${b.lose||'-'}</td><td>${b.isWin===true?'✅':b.isWin===false?'❌':''}</td></tr>`).join('');
  const raceRows = raceHistory.map(r => `<tr><td>${r.raceName}</td><td>${new Date(r.date).toLocaleDateString()}</td><td>${r.runners}</td><td>₹${r.totalBets}</td><td>₹${r.totalPayout}</td><td>${r.status}</td></tr>`).join('');
  const botOnline = botStatus.status === 'connected';
  const qrAlert = botStatus.qrReady;
  const lastConn = botStatus.lastConnected ? new Date(botStatus.lastConnected).toLocaleString() : 'Never';
  const expires = botStatus.estimatedExpiry ? new Date(botStatus.estimatedExpiry).toLocaleString() : 'Unknown';
  return `<!DOCTYPE html><html><head><title>Betting Dashboard</title>
<meta name="viewport" content="width=device-width, initial-scale=1"><meta http-equiv="refresh" content="30">
<style>body{font-family:Arial;background:#f4f4f4;margin:20px}.card{background:white;padding:15px;border-radius:8px;margin-bottom:20px;box-shadow:0 2px 5px rgba(0,0,0,0.1)}table{width:100%;border-collapse:collapse;margin-top:10px}th,td{border:1px solid #ddd;padding:8px}th{background:#007bff;color:white}.bot-online{color:green;font-weight:bold}.bot-offline{color:red;font-weight:bold}.qr-alert{background:#ffcccc;padding:10px;border-radius:5px}button{padding:10px 20px;background:#28a745;color:white;border:none;border-radius:5px;cursor:pointer;margin:5px}.logout-btn{background:#dc3545}.add-btn{background:#007bff}input{padding:8px;margin:5px}</style></head>
<body><h1>🏇 Race Dashboard</h1>
<div class="card"><h3>📱 Session</h3><p>Status: <span class="${botOnline?'bot-online':'bot-offline'}">${botOnline?'🟢 ONLINE':'🔴 OFFLINE'}</span></p><p>Last Connected: ${lastConn}</p><p>Expires: ${expires}</p>${qrAlert?'<div class="qr-alert"><strong>⚠️ QR ready!</strong> <a href="/qr" target="_blank">Open QR page</a></div>':''}<div><button onclick="window.open('/start?token=${BRIDGE_TOKEN}','_blank')">🔄 Start Bot</button><button onclick="window.open('/qr','_blank')">📷 Show QR</button><button class="logout-btn" onclick="logoutBot()">🚪 Logout & Reconnect</button></div></div>
<div class="card"><h3>📝 Add / Register User</h3>
<p style="font-size:12px;color:#666;">Use <b>Add User</b> to track messages only (no bot replies). Use <b>Register User</b> to activate full services (balance, replies).</p>
<input type="text" id="newNumber" placeholder="WhatsApp Number"><input type="text" id="newName" placeholder="Name"><input type="text" id="newLid" placeholder="LID (optional)">
<div><button class="add-btn" onclick="addUser()">➕ Add User (Track Only)</button><button onclick="registerUser()">✅ Register & Activate</button></div>
<p id="regResult"></p></div>
<div class="card"><p><strong>Race:</strong> ${raceName} <span class="${status==='ACTIVE'?'status-active':'status-closed'}">(${status})</span></p><p>Runners: ${runnerCount} | Play Fee: ${playFee}%</p></div>
<div class="card"><h3>💼 User Balances</h3><table><tr><th>Number</th><th>Deposits</th><th>Withdrawals</th><th>Total Bets</th><th>Balance</th></tr>${balanceRows}</table></div>
<div class="card"><h3>📋 Recent Bets</h3><table><tr><th>ID</th><th>Race</th><th>User</th><th>Horse</th><th>Amount</th><th>Win</th><th>Lose</th><th>Win?</th></tr>${betRows}</table></div>
<div class="card"><h3>📜 Race History</h3><table><tr><th>Race</th><th>Date</th><th>Runners</th><th>Total Bets</th><th>Total Payout</th><th>Status</th></tr>${raceRows}</table></div>
<div class="card"><h3>🏆 Payout Control</h3><label>Race: <input type="text" id="prace" value="${raceName}"></label><label>1st: <input type="number" id="pfirst"></label><label>2nd: <input type="number" id="psecond"></label><label>3rd: <input type="number" id="pthird"></label><button onclick="triggerPayout()">Run Payout</button><p id="payoutResult"></p></div>
<script>const token='${BRIDGE_TOKEN}';const appsUrl='${APPS_SCRIPT_URL}';
async function triggerPayout(){const race=document.getElementById('prace').value;const first=document.getElementById('pfirst').value;const second=document.getElementById('psecond').value;const third=document.getElementById('pthird').value;const res=await fetch('/triggerPayout?token='+token,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({race,first,second,third})});const data=await res.json();document.getElementById('payoutResult').innerText=data.reply||'Done'}
async function logoutBot(){if(!confirm('Logout and restart bot?'))return;await fetch('/logout?token='+token,{method:'POST'});setTimeout(()=>location.reload(),5000)}
async function registerUser(){const number=document.getElementById('newNumber').value;const name=document.getElementById('newName').value;const lid=document.getElementById('newLid').value;const res=await fetch(appsUrl+'?token='+token+'&action=registerUserWeb&number='+number+'&name='+encodeURIComponent(name)+'&lid='+lid);const data=await res.json();document.getElementById('regResult').innerText=data.reply||'Error'}
async function addUser(){const number=document.getElementById('newNumber').value;const name=document.getElementById('newName').value;const lid=document.getElementById('newLid').value;const res=await fetch(appsUrl+'?token='+token+'&action=addUserWeb&number='+number+'&name='+encodeURIComponent(name)+'&lid='+lid);const data=await res.json();document.getElementById('regResult').innerText=data.reply||'Error'}
</script></body></html>`;
}

// ========== Memory Watchdog ==========
setInterval(() => {
  const mem = process.memoryUsage();
  const rssMB = Math.round(mem.rss / 1024 / 1024);
  console.log('📊 Memory:', rssMB, 'MB');
  if (rssMB > 250 && clientStatus === 'connected') {
    console.warn('⚠️ Memory high. Restarting client...');
    destroyClient().then(() => setTimeout(() => startClient().catch(console.error), 5000));
  }
}, 30000);

// ========== WhatsApp Client (ban‑safe) ==========
async function startClient() {
  const execPath = await chromium.executablePath();
  console.log('Chromium executable:', execPath);

  try {
    const resp = await fetch(`${APPS_SCRIPT_URL}?token=${BRIDGE_TOKEN}&action=registeredNumbers`);
    const data = await resp.json();
    if (data.numbers) {
      knownNumbers = new Set(data.numbers);
      knownNumbers.add(ADMIN_NUMBER);
      console.log('📋 Registered numbers loaded:', [...knownNumbers].join(', '));
    }
  } catch(e) {}

  client = new Client({
    authStrategy: new LocalAuth({ clientId: 'betting-bot' }),
    puppeteer: {
      executablePath: execPath, headless: 'new',
      args: [
        ...chromium.args,
        '--no-sandbox','--disable-setuid-sandbox','--disable-dev-shm-usage',
        '--disable-gpu','--single-process','--no-zygote',
        '--renderer-process-limit=1','--js-flags=--max-old-space-size=128',
        '--memory-pressure-off','--disable-accelerated-2d-canvas',
        '--disable-features=site-per-process,Translate,BackForwardCache',
        '--disable-background-timer-throttling',
        '--disable-backgrounding-occluded-windows',
        '--disable-renderer-backgrounding',
        '--metrics-recording-only','--mute-audio','--no-first-run',
        '--safebrowsing-disable-auto-update','--disable-extensions',
        '--disable-default-apps','--disable-sync','--disable-breakpad',
        '--disable-hang-monitor'
      ],
      protocolTimeout: 240000
    }
  });

  client.on('qr', async (qrText) => {
    qrGenerated = true; clientStatus = 'disconnected';
    qrDataUrl = await qrcode.toDataURL(qrText, { scale: 6 });
    console.log('📱 QR ready. Scan now: /qr');
    await sendStatusUpdate('disconnected').catch(()=>{});
  });

  client.on('ready', () => {
    qrGenerated = false; qrDataUrl = null; clientStatus = 'connected';
    lastConnectedTime = new Date();
    isStarting = false;   // ✅ start sequence complete
    console.log('✅ WhatsApp bridge is connected.');
    sendStatusUpdate('connected').catch(()=>{});
  });

client.on('message', async msg => {
    if (msg.from === 'status@broadcast' || msg.isStatus || !msg.body) return;
    const isGroup = msg.from.endsWith('@g.us');
    const rawId = isGroup ? (msg.author || msg.from) : msg.from;
    const groupId = isGroup ? msg.from : '';
    const isRaceMsg = /^\d{1,2}\s*(WIN|PLACE|W|P)\s*\d+$|^(BAL|REG|DEP|WITHDRAW|RESULT|BALSHEET|LINKLID|HIS|HISTORY|ACTIVATE|DEACTIVATE)/i.test(msg.body);

    fetch(`${APPS_SCRIPT_URL}?token=${BRIDGE_TOKEN}&action=logMessage&from=${rawId}&message=${encodeURIComponent(msg.body)}&isGroup=${isGroup}&groupId=${groupId}&isRaceMsg=${isRaceMsg}`).catch(()=>{});

    const lid = rawId.replace('@c.us','').replace('@lid','').replace('@g.us','');
    let fromNumber = null;
    try {
      const resp = await fetch(`${APPS_SCRIPT_URL}?token=${BRIDGE_TOKEN}&action=resolveLid&lid=${lid}`);
      const data = await resp.json();
      if (data.number) {
        fromNumber = String(data.number);   // ✅ FORCE STRING
        knownNumbers.add(fromNumber);
      } else {
        console.error('LID resolution failed for', lid);
        return;
      }
    } catch(e) { console.error(e); return; }

    const isAdmin = (fromNumber === ADMIN_NUMBER);
    console.log('📩 Message from', fromNumber, ':', msg.body);

    const payload = { token: BRIDGE_TOKEN, from: fromNumber, message: msg.body, isGroup };
    try {
      const response = await fetch(APPS_SCRIPT_URL, { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify(payload) });
      const data = await response.json();
      console.log('📨 Reply:', data.reply || '(silent)');
      // Reply if silent is false (admin always gets replies; activated users do too)
      if (data.reply && data.silent === false) {
        await msg.reply(data.reply);
        console.log('✅ Reply sent.');
      } else {
        console.log('🤫 Silent – not replying.');
      }
    } catch(e) { console.error('❌ Error:', e); }
  });

  // 🛡️ The ban‑prevention heart – respectful disconnect handling
  client.on('disconnected', async (reason) => {
    console.log('🔌 Disconnected:', reason);
    clientStatus = 'disconnected';
    isStarting = false;
    await sendStatusUpdate('disconnected').catch(()=>{});

    // Determine cooldown: longer if the context was destroyed (navigation)
    const waitTime = (reason && reason.toString().includes('navigation')) ? 300000 : 120000;  // 5 min or 2 min
    console.log(`⏳ Will not reconnect for ${waitTime/1000}s to avoid looking like a bot.`);
    setTimeout(() => {
      if (!isStarting && clientStatus !== 'connected') {
        console.log('🔄 Restarting bot after cooldown…');
        startClient().catch(e => console.error('Restart failed:', e));
      }
    }, waitTime);
  });

  console.log('🚀 Initializing WhatsApp client...');
  await client.initialize();
}

async function sendStatusUpdate(status) {
  try {
    await fetch(`${APPS_SCRIPT_URL}?token=${BRIDGE_TOKEN}&action=updateBotStatus&status=${status}&timestamp=${encodeURIComponent(new Date().toISOString())}`);
  } catch(e) {}
}

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
  console.log('👉 Bot not started. Use /start?token=...');
});

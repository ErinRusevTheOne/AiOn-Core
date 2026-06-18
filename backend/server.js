require('dotenv').config();

const express = require('express');
const cors    = require('cors');
const fs      = require('fs');
const path    = require('path');
const { GoogleGenerativeAI } = require('@google/generative-ai');

const app   = express();
const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
const model = genAI.getGenerativeModel({ model: 'gemini-2.5-flash-lite' });

app.use(cors());
app.use(express.json());

// ── Load product DB at startup ────────────────────────────────
const DB_PATH = path.join(__dirname, './merged_db.json');
const db      = JSON.parse(fs.readFileSync(DB_PATH, 'utf8'));
console.log('DB loaded:', db.meta.total, 'products');

// ── Product filter — find relevant TVs for the conversation ───
function findRelevantProducts(message, history) {
  const text = (message + ' ' + history.map(function(h) { return h.parts[0].text; }).join(' ')).toLowerCase();

  var results = db.products.filter(function(p) {
    if (!p.price_bgn || !p.size_inch) return false;

    // Size filter
    if (/\b43\b/.test(text) && p.size_inch !== 43) return false;
    if (/\b50\b/.test(text) && p.size_inch !== 50) return false;
    if (/\b55\b/.test(text) && p.size_inch !== 55) return false;
    if (/\b65\b/.test(text) && p.size_inch !== 65) return false;
    if (/\b75\b/.test(text) && p.size_inch !== 75) return false;

    // Technology filter
    if (/oled/.test(text) && !/neo qled|miniled/.test(text) && p.technology !== 'OLED' && p.technology !== 'QD-OLED') return false;
    if (/qled/.test(text) && !/oled/.test(text) && p.technology !== 'QLED' && p.technology !== 'MiniLED') return false;

    // Budget filter
    if (/евтин|бюджет|евтино|нисък|под 800|до 800/.test(text) && p.price_bgn > 900) return false;
    if (/скъп|премиум|висок|над 2000|над 3000/.test(text) && p.price_bgn < 1500) return false;

    // Gaming filter
    if (/gam|игр|ps5|xbox|конзол/.test(text) && p.refresh_rate && p.refresh_rate < 100) return false;

    return true;
  });

  // Sort by price
  results.sort(function(a, b) { return (a.price_bgn || 0) - (b.price_bgn || 0); });

  // Return max 8 products
  return results.slice(0, 8);
}

// ── Format products for system prompt ─────────────────────────
function formatProducts(products) {
  return products.map(function(p) {
    return [
      p.model,
      p.size_inch ? p.size_inch + '"' : '',
      p.technology || '',
      p.price_bgn ? p.price_bgn + ' лв' : '',
      p.consultation && p.consultation.pitch ? '→ ' + p.consultation.pitch : ''
    ].filter(Boolean).join(' | ');
  }).join('\n');
}

// ── System prompts ─────────────────────────────────────────────
var SYSTEM_BASE = [
  'Ти си AiOn — дигитален консултант с 25 години реален retail опит.',
  '',
  'ПСИХОЛОГИЯ НА КОНСУЛТАЦИЯТА:',
  '- Хората не купуват телевизор, купуват спокойствие',
  '- Бюджетът е емоционална граница — не я нарушавай директно',
  '- Клиентът често крие реалния проблем (страх от грешна покупка)',
  '- Страхът от грешна покупка е по-силен от желанието за покупка',
  '- Добрият консултант пази достойнството на клиента',
  '- Никога не казвай "евтин" или "скъп" — кажи "в този диапазон" или "за тази инвестиция"',
  '',
  'КВАЛИФИКАЦИОННИ ВЪПРОСИ (задавай естествено, не като анкета):',
  '1. Размер на стаята (квадратура или разстояние до телевизора)',
  '2. Осветление (светла или тъмна стая)',
  '3. Какво гледат предимно (кино, спорт, игри, всичко)',
  '4. Конзоли (PS5/Xbox — ако да, важен е 120Hz и HDMI 2.1)',
  '5. Бюджет (задавай последен, след като клиентът е вложен)',
  '',
  'ТЕХНОЛОГИИ:',
  '- LED: добра цена, достатъчно за светла стая, 60Hz ограничение при ниски модели',
  '- QLED: по-богати цветове, по-висока яркост, добро за светла стая',
  '- MiniLED: значително по-добър контраст от QLED, близо до OLED яркост',
  '- OLED: перфектен черен цвят, безкраен контраст, идеален за тъмна стая и gaming',
  '',
  'СТИЛ НА КОМУНИКАЦИЯ:',
  '- Кратък, ясен, уважителен',
  '- Не изреждай спецификации — превеждай ги в ползи',
  '- Максимум 3-4 изречения на отговор',
  '- Задавай само 1 въпрос наведнъж',
  '',
].join('\n');

var SYSTEM_TRAINING = SYSTEM_BASE + [
  'РЕЖИМ: TRAINING (обучение на консултанти)',
  'Ти играеш ролята на клиент. Служителят е потребителят.',
  'Играй реален клиент — с колебания, въпроси, понякога несигурност.',
  'В края на всеки отговор добави JSON блок за оценка:',
  '<<SCORES>>{"e":75,"q":60,"t":70,"w":65,"f":"Добра квалификация, но не попита за разстоянието"}<<END>>',
  'e=емпатия, q=квалификация, t=доверие, w=win-win (всички 0-100)',
  ''
].join('\n');

var SYSTEM_SERVICE = SYSTEM_BASE + [
  'РЕЖИМ: SERVICE (обслужване на реален клиент)',
  'Ти си AiOn — консултираш реален клиент.',
  'Помогни му да намери правилния телевизор.',
  ''
].join('\n');

// ── Chat endpoint ─────────────────────────────────────────────
app.post('/chat', async function(req, res) {
  try {
    var message = (req.body.message || '').trim();
    var mode    = req.body.mode || 'service';
    var history = Array.isArray(req.body.history) ? req.body.history : [];

    if (!message) {
      return res.status(400).json({ reply: 'Няма съобщение.' });
    }

    // Find relevant products based on conversation so far
    var relevant  = findRelevantProducts(message, history);
    var productBlock = relevant.length > 0
      ? '\nНАЛИЧНИ ПРОДУКТИ (techmart.bg):\n' + formatProducts(relevant) + '\n'
      : '';

    var systemPrompt = (mode === 'training' ? SYSTEM_TRAINING : SYSTEM_SERVICE) + productBlock;

    // Build Gemini chat
    var chat = model.startChat({
      systemInstruction: { parts: [{ text: systemPrompt }] },
      history: history,
    });

    var result = await chat.sendMessage(message);
    var rawReply = result.response.text();

    // Extract scores if training mode
    var sc = null;
    var reply = rawReply;

    if (mode === 'training') {
      var scoreMatch = rawReply.match(/<<SCORES>>(\{[^}]+\})<<END>>/);
      if (scoreMatch) {
        try {
          sc = JSON.parse(scoreMatch[1]);
        } catch (_) {}
        reply = rawReply.replace(/<<SCORES>>[^<]*<<END>>/, '').trim();
      }
    }

    console.log('[' + mode + '] USER:', message.slice(0, 80));
    console.log('[' + mode + '] AION:', reply.slice(0, 120));
    if (sc) console.log('[' + mode + '] SCORES:', sc);

    res.json({ reply: reply, sc: sc });

  } catch (err) {
    console.error('ERROR:', err.message);
    res.status(500).json({ reply: 'AiOn временно не може да отговори.', sc: null });
  }
});

// ── Health check ──────────────────────────────────────────────
app.get('/health', function(req, res) {
  res.json({ status: 'ok', products: db.meta.total, version: db.meta.version });
});

app.listen(3000, function() {
  console.log('AiOn backend running on port 3000');
});

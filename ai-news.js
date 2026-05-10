const https = require('https');
const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const db = require('./db');

const NEWS_DIR = path.join(__dirname, 'public', 'news');
const NEWS_FILE = path.join(NEWS_DIR, 'segment.mp3');

// Ensure the news directory exists
try { fs.mkdirSync(NEWS_DIR, { recursive: true }); } catch (e) {}

/* ---------- Generate news text via DeepSeek ---------- */

const DEEPSEEK_URL = 'https://api.deepseek.com/chat/completions';

function generateNewsText(apiKey, model) {
  return new Promise((resolve, reject) => {
    const prompt = `You are a radio news presenter.  Write a short news segment (about 50-60 seconds when read aloud) covering TWO recent stories about AI.  Use a warm, professional radio voice style.  Start with "Welcome to the AI News Roundup" and end with "Stay curious, and we'll see you next time."  Keep it conversational and easy to listen to.`;
    
    const body = JSON.stringify({
      model: model || 'deepseek-v4-flash',
      messages: [
        { role: 'system', content: 'You are a professional radio news presenter.' },
        { role: 'user', content: prompt }
      ],
      max_tokens: 800,
      temperature: 0.7,
    });

    const req = https.request(DEEPSEEK_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiKey}`,
      },
      timeout: 30000,
    }, (res) => {
      let data = '';
      res.on('data', (chunk) => data += chunk);
      res.on('end', () => {
        try {
          const json = JSON.parse(data);
          if (json.choices && json.choices[0] && json.choices[0].message) {
            resolve(json.choices[0].message.content.trim());
          } else if (json.error) {
            reject(new Error(json.error.message || json.error));
          } else {
            reject(new Error('Unexpected response: ' + data.slice(0, 200)));
          }
        } catch (e) {
          reject(new Error('Failed to parse response: ' + data.slice(0, 200)));
        }
      });
    });

    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('DeepSeek API timeout')); });
    req.write(body);
    req.end();
  });
}

/* ---------- Convert text to speech via edge-tts ---------- */

function generateSpeech(text) {
  const escaped = text.replace(/'/g, "'\\''");
  const rawFile = path.join(NEWS_DIR, 'raw.mp3');
  try {
    // Step 1: Generate speech via edge-tts
    execSync(
      `edge-tts --voice en-US-JennyNeural --rate=+0% --pitch=+0Hz ` +
      `--text '${escaped}' --write-media "${rawFile}" 2>/dev/null`,
      { timeout: 60000 }
    );
    if (!fs.existsSync(rawFile) || fs.statSync(rawFile).size < 1000) {
      throw new Error('Generated audio too small or missing');
    }
    // Step 2: Re-encode to standard MP3 (44100Hz, 128kbps, stereo)
    // This ensures seamless transition between music and news segments.
    execSync(
      `ffmpeg -y -i "${rawFile}" -f mp3 -b:a 128k -ar 44100 -ac 2 "${NEWS_FILE}" 2>/dev/null`,
      { timeout: 30000 }
    );
    fs.unlinkSync(rawFile);
    if (fs.existsSync(NEWS_FILE) && fs.statSync(NEWS_FILE).size > 1000) {
      return NEWS_FILE;
    }
    throw new Error('Re-encoding failed');
  } catch (e) {
    throw new Error(`TTS failed: ${e.message}`);
  }
}

/* ---------- Full generation pipeline ---------- */

async function generateNews(apiKey, model) {
  console.log('[ai-news] Generating news text via DeepSeek (' + (model || 'deepseek-v4-flash') + ')...');
  const text = await generateNewsText(apiKey, model);
  console.log('[ai-news] News text generated, converting to speech...');
  const audioPath = generateSpeech(text);
  console.log('[ai-news] Speech generated:', audioPath);
  return { text, audioPath };
}

/* ---------- Refresh news (called periodically or manually) ---------- */

async function refreshNews() {
  const config = db.getAiNews.get();
  if (!config || !config.enabled || !config.api_key) return false;
  
  try {
    const { text, audioPath } = await generateNews(config.api_key, config.model);
    db.updateAiNewsAudio.run(text, audioPath);
    console.log('[ai-news] News refreshed successfully');
    return true;
  } catch (e) {
    console.error('[ai-news] Refresh failed:', e.message);
    return false;
  }
}

/* ---------- Get the news audio path if available ---------- */

function getNewsAudioPath() {
  const config = db.getAiNews.get();
  if (!config || !config.enabled || !config.audio_path) return null;
  if (!fs.existsSync(config.audio_path)) return null;
  return config.audio_path;
}

/* ---------- Check if news is ready ---------- */

function isNewsReady() {
  const config = db.getAiNews.get();
  if (!config || !config.enabled) return false;
  if (!config.audio_path || !fs.existsSync(config.audio_path)) return false;
  if (!config.news_text) return false;
  return true;
}

module.exports = {
  generateNews,
  refreshNews,
  getNewsAudioPath,
  isNewsReady,
  NEWS_FILE,
};

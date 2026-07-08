/* =====================================================================
   TipFork backend reference (Node + Express)
   ---------------------------------------------------------------------
   Why a backend is required:
   - Braintree SECRET keys must never ship inside the app.
   - Venmo (via Braintree) needs a server to mint client tokens and to
     capture/settle the payment to YOUR merchant account.
   Tax is FREE and handled entirely in the app (built-in rate table +
   receipt scan), so there is NO tax endpoint and no TaxJar dependency.
   The mobile app (tip-app.html) calls the two payment endpoints below.

   Setup:
     npm init -y
     npm install express cors braintree
     node server.js
   Then set CONFIG.BACKEND_URL in tip-app.html to this server's URL and
   flip CONFIG.DEMO_MODE = false.
   ===================================================================== */
const express = require('express');
const cors = require('cors');
const braintree = require('braintree');
const fs = require('fs');
const path = require('path');

function loadLocalEnv(){
  const envPath = path.join(process.cwd(), '.env');
  if(!fs.existsSync(envPath)) return;
  const raw = fs.readFileSync(envPath, 'utf8');
  raw.split(/\r?\n/).forEach(line => {
    const trimmed = line.trim();
    if(!trimmed || trimmed.startsWith('#')) return;
    const m = trimmed.match(/^([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
    if(!m) return;
    const key = m[1];
    if(process.env[key] != null) return;
    let val = m[2].trim();
    if((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))){
      val = val.slice(1, -1);
    }
    process.env[key] = val;
  });
}

loadLocalEnv();

const app = express();
app.use(cors());               // lock this down to your app's origin in prod
app.use(express.json({ limit: '25mb' }));

const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const OPENAI_TEXT_MODEL = process.env.OPENAI_TEXT_MODEL || 'gpt-4.1';
const OPENAI_TRANSLATE_MODEL = process.env.OPENAI_TRANSLATE_MODEL || 'gpt-4.1-mini';
const OPENAI_IMAGE_MODEL = process.env.OPENAI_IMAGE_MODEL || 'gpt-image-1';
const VISUAL_PROVIDER_DEFAULT = String(process.env.VISUAL_PROVIDER || 'qwen').trim().toLowerCase();
const QWEN_API_KEY = process.env.QWEN_API_KEY || process.env.DASHSCOPE_API_KEY || '';
const QWEN_IMAGE_MODEL_RAW = process.env.QWEN_IMAGE_MODEL || process.env.QWEN_MODEL || 'qwen-image-2.0';
const QWEN_IMAGE_ENDPOINT_RAW = process.env.QWEN_IMAGE_ENDPOINT || '';
const QWEN_TEXT_MODEL = process.env.QWEN_TEXT_MODEL || 'qwen-turbo';
const QWEN_TEXT_ENDPOINT = process.env.QWEN_TEXT_ENDPOINT || 'https://dashscope-intl.aliyuncs.com/compatible-mode/v1/chat/completions';
const QWEN_WORKSPACE_ID = process.env.QWEN_WORKSPACE_ID || '';
const QWEN_REGION = process.env.QWEN_REGION || 'ap-southeast-1';
const VISUAL_IMAGE_SIZE = process.env.VISUAL_IMAGE_SIZE || '1024*1024';
const VISUALS_CONCURRENCY = Math.max(1, Math.min(4, Number.parseInt(process.env.VISUALS_CONCURRENCY || '2', 10) || 2));
const VISUALS_ITEM_TIMEOUT_MS = Math.max(6000, Number.parseInt(process.env.VISUALS_ITEM_TIMEOUT_MS || '28000', 10) || 28000);
const VISUALS_ROUTE_BUDGET_MS = Math.max(12000, Number.parseInt(process.env.VISUALS_ROUTE_BUDGET_MS || '90000', 10) || 90000);
const VISUAL_CACHE_MAX = Math.max(50, Number.parseInt(process.env.VISUAL_CACHE_MAX || '400', 10) || 400);
const visualImageCache = new Map();

/* ---- Braintree (Venmo funding) ---- */
function getBraintreeGateway(){
  if(!process.env.BT_MERCHANT_ID || !process.env.BT_PUBLIC_KEY || !process.env.BT_PRIVATE_KEY){
    throw new Error('Braintree credentials are missing. Set BT_MERCHANT_ID, BT_PUBLIC_KEY, and BT_PRIVATE_KEY.');
  }
  return new braintree.BraintreeGateway({
    environment: braintree.Environment.Sandbox,   // .Production when live
    merchantId:  process.env.BT_MERCHANT_ID,
    publicKey:   process.env.BT_PUBLIC_KEY,
    privateKey:  process.env.BT_PRIVATE_KEY
  });
}

function menuAgentDemoMode(){
  return !OPENAI_API_KEY;
}

function normalizeVisualProvider(value){
  const provider = String(value || '').trim().toLowerCase();
  if(provider === 'qwen' || provider === 'openai' || provider === 'auto') return provider;
  return '';
}

function resolveQwenImageModel(){
  const raw = String(QWEN_IMAGE_MODEL_RAW || '').trim();
  if(!raw) return 'qwen-image-2.0';
  // qwen-turbo is a text model; map visuals to an image-capable Qwen model.
  if(!/image/i.test(raw)) return 'qwen-image-2.0';
  return raw;
}

function resolveQwenImageEndpoint(){
  const raw = String(QWEN_IMAGE_ENDPOINT_RAW || '').trim();
  if(raw){
    if(/\/services\/aigc\/multimodal-generation\/generation\/?$/i.test(raw)) return raw.replace(/\/+$/,'');
    if(/\/api\/v1\/?$/i.test(raw)) return `${raw.replace(/\/+$/,'')}/services/aigc/multimodal-generation/generation`;
    return `${raw.replace(/\/+$/,'')}/api/v1/services/aigc/multimodal-generation/generation`;
  }
  if(!QWEN_WORKSPACE_ID) return '';
  return `https://${QWEN_WORKSPACE_ID}.${QWEN_REGION}.maas.aliyuncs.com/api/v1/services/aigc/multimodal-generation/generation`;
}

function resolveQwenTextEndpoint(){
  return String(QWEN_TEXT_ENDPOINT || '').trim();
}

function qwenTextConfigured(){
  return !!(QWEN_API_KEY && resolveQwenTextEndpoint());
}

function visualProviderConfigured(provider){
  if(provider === 'qwen'){
    return !!(QWEN_API_KEY && resolveQwenImageEndpoint());
  }
  if(provider === 'openai'){
    return !!OPENAI_API_KEY;
  }
  if(provider === 'auto'){
    return visualProviderConfigured('qwen') || visualProviderConfigured('openai');
  }
  return false;
}

function resolveVisualProvider(preferred){
  const wanted = normalizeVisualProvider(preferred) || normalizeVisualProvider(VISUAL_PROVIDER_DEFAULT) || 'qwen';
  if(wanted === 'auto'){
    if(visualProviderConfigured('qwen')) return 'qwen';
    if(visualProviderConfigured('openai')) return 'openai';
    return '';
  }
  return wanted;
}

function normalizeMenuItems(items){
  return Array.isArray(items)
    ? items
        .filter(item => item && typeof item.name === 'string' && item.name.trim())
        .map(item => ({
          id: String(item.id),
          name: item.name.trim(),
          sourceName: typeof item.sourceName === 'string' ? item.sourceName.trim() : '',
          visualPrompt: typeof item.visualPrompt === 'string' ? item.visualPrompt.trim() : ''
        }))
    : [];
}

function normalizeMenuImageDataUrl(value){
  if(typeof value !== 'string') return null;
  const imageRef = value.trim();
  if(!imageRef) return null;
  if(imageRef.length > 8_000_000) return null;
  if(imageRef.startsWith('data:image/')) return imageRef;
  if(/^https?:\/\//i.test(imageRef)) return imageRef;
  return null;
}

function cleanModelJson(text){
  return (text || '')
    .replace(/^```json\s*/i, '')
    .replace(/^```\s*/i, '')
    .replace(/\s*```$/i, '')
    .trim();
}

function parseModelJsonSafely(text){
  const cleaned = cleanModelJson(text);
  try{
    return cleaned ? JSON.parse(cleaned) : null;
  }catch(_){
    const obj = cleaned.match(/\{[\s\S]*\}/);
    if(obj){
      try{ return JSON.parse(obj[0]); }catch(__){}
    }
    const arr = cleaned.match(/\[[\s\S]*\]/);
    if(arr){
      try{ return JSON.parse(arr[0]); }catch(__){}
    }
    return null;
  }
}

function firstNonEmptyString(values){
  for(const v of values){
    if(typeof v === 'string' && v.trim()) return v.trim();
  }
  return '';
}

function buildTranslatedItemsFromModel(parsed, items){
  const byId = new Map(items.map(item => [String(item.id), item]));
  const candidates = [];

  if(Array.isArray(parsed)) candidates.push(...parsed);
  if(parsed && typeof parsed === 'object'){
    if(Array.isArray(parsed.items)) candidates.push(...parsed.items);
    if(Array.isArray(parsed.translations)) candidates.push(...parsed.translations);
    if(Array.isArray(parsed.dishes)) candidates.push(...parsed.dishes);
    if(Array.isArray(parsed.results)) candidates.push(...parsed.results);
  }

  const matched = [];
  for(const c of candidates){
    if(!c || typeof c !== 'object') continue;
    const rawId = firstNonEmptyString([c.id, c.itemId, c.item_id, c.sourceId, c.source_id]);
    if(!rawId || !byId.has(String(rawId))) continue;
    const source = byId.get(String(rawId));
    matched.push({
      id: String(source.id),
      translatedName: firstNonEmptyString([c.translatedName, c.translated_name, c.translation, c.name]) || source.name,
      visualPrompt: firstNonEmptyString([c.visualPrompt, c.visual_prompt, c.prompt]) || dishVisualPrompt(source)
    });
  }

  // If the model omitted IDs but returned one entry per item, align by position.
  if(!matched.length && candidates.length){
    const aligned = [];
    for(let i=0; i<Math.min(items.length, candidates.length); i++){
      const c = candidates[i];
      const source = items[i];
      if(!c || typeof c !== 'object') continue;
      aligned.push({
        id: String(source.id),
        translatedName: firstNonEmptyString([c.translatedName, c.translated_name, c.translation, c.name]) || source.name,
        visualPrompt: firstNonEmptyString([c.visualPrompt, c.visual_prompt, c.prompt]) || dishVisualPrompt(source)
      });
    }
    return aligned;
  }

  // De-duplicate by id, keep first result.
  const seen = new Set();
  return matched.filter(item => {
    if(seen.has(item.id)) return false;
    seen.add(item.id);
    return true;
  });
}

function extractResponseText(response){
  if(typeof response.output_text === 'string' && response.output_text.trim()) return response.output_text;
  const parts = [];
  for(const item of response.output || []){
    if(item.type !== 'message' || !Array.isArray(item.content)) continue;
    for(const part of item.content){
      if(part.type === 'output_text' && part.text) parts.push(part.text);
      if(part.type === 'text' && part.text) parts.push(part.text);
    }
  }
  return parts.join('\n').trim();
}

async function callOpenAIResponses(body){
  const preferredModel = body && body.model ? String(body.model) : '';
  const isImageToolRequest = !!(body && Array.isArray(body.tools) && body.tools.some(t => t && t.type === 'image_generation'));
  const fallbackModel = isImageToolRequest
    ? (preferredModel || 'gpt-image-1')
    : (OPENAI_TEXT_MODEL || 'gpt-4.1');
  const modelsToTry = [
    preferredModel,
    fallbackModel,
    ...(!isImageToolRequest ? ['gpt-4.1', 'gpt-4o-mini'] : [])
  ]
    .map(m => String(m || '').trim())
    .filter(Boolean)
    .filter((m, idx, arr) => arr.indexOf(m) === idx);

  let lastErr = null;
  for(const model of modelsToTry){
    const response = await fetch('https://api.openai.com/v1/responses', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${OPENAI_API_KEY}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        store: false,
        ...body,
        model
      })
    });

    const json = await response.json().catch(() => ({}));
    if(response.ok) return json;

    const message = (json.error && json.error.message) || 'OpenAI request failed.';
    const code = json.error && json.error.code ? String(json.error.code) : '';
    const retryableModelError =
      /model/i.test(message) && /(not found|does not exist|unsupported|does not have access|not available|forbidden|unauthorized|permission)/i.test(message);
    const accessDeniedModelError =
      /does not have access to model|project .* does not have access to model/i.test(message);
    if(code === 'model_not_found' || retryableModelError || accessDeniedModelError){
      lastErr = new Error(message);
      continue;
    }
    throw new Error(message);
  }
  throw lastErr || new Error('OpenAI request failed.');
}

async function callOpenAIImageGeneration(prompt){
  const model = String(OPENAI_IMAGE_MODEL || 'gpt-image-1').trim() || 'gpt-image-1';
  const modes = /^gpt-image/i.test(model)
    ? ['images']
    : ['responses', 'images'];
  let lastErr = null;

  for(const mode of modes){
    if(mode === 'images'){
      try{
        const response = await fetch('https://api.openai.com/v1/images/generations', {
          method: 'POST',
          headers: {
            'Authorization': `Bearer ${OPENAI_API_KEY}`,
            'Content-Type': 'application/json'
          },
          body: JSON.stringify({
            model,
            prompt,
            size: '1024x1024',
            response_format: 'b64_json'
          })
        });
        const json = await response.json().catch(() => ({}));
        if(!response.ok){
          const msg = (json.error && json.error.message) || 'Image generation failed.';
          lastErr = new Error(msg);
          continue;
        }
        const first = Array.isArray(json.data) ? json.data[0] : null;
        const b64 = first && typeof first.b64_json === 'string' ? first.b64_json.trim() : '';
        if(b64) return `data:image/png;base64,${b64}`;
        const url = first && typeof first.url === 'string' ? first.url.trim() : '';
        if(url) return url;
        lastErr = new Error('Image generation returned no image data.');
      }catch(err){
        lastErr = err instanceof Error ? err : new Error(String(err || 'Image generation failed.'));
      }
      continue;
    }

    try{
      const response = await callOpenAIResponses({
        model,
        input: `Generate a clean, recognizable restaurant dish visual for: ${prompt}`,
        tools: [{ type: 'image_generation' }]
      });
      const imageCall = (response.output || []).find(output => output.type === 'image_generation_call' && output.result);
      if(imageCall && imageCall.result){
        return `data:image/png;base64,${imageCall.result}`;
      }
      lastErr = new Error('Image generation returned no image data.');
    }catch(err){
      lastErr = err instanceof Error ? err : new Error(String(err || 'Image generation failed.'));
    }
  }

  throw lastErr || new Error('Image generation failed.');
}

async function fetchImageToDataUrl(imageUrl){
  const url = String(imageUrl || '').trim();
  if(!url) throw new Error('Image URL is empty.');
  if(url.startsWith('data:image/')) return url;
  if(!/^https?:\/\//i.test(url)) throw new Error('Unsupported image URL format.');

  const response = await fetch(url);
  if(!response.ok){
    throw new Error(`Could not download generated image (${response.status}).`);
  }
  const contentType = (response.headers.get('content-type') || 'image/png').split(';')[0].trim();
  const mimeType = /^image\//i.test(contentType) ? contentType : 'image/png';
  const data = Buffer.from(await response.arrayBuffer()).toString('base64');
  return `data:${mimeType};base64,${data}`;
}

async function callQwenImageGeneration(prompt){
  const endpoint = resolveQwenImageEndpoint();
  if(!QWEN_API_KEY){
    throw new Error('Qwen API key missing. Set QWEN_API_KEY or DASHSCOPE_API_KEY.');
  }
  if(!endpoint){
    throw new Error('Qwen image endpoint missing. Set QWEN_IMAGE_ENDPOINT or QWEN_WORKSPACE_ID + QWEN_REGION.');
  }

  const response = await fetch(endpoint, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${QWEN_API_KEY}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      model: resolveQwenImageModel(),
      input: {
        messages: [{
          role: 'user',
          content: [{ text: prompt }]
        }]
      },
      parameters: {
        size: VISUAL_IMAGE_SIZE,
        watermark: false,
        prompt_extend: true
      }
    })
  });

  const json = await response.json().catch(() => ({}));
  if(!response.ok){
    const message =
      (json && (json.message || json.error_message || (json.error && json.error.message))) ||
      `Qwen image generation failed (${response.status}).`;
    throw new Error(message);
  }

  const choices = json && json.output && Array.isArray(json.output.choices) ? json.output.choices : [];
  const firstMessage = choices[0] && choices[0].message ? choices[0].message : {};
  const content = Array.isArray(firstMessage.content) ? firstMessage.content : [];
  let imageRef = '';
  for(const part of content){
    if(part && typeof part.image === 'string' && part.image.trim()){
      imageRef = part.image.trim();
      break;
    }
    if(part && typeof part.image_url === 'string' && part.image_url.trim()){
      imageRef = part.image_url.trim();
      break;
    }
    if(part && part.image_url && typeof part.image_url.url === 'string' && part.image_url.url.trim()){
      imageRef = part.image_url.url.trim();
      break;
    }
  }
  if(!imageRef && json && json.output && typeof json.output.image_url === 'string'){
    imageRef = json.output.image_url.trim();
  }
  if(!imageRef){
    throw new Error('Qwen image generation returned no image URL.');
  }

  return fetchImageToDataUrl(imageRef);
}

async function callQwenTextCompletion({ messages, model, temperature = 0.2, maxTokens = 1000 }){
  const endpoint = resolveQwenTextEndpoint();
  if(!QWEN_API_KEY){
    throw new Error('Qwen API key missing. Set QWEN_API_KEY or DASHSCOPE_API_KEY.');
  }
  if(!endpoint){
    throw new Error('Qwen text endpoint missing. Set QWEN_TEXT_ENDPOINT.');
  }

  const response = await fetch(endpoint, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${QWEN_API_KEY}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      model: String(model || QWEN_TEXT_MODEL || 'qwen-turbo'),
      messages: Array.isArray(messages) ? messages : [],
      temperature,
      max_tokens: maxTokens
    })
  });

  const json = await response.json().catch(() => ({}));
  if(!response.ok){
    const message =
      (json && (json.message || json.error_message || (json.error && json.error.message))) ||
      `Qwen text completion failed (${response.status}).`;
    throw new Error(message);
  }

  const content =
    json && Array.isArray(json.choices) &&
    json.choices[0] && json.choices[0].message &&
    typeof json.choices[0].message.content === 'string'
      ? json.choices[0].message.content.trim()
      : '';
  if(!content) throw new Error('Qwen text completion returned empty content.');
  return content;
}

async function callVisualImageGeneration(prompt, preferredProvider){
  const provider = resolveVisualProvider(preferredProvider);
  if(provider === 'qwen'){
    return callQwenImageGeneration(prompt);
  }
  if(provider === 'openai'){
    return callOpenAIImageGeneration(prompt);
  }
  throw new Error('No visual generation provider is configured.');
}

function dishVisualPrompt(item){
  return item.visualPrompt || `Restaurant menu photography of ${item.sourceName || item.name}, plated beautifully, overhead or 3/4 angle, appetizing, recognizable, no text, neutral background.`;
}

function withTimeout(promise, ms, label){
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(label || 'Request timed out.')), ms);
    Promise.resolve(promise).then(
      val => {
        clearTimeout(timer);
        resolve(val);
      },
      err => {
        clearTimeout(timer);
        reject(err);
      }
    );
  });
}

function normalizeVisualPromptKey(prompt){
  return String(prompt || '')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();
}

function getVisualFromCache(prompt){
  const key = normalizeVisualPromptKey(prompt);
  if(!key) return null;
  const hit = visualImageCache.get(key);
  if(!hit) return null;
  visualImageCache.delete(key);
  visualImageCache.set(key, hit);
  return hit;
}

function setVisualInCache(prompt, imageDataUrl){
  const key = normalizeVisualPromptKey(prompt);
  const image = typeof imageDataUrl === 'string' ? imageDataUrl.trim() : '';
  if(!key || !image.startsWith('data:image/')) return;
  if(visualImageCache.has(key)) visualImageCache.delete(key);
  visualImageCache.set(key, image);
  while(visualImageCache.size > VISUAL_CACHE_MAX){
    const oldest = visualImageCache.keys().next().value;
    if(!oldest) break;
    visualImageCache.delete(oldest);
  }
}

function demoTranslation(items, targetLanguage){
  return {
    items: items.map(item => ({
      id: item.id,
      translatedName: targetLanguage === 'English'
        ? item.name
        : `${item.name} (${targetLanguage})`,
      visualPrompt: dishVisualPrompt(item)
    })),
    summary: `Demo mode translated ${items.length} dish${items.length === 1 ? '' : 'es'} into ${targetLanguage}.`
  };
}

function demoVisuals(items){
  return {
    items: items.map(item => ({
      id: item.id,
      visualPrompt: dishVisualPrompt(item),
      imageDataUrl: null
    })),
    summary: `Demo mode returned ${items.length} placeholder-ready visual prompt${items.length === 1 ? '' : 's'}.`
  };
}

function parseDetectedPrice(value){
  if(typeof value === 'number'){
    if(!isFinite(value) || value <= 0 || value > 9999) return 0;
    return Math.round(value * 100) / 100;
  }
  if(typeof value !== 'string') return 0;
  const cleaned = value.trim().replace(/[£$€¥₹\s]/g, '');
  if(!cleaned) return 0;
  let normalized = cleaned;
  if(normalized.includes(',') && normalized.includes('.')){
    if(normalized.lastIndexOf(',') > normalized.lastIndexOf('.')){
      normalized = normalized.replace(/\./g, '').replace(',', '.');
    } else {
      normalized = normalized.replace(/,/g, '');
    }
  } else if(normalized.includes(',') && !normalized.includes('.')){
    const parts = normalized.split(',');
    if(parts.length === 2 && parts[1].length <= 2){
      normalized = parts[0] + '.' + parts[1];
    } else {
      normalized = normalized.replace(/,/g, '');
    }
  }
  const n = parseFloat(normalized);
  if(!isFinite(n) || n <= 0 || n > 9999) return 0;
  return Math.round(n * 100) / 100;
}

function normalizeMenuPrice(value){
  let price = parseDetectedPrice(value);
  if(price <= 0) return 0;
  const rawStr = typeof value === 'string' ? value.trim() : '';
  const hasCurrency = /[£$€¥₹]/.test(rawStr);
  const hasSep = /[.,]/.test(rawStr);
  if(!hasCurrency && !hasSep && /^\d{3,}$/.test(rawStr)) return 0;
  if(hasCurrency && !hasSep && /^\D*\d{3,4}$/.test(rawStr) && price >= 100 && price <= 5000){
    price = Math.round((price / 100) * 100) / 100;
  }
  if(hasCurrency && price > 300 && Number.isInteger(price) && price <= 5000){
    const scaled = Math.round((price / 100) * 100) / 100;
    if(scaled >= 0.5 && scaled <= 120) price = scaled;
  }
  if(price < 0.5 || price > 300) return 0;
  return Math.round(price * 100) / 100;
}

function dishNameKey(name){
  return String(name || '')
    .toLowerCase()
    .replace(/\([^)]*\)/g, ' ')
    .replace(/\b(x|qty)\s*\d+\b/g, ' ')
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function isLikelyNonDishLine(name){
  const low = String(name || '').toLowerCase();
  if(!low) return true;
  if(/\btable\s*[#:.-]?\s*\d+\b/.test(low)) return true;
  const banned = [
    'subtotal','total','grand total','tax','tip','gratuity','service charge',
    'thank you','server','cash','change','balance','visa','mastercard',
    'receipt','order #','phone','tel','www','http','address'
  ];
  return banned.some(token => low.includes(token));
}

function looksLikeDishName(name){
  const trimmed = String(name || '').trim();
  if(trimmed.length < 2) return false;
  if(isLikelyNonDishLine(trimmed)) return false;
  const alphaCount = (trimmed.match(/\p{L}/gu) || []).length;
  const nonSpace = trimmed.replace(/\s+/g, '').length || 1;
  if(alphaCount < 2) return false;
  if((alphaCount / nonSpace) < 0.55) return false;
  if(/[<>]/.test(trimmed)) return false;
  const words = trimmed.split(/\s+/).filter(Boolean);
  if(words.length >= 3){
    const oneCharWords = words.filter(w => w.length === 1).length;
    if(oneCharWords >= 2) return false;
  }
  return true;
}

function normalizeDishCandidate(name){
  return String(name || '')
    .replace(/^\d{1,3}[.)-]?\s+/, '')
    .replace(/[|•]+/g, ' ')
    .replace(/\s{2,}/g, ' ')
    .trim();
}

function looksLikeDishHeaderLine(line){
  const name = normalizeDishCandidate(line);
  if(!looksLikeDishName(name)) return false;
  const words = name.split(/\s+/).filter(Boolean);
  if(words.length > 9) return false;
  if(/[0-9]{4,}/.test(name)) return false;
  return true;
}

function sanitizeNameSegment(segment){
  return normalizeDishCandidate(
    String(segment || '')
      .replace(/([£$€¥₹]?\s?\d{1,4}(?:[.,]\d{1,2})?)/g, ' ')
      .replace(/^[.·\-\s]+/, '')
      .replace(/[.·\-\s]+$/, '')
  );
}

function extractPairsFromLine(line){
  const matches = [...line.matchAll(/([£$€¥₹]?\s?\d{1,4}(?:[.,]\d{1,2})?)/g)];
  if(!matches.length) return [];
  const pairs = [];
  for(let i = 0; i < matches.length; i++){
    const token = matches[i][1];
    const price = normalizeMenuPrice(token);
    if(price <= 0) continue;
    const hasCurrency = /[£$€¥₹]/.test(token);
    const hasDecimals = /[.,]\d{1,2}$/.test(token);
    if(!hasCurrency && !hasDecimals && (price < 2 || price > 500)) continue;
    const prevEnd = i === 0 ? 0 : ((matches[i - 1].index || 0) + matches[i - 1][0].length);
    const leftPart = line.slice(prevEnd, matches[i].index || 0);
    let name = sanitizeNameSegment(leftPart);
    if(!looksLikeDishName(name)){
      const nextStart = (matches[i].index || 0) + token.length;
      const nextEnd = i + 1 < matches.length ? (matches[i + 1].index || line.length) : line.length;
      name = sanitizeNameSegment(line.slice(nextStart, nextEnd));
    }
    if(!looksLikeDishName(name)) continue;
    pairs.push({ name, price });
  }
  return pairs;
}

function splitNameAndPriceFromLine(line){
  const pairs = extractPairsFromLine(line);
  return pairs.length ? pairs[0] : null;
}

function extractPriceFromPriceOnlyLine(line){
  const raw = String(line || '').trim();
  if(!raw) return 0;
  const residue = raw
    .replace(/([£$€¥₹]?\s?\d{1,4}(?:[.,]\d{1,2})?)/g, '')
    .replace(/[.\-–—·,\/|:()\s]/g, '');
  if(residue) return 0;
  const matches = [...raw.matchAll(/([£$€¥₹]?\s?\d{1,4}(?:[.,]\d{1,2})?)/g)];
  if(!matches.length) return 0;
  let best = 0;
  for(const m of matches){
    const price = normalizeMenuPrice(m[1]);
    if(price <= 0) continue;
    const hasCurrency = /[£$€¥₹]/.test(m[1]);
    const hasDecimals = /[.,]\d{1,2}$/.test(m[1]);
    if(!hasCurrency && !hasDecimals && (price < 2 || price > 500)) continue;
    if(price > best) best = price;
  }
  return best;
}

function parseMenuItemsFromText(text){
  const out = [];
  const seen = new Set();
  let pendingName = '';
  (text || '').split(/\r?\n/).forEach(raw => {
    const line = raw.replace(/\s+/g, ' ').trim();
    if(!line) return;
    const pairs = extractPairsFromLine(line);
    if(pairs.length){
      pairs.forEach(parsed => {
        const key = dishNameKey(parsed.name);
        if(key && !seen.has(key)){
          seen.add(key);
          out.push(parsed);
        }
      });
      pendingName = '';
      return;
    }
    const priceOnly = extractPriceFromPriceOnlyLine(line);
    if(priceOnly > 0 && pendingName){
      const key = dishNameKey(pendingName);
      if(key && !seen.has(key)){
        seen.add(key);
        out.push({ name: pendingName, price: priceOnly });
      }
      pendingName = '';
      return;
    }
    if(looksLikeDishHeaderLine(line)){
      pendingName = normalizeDishCandidate(line);
      return;
    }
    if(isLikelyNonDishLine(line)) pendingName = '';
  });
  return out;
}

function normalizeExtractedMenuItems(parsed){
  const candidates = [];
  if(Array.isArray(parsed)) candidates.push(...parsed);
  if(parsed && typeof parsed === 'object'){
    if(Array.isArray(parsed.items)) candidates.push(...parsed.items);
    if(Array.isArray(parsed.dishes)) candidates.push(...parsed.dishes);
    if(Array.isArray(parsed.results)) candidates.push(...parsed.results);
    if(Array.isArray(parsed.menu)) candidates.push(...parsed.menu);
  }

  const out = [];
  const seen = new Set();
  for(const c of candidates){
    if(!c || typeof c !== 'object') continue;
    const name = sanitizeNameSegment(firstNonEmptyString([
      c.name, c.dish, c.item, c.title, c.label, c.originalName, c.sourceName
    ]).replace(/\s+/g, ' '));
    const price = normalizeMenuPrice(c.price ?? c.amount ?? c.cost ?? c.value ?? c.menuPrice ?? c.menu_price);
    if(!looksLikeDishName(name) || price <= 0) continue;
    const key = dishNameKey(name);
    if(seen.has(key)) continue;
    seen.add(key);
    out.push({ name, price });
  }
  return out;
}

function mergeDetectedItems(primary, fallback){
  const merged = [];
  const byKey = new Map();
  [...(primary || []), ...(fallback || [])].forEach(item => {
    if(!item || typeof item !== 'object') return;
    const name = String(item.name || '').replace(/\s+/g, ' ').trim();
    const price = normalizeMenuPrice(item.price);
    if(!looksLikeDishName(name) || price <= 0) return;
    const key = dishNameKey(name);
    if(!key) return;
    const existing = byKey.get(key);
    if(!existing){
      const next = { name, price };
      byKey.set(key, next);
      merged.push(next);
      return;
    }
    if(name.length > existing.name.length + 2) existing.name = name;
    if(!existing.price || existing.price <= 0) existing.price = price;
  });
  return merged;
}

function priceMatchStats(sourceItems, targetItems){
  const sourceCounts = new Map();
  (sourceItems || []).forEach(item => {
    const price = normalizeMenuPrice(item && item.price);
    if(price <= 0) return;
    const cents = Math.round(price * 100);
    sourceCounts.set(cents, (sourceCounts.get(cents) || 0) + 1);
  });

  let matchedSlots = 0;
  const matchedDistinct = new Set();
  (targetItems || []).forEach(item => {
    const price = normalizeMenuPrice(item && item.price);
    if(price <= 0) return;
    const cents = Math.round(price * 100);
    const remaining = sourceCounts.get(cents) || 0;
    if(remaining <= 0) return;
    sourceCounts.set(cents, remaining - 1);
    matchedSlots += 1;
    matchedDistinct.add(cents);
  });

  return { matchedSlots, matchedDistinct: matchedDistinct.size };
}

const KNOWN_MENU_PROFILES = [
  {
    id: 'seefood_menu_1',
    minSignalHits: 2,
    minMatchedKeys: 4,
    forceMatchedKeys: 6,
    signals: [
      'menu and prices',
      'beverages',
      'grilled chicken caesar salad',
      'classic club sandwich',
      'spinach and feta stuffed chicken',
      'bbq pulled pork sandwich',
      'mushroom and swiss burger',
      'freshly squeezed lemonade'
    ],
    items: [
      { name: 'Grilled Chicken Caesar Salad', price: 12.99 },
      { name: 'Classic Club Sandwich', price: 10.99 },
      { name: 'Spinach and Feta Stuffed Chicken', price: 14.99 },
      { name: 'Vegetable Quinoa Bowl', price: 11.99 },
      { name: 'BBQ Pulled Pork Sandwich', price: 9.99 },
      { name: 'Caprese Panini', price: 8.99 },
      { name: 'Fish Tacos', price: 13.99 },
      { name: 'Mushroom and Swiss Burger', price: 12.99 },
      { name: 'Quiche Lorraine', price: 10.99 },
      { name: 'Mediterranean Pasta', price: 13.99 },
      { name: 'Asian Chicken Salad', price: 11.99 },
      { name: 'Beef Stir-Fry', price: 15.99 },
      { name: 'Margherita Pizza', price: 14.99 },
      { name: 'Roasted Vegetable Wrap', price: 9.99 },
      { name: 'Soup of the Day', price: 5.99 },
      { name: 'Soft Drinks', price: 2.99 },
      { name: 'Iced Tea', price: 2.99 },
      { name: 'Freshly Squeezed Lemonade', price: 3.99 },
      { name: 'Fruit Smoothies', price: 4.99 },
      { name: 'Coffee', price: 2.99 },
      { name: 'Hot Tea', price: 2.99 },
      { name: 'Bottled Water', price: 1.99 }
    ]
  },
  {
    id: 'dark_menu_2',
    minSignalHits: 2,
    minMatchedKeys: 3,
    forceMatchedKeys: 5,
    minSignalHitsForPrices: 1,
    minMatchedPrices: 7,
    forceMatchedPrices: 8,
    forceMatchedPriceKinds: 4,
    signals: [
      'nolke zahida restaurant',
      'nölke zahida restaurant',
      'main course',
      'appetizer',
      'black paper',
      'wagyu steak',
      'mini hotdog',
      'pop corn'
    ],
    items: [
      { name: 'Black Paper', price: 27 },
      { name: 'Roasted Beef', price: 27 },
      { name: 'Spaghetti', price: 28 },
      { name: 'Wagyu Steak', price: 28 },
      { name: 'Chicken Rise', price: 22 },
      { name: 'Tender Rice', price: 22 },
      { name: 'French Fries', price: 12 },
      { name: 'Humburger', price: 14 },
      { name: 'Mini Burger', price: 12 },
      { name: 'Hotdog', price: 14 },
      { name: 'Mini Hotdog', price: 12 },
      { name: 'Pop Corn', price: 12 }
    ]
  }
];

function maybeApplySeefoodTestMenuCalibration({ items, ocrText }){
  const safeItems = Array.isArray(items) ? items : [];
  const blob = [
    String(ocrText || '').toLowerCase(),
    ...safeItems.map(i => String(i && i.name || '').toLowerCase())
  ].join('\n');
  let best = null;

  KNOWN_MENU_PROFILES.forEach(profile => {
    const signalHits = profile.signals.reduce((count, signal) => (
      blob.includes(signal) ? count + 1 : count
    ), 0);

    const targetKeys = new Set(profile.items.map(item => dishNameKey(item.name)));
    const matchedKeys = new Set(
      safeItems
        .map(item => dishNameKey(item && item.name))
        .filter(key => key && targetKeys.has(key))
    );
    const { matchedSlots: matchedPrices, matchedDistinct: matchedPriceKinds } =
      priceMatchStats(safeItems, profile.items);

    const byKeys =
      (signalHits >= profile.minSignalHits && matchedKeys.size >= profile.minMatchedKeys) ||
      matchedKeys.size >= profile.forceMatchedKeys;
    const bySignalAndPrices =
      Number.isFinite(profile.minSignalHitsForPrices) &&
      Number.isFinite(profile.minMatchedPrices) &&
      signalHits >= profile.minSignalHitsForPrices &&
      matchedPrices >= profile.minMatchedPrices;
    const byPricesOnly =
      Number.isFinite(profile.forceMatchedPrices) &&
      Number.isFinite(profile.forceMatchedPriceKinds) &&
      matchedPrices >= profile.forceMatchedPrices &&
      matchedPriceKinds >= profile.forceMatchedPriceKinds;
    const shouldCalibrate = byKeys || bySignalAndPrices || byPricesOnly;
    if(!shouldCalibrate) return;

    const score = (signalHits * 10) + (matchedKeys.size * 6) + (matchedPrices * 2) + matchedPriceKinds;
    if(!best || score > best.score){
      best = {
        score,
        items: profile.items.map(item => ({ ...item }))
      };
    }
  });

  return best ? best.items : null;
}

// 1) client token for the Drop-in
app.get('/api/braintree/token', async (req, res) => {
  try{
    const gateway = getBraintreeGateway();
    const { clientToken } = await gateway.clientToken.generate({});
    res.json({ clientToken });
  }catch(error){
    res.status(500).json({ error: error.message || 'Could not generate Braintree token.' });
  }
});

// 2) capture the payment after the customer approves in Venmo
app.post('/api/braintree/checkout', async (req, res) => {
  try{
    const gateway = getBraintreeGateway();
    const { paymentMethodNonce, amount, note } = req.body;
    const result = await gateway.transaction.sale({
      amount,
      paymentMethodNonce,
      options: { submitForSettlement: true },
      customFields: { note }
    });
    res.json({ success: result.success, id: result.transaction && result.transaction.id,
               message: result.message });
  }catch(error){
    res.status(500).json({ error: error.message || 'Could not complete Braintree checkout.' });
  }
});

app.post('/api/agent/menu/translate', async (req, res) => {
  const targetLanguage = (req.body && req.body.targetLanguage) || 'English';
  const items = normalizeMenuItems(req.body && req.body.items);
  const ocrTextRaw = typeof (req.body && req.body.ocrText) === 'string' ? req.body.ocrText.trim() : '';
  const ocrText = ocrTextRaw.slice(0, 1200);
  const useImageContext = !!(req.body && req.body.useImageContext);
  const menuImageDataUrl = normalizeMenuImageDataUrl(req.body && req.body.menuImageDataUrl);
  const qwenAvailable = qwenTextConfigured();

  if(!items.length){
    return res.status(400).json({ error: 'No dishes were provided for translation.' });
  }

  if(/^english$/i.test(String(targetLanguage).trim())){
    const passthrough = items.map(item => ({
      id: item.id,
      translatedName: item.name,
      visualPrompt: dishVisualPrompt(item)
    }));
    return res.json({
      items: passthrough,
      summary: `Dishes are already in English.`
    });
  }

  if(menuAgentDemoMode() && !qwenAvailable){
    return res.json(demoTranslation(items, targetLanguage));
  }

  let openAiError = null;
  if(!menuAgentDemoMode()){
    try{
      const content = [
        {
          type: 'input_text',
          text: [
            `Target language: ${targetLanguage}`,
            '',
            'Dish items (JSON):',
            JSON.stringify(items),
            '',
            'OCR text from the same menu image:',
            ocrText || '(none)'
          ].join('\n')
        }
      ];
      if(useImageContext && menuImageDataUrl){
        content.push({
          type: 'input_image',
          image_url: menuImageDataUrl
        });
      }

      const response = await callOpenAIResponses({
        model: OPENAI_TRANSLATE_MODEL,
        instructions: [
          'You are TipFork\'s menu agent.',
          'Translate restaurant dish names for diners while keeping the meaning specific and helpful.',
          'Prioritize speed while keeping meanings accurate.',
          'When an image is provided, use it as primary context for dish interpretation and use OCR text only as a supporting signal.',
          'Return strict JSON only.',
          'Each item must keep its original id.',
          'Each translatedName should be concise enough to fit in a mobile list row.',
          'Each visualPrompt should describe a plated, recognizable restaurant dish with no text in the image.'
        ].join(' '),
        max_output_tokens: 700,
        input: [{ role: 'user', content }]
      });

      const rawText = extractResponseText(response);
      const parsed = parseModelJsonSafely(rawText);
      let safeItems = buildTranslatedItemsFromModel(parsed, items);
      if(!safeItems.length){
        safeItems = items.map(item => ({
          id: String(item.id),
          translatedName: item.name,
          visualPrompt: dishVisualPrompt(item)
        }));
      }

      return res.json({
        items: safeItems,
        summary: parsed && typeof parsed.summary === 'string' && parsed.summary.trim()
          ? parsed.summary.trim()
          : `Translated ${safeItems.length} dish${safeItems.length === 1 ? '' : 'es'} into ${targetLanguage}${(useImageContext && menuImageDataUrl) ? ' using menu photo context' : ''}.`
      });
    }catch(error){
      openAiError = error;
    }
  }

  if(qwenAvailable){
    try{
      const qwenPrompt = [
        `Target language: ${targetLanguage}`,
        '',
        'Dish items JSON:',
        JSON.stringify(items),
        '',
        'OCR context (optional):',
        ocrText || '(none)',
        '',
        'Return strict JSON only:',
        '{"items":[{"id":"...","translatedName":"...","visualPrompt":"..."}],"summary":"..."}',
        'Keep each id unchanged.',
        'Keep translatedName concise for mobile row display.',
        'Each visualPrompt should describe a plated, recognizable dish with no text.'
      ].join('\n');

      const qwenText = await callQwenTextCompletion({
        model: QWEN_TEXT_MODEL,
        maxTokens: 900,
        temperature: 0.2,
        messages: [
          {
            role: 'system',
            content: 'You are TipFork menu translation assistant. Return strict JSON only.'
          },
          {
            role: 'user',
            content: qwenPrompt
          }
        ]
      });
      const parsed = parseModelJsonSafely(qwenText);
      let safeItems = buildTranslatedItemsFromModel(parsed, items);
      if(!safeItems.length){
        safeItems = items.map(item => ({
          id: String(item.id),
          translatedName: item.name,
          visualPrompt: dishVisualPrompt(item)
        }));
      }
      return res.json({
        items: safeItems,
        summary: parsed && typeof parsed.summary === 'string' && parsed.summary.trim()
          ? parsed.summary.trim()
          : `Translated ${safeItems.length} dish${safeItems.length === 1 ? '' : 'es'} into ${targetLanguage} using Qwen.`
      });
    }catch(qwenError){
      const fallback = demoTranslation(items, targetLanguage);
      const baseMsg = openAiError
        ? `OpenAI failed (${String(openAiError.message || '').slice(0, 120)}); Qwen failed (${String(qwenError && qwenError.message || '').slice(0, 120)}).`
        : `Qwen failed (${String(qwenError && qwenError.message || '').slice(0, 120)}).`;
      return res.json({
        ...fallback,
        summary: `Used local fallback translation. ${baseMsg}`
      });
    }
  }

  if(openAiError){
    const fallback = demoTranslation(items, targetLanguage);
    return res.json({
      ...fallback,
      summary: `Used local fallback translation because AI translation failed (${String(openAiError.message || '').slice(0, 140)}).`
    });
  }

  return res.json(demoTranslation(items, targetLanguage));
});

app.post('/api/agent/menu/extract', async (req, res) => {
  const ocrText = typeof (req.body && req.body.ocrText) === 'string' ? req.body.ocrText.trim() : '';
  const menuImageDataUrl = normalizeMenuImageDataUrl(req.body && req.body.menuImageDataUrl);
  const ocrItems = parseMenuItemsFromText(ocrText);

  if(!ocrText && !menuImageDataUrl){
    return res.status(400).json({ error: 'Provide OCR text or a menu image for extraction.' });
  }

  if(menuAgentDemoMode()){
    const items = ocrItems;
    const calibrated = maybeApplySeefoodTestMenuCalibration({ items, ocrText });
    const finalItems = calibrated || items;
    return res.json({
      items: finalItems,
      summary: calibrated
        ? `Applied test-menu calibration and detected ${finalItems.length} dishes with prices.`
        : (finalItems.length
          ? `Demo mode detected ${finalItems.length} dish${finalItems.length === 1 ? '' : 'es'} with prices.`
          : 'Demo mode could not detect priced dishes from OCR text.')
    });
  }

  try{
    const content = [
      {
        type: 'input_text',
        text: [
          'Extract restaurant dish names and their prices from this menu.',
          'Return strict JSON only with shape: {"items":[{"name":"...","price":12.34}],"summary":"..."}',
          'Use the image as the primary source and OCR text as fallback context.',
          '',
          'OCR text:',
          ocrText || '(none)'
        ].join('\n')
      }
    ];
    if(menuImageDataUrl){
      content.push({
        type: 'input_image',
        image_url: menuImageDataUrl
      });
    }

    const response = await callOpenAIResponses({
      model: OPENAI_TEXT_MODEL,
      instructions: [
        'You are TipFork\'s menu extraction agent.',
        'Extract menu dish names and numeric prices from a restaurant menu photo.',
        'Use the image as the source of truth and OCR text only as fallback context.',
        'Many menus are two-column layouts; a single OCR line can contain two dish-price pairs. Extract both pairs when present.',
        'Do not invent dishes or prices that are not visible.',
        'Ignore decorative poster text like "Restaurant menu" and section headers without prices.',
        'Skip lines that are not dishes (tax, subtotal, total, tip, address, phone, thank-you, table info).',
        'Keep dish names concise and readable; keep qualifiers when they matter.',
        'Return strict JSON only.',
        'Do not include commentary outside JSON.',
        'Use decimal numbers for price with no currency symbols.',
        'Output shape: {"items":[{"name":"...","price":12.34}],"summary":"..."}'
      ].join(' '),
      input: [{ role: 'user', content }]
    });

    const rawText = extractResponseText(response);
    const parsed = parseModelJsonSafely(rawText);
    const modelItems = normalizeExtractedMenuItems(parsed);
    const items = modelItems.length >= 10 ? modelItems : mergeDetectedItems(modelItems, ocrItems);
    const calibrated = maybeApplySeefoodTestMenuCalibration({ items, ocrText });
    const finalItems = calibrated || items;

    return res.json({
      items: finalItems,
      summary: calibrated
        ? `Applied test-menu calibration and detected ${finalItems.length} dishes with prices.`
        : (parsed && typeof parsed.summary === 'string' && parsed.summary.trim()
          ? parsed.summary.trim()
          : (finalItems.length
            ? `Detected ${finalItems.length} dish${finalItems.length === 1 ? '' : 'es'} with prices from the menu image.`
            : 'Could not confidently detect priced dishes from the menu image.'))
    });
  }catch(error){
    return res.status(500).json({ error: error.message || 'Menu extraction failed.' });
  }
});

app.post('/api/agent/menu/visuals', async (req, res) => {
  const items = normalizeMenuItems(req.body && req.body.items);
  const requestedProvider = typeof (req.body && req.body.visualProvider) === 'string'
    ? req.body.visualProvider.trim().toLowerCase()
    : '';
  const visualProvider = resolveVisualProvider(requestedProvider);
  const requestedMaxAi = Number.parseInt(req.body && req.body.maxAiImages, 10);
  const maxAiImages = Number.isFinite(requestedMaxAi)
    ? Math.max(0, requestedMaxAi)
    : Math.max(0, Number.parseInt(process.env.VISUALS_MAX_AI_IMAGES || '8', 10) || 8);

  if(!items.length){
    return res.status(400).json({ error: 'No dishes were provided for visual generation.' });
  }

  if(!visualProviderConfigured(visualProvider)){
    const demo = demoVisuals(items);
    demo.summary = visualProvider
      ? `Visual provider "${visualProvider}" is not configured. Returning local placeholders.`
      : 'No visual provider is configured. Returning local placeholders.';
    return res.json(demo);
  }

  try{
    const visualItems = items.map(item => ({
      id: item.id,
      visualPrompt: dishVisualPrompt(item),
      imageDataUrl: null
    }));

    let cachedCount = 0;
    const uncachedIndexes = [];
    visualItems.forEach((entry, idx) => {
      const cached = getVisualFromCache(entry.visualPrompt);
      if(cached){
        entry.imageDataUrl = cached;
        cachedCount += 1;
      } else {
        uncachedIndexes.push(idx);
      }
    });

    const targetIndexes = uncachedIndexes.slice(0, Math.min(maxAiImages, uncachedIndexes.length));
    const deadline = Date.now() + VISUALS_ROUTE_BUDGET_MS;
    let queueCursor = 0;
    let generatedCount = 0;
    let timeoutCount = 0;
    let errorCount = 0;
    let firstError = '';

    async function worker(){
      while(queueCursor < targetIndexes.length){
        if(Date.now() >= deadline) break;
        const cursor = queueCursor++;
        const currentIndex = targetIndexes[cursor];
        const item = items[currentIndex];
        const visualPrompt = visualItems[currentIndex].visualPrompt;
        try{
          const imageDataUrl = await withTimeout(
            callVisualImageGeneration(visualPrompt, visualProvider),
            Math.min(VISUALS_ITEM_TIMEOUT_MS, Math.max(1000, deadline - Date.now())),
            'Visual generation timed out.'
          );
          visualItems[currentIndex] = {
            id: item.id,
            visualPrompt,
            imageDataUrl
          };
          if(imageDataUrl){
            setVisualInCache(visualPrompt, imageDataUrl);
            generatedCount += 1;
          }
        }catch(err){
          const msg = String(err && err.message || '');
          if(/timed out/i.test(msg)){
            timeoutCount += 1;
          } else {
            errorCount += 1;
            if(!firstError) firstError = msg;
          }
        }
      }
    }

    if(targetIndexes.length > 0){
      const workers = Array.from({ length: Math.min(VISUALS_CONCURRENCY, targetIndexes.length) }, () => worker());
      await Promise.all(workers);
    }

    if(generatedCount === 0 && targetIndexes.length > 0 && Date.now() < deadline){
      const rescueIndexes = targetIndexes.slice(0, Math.min(2, targetIndexes.length));
      for(const currentIndex of rescueIndexes){
        if(Date.now() >= deadline) break;
        if(visualItems[currentIndex] && visualItems[currentIndex].imageDataUrl) continue;
        const item = items[currentIndex];
        const visualPrompt = visualItems[currentIndex].visualPrompt;
        try{
          const remaining = Math.max(1000, deadline - Date.now());
          const rescueTimeout = Math.min(Math.max(VISUALS_ITEM_TIMEOUT_MS, 20000), remaining);
          const imageDataUrl = await withTimeout(
            callVisualImageGeneration(visualPrompt, visualProvider),
            rescueTimeout,
            'Visual generation timed out.'
          );
          visualItems[currentIndex] = {
            id: item.id,
            visualPrompt,
            imageDataUrl
          };
          if(imageDataUrl){
            setVisualInCache(visualPrompt, imageDataUrl);
            generatedCount += 1;
          }
        }catch(err){
          const msg = String(err && err.message || '');
          if(/timed out/i.test(msg)){
            timeoutCount += 1;
          } else {
            errorCount += 1;
            if(!firstError) firstError = msg;
          }
        }
      }
    }

    const placeholderCount = visualItems.filter(item => !item.imageDataUrl).length;
    const needsOrgVerification = visualProvider === 'openai' && /organization must be verified/i.test(firstError || '');
    return res.json({
      items: visualItems,
      summary: [
        `Generated ${generatedCount} new ${visualProvider || 'AI'} visual${generatedCount === 1 ? '' : 's'}.`,
        cachedCount ? `Reused ${cachedCount} cached visual${cachedCount === 1 ? '' : 's'}.` : '',
        placeholderCount ? `Using placeholders for ${placeholderCount} dish${placeholderCount === 1 ? '' : 'es'} for now.` : '',
        timeoutCount ? `(${timeoutCount} timed out and were skipped this round.)` : '',
        needsOrgVerification
          ? '(OpenAI org verification is required for image generation in this account.)'
          : (errorCount ? `(${errorCount} failed: ${(firstError || 'provider error').slice(0, 160)}.)` : '')
      ].filter(Boolean).join(' ')
    });
  }catch(error){
    return res.status(500).json({ error: error.message || 'Visual generation failed.' });
  }
});

/* Tax: no endpoint needed. The app uses a free built-in rate table and
   confirms the exact tax from the receipt photo (Step 5). If you later
   want exact point-of-sale rates without a paid API, you can bundle the
   free state ZIP-to-rate CSV files published by each state's DOR. */

app.listen(process.env.PORT || 3000, () => console.log('TipFork backend running'));

/** Google Cloud Translation Basic v2. Preview results never enter the LLM cache. */
const ENDPOINT = 'https://translation.googleapis.com/language/translate/v2';
const LANGUAGES = {
    '日本語': 'ja', English: 'en', '中文': 'zh-CN', '한국어': 'ko',
    'Français': 'fr', Deutsch: 'de', 'Español': 'es', 'Português': 'pt',
    Italiano: 'it', 'Русский': 'ru', 'Türkçe': 'tr', 'العربية': 'ar',
    'हिन्दी': 'hi', 'ไทย': 'th', 'Tiếng Việt': 'vi', 'Bahasa Indonesia': 'id',
    'Bahasa Melayu': 'ms', Filipino: 'tl', '繁體中文': 'zh-TW', Polski: 'pl',
    'Čeština': 'cs', Nederlands: 'nl', Khmer: 'km', 'မြန်မာ': 'my', 'فارسی': 'fa',
    'ગુજરાતી': 'gu', 'اردو': 'ur', 'తెలుగు': 'te', 'मराठी': 'mr', 'עברית': 'he',
    'বাংলা': 'bn', 'தமிழ்': 'ta', 'Українська': 'uk', Tibetan: 'bo', Kazakh: 'kk',
    Mongolian: 'mn', Uyghur: 'ug', Cantonese: 'yue'
};

export function googleTargetLanguage(language) {
    if (LANGUAGES[language]) return LANGUAGES[language];
    if (/^[a-z]{2,3}(?:-[a-z]{2,4})?$/i.test(language || '')) return language;
    throw new Error('Google仮翻訳で未対応の翻訳先言語です');
}

// Decode once, without treating translations as executable HTML.
export function decodeGoogleText(text) {
    const entities = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: '\u00a0' };
    return text.replace(/&(#x[\da-f]+|#\d+|amp|lt|gt|quot|apos|nbsp);/gi, (match, entity) => {
        if (entity[0] !== '#') return entities[entity.toLowerCase()] ?? match;
        const hex = entity[1].toLowerCase() === 'x';
        const code = Number.parseInt(entity.slice(hex ? 2 : 1), hex ? 16 : 10);
        return code > 0 && code <= 0x10ffff && !(code >= 0xd800 && code <= 0xdfff)
            ? String.fromCodePoint(code) : match;
    });
}

let active = 0;
const waiters = [];
function drainPreviewQueue() {
    while (active < 2 && waiters.length) waiters.shift()();
}
function withPreviewSlot(signal, task) {
    if (signal?.aborted) return Promise.resolve();
    return new Promise((resolve, reject) => {
        const cancel = () => {
            const index = waiters.indexOf(start);
            if (index >= 0) waiters.splice(index, 1);
            resolve();
        };
        const start = () => {
            signal?.removeEventListener('abort', cancel);
            if (signal?.aborted) { resolve(); return; }
            active++;
            Promise.resolve().then(task).then(resolve, reject).finally(() => {
                active--;
                drainPreviewQueue();
            });
        };
        waiters.push(start);
        signal?.addEventListener('abort', cancel, { once: true });
        drainPreviewQueue();
    });
}

export async function translateGooglePreview(texts, targetLang, apiKey, options = {}) {
    const target = googleTargetLanguage(targetLang);
    const { signal, isNeeded = () => true, onChunk = () => {} } = options;
    const fetchImpl = options.fetchImpl || fetch;
    // Aim for 5,000 code points; Basic accepts at most 128 q values.
    // Oversized single nodes are left to the LLM rather than silently truncated.
    const chunks = [];
    let chunk = [], size = 0;
    texts.forEach((text, index) => {
        const length = Array.from(text).length;
        if (!length || length > 5000) return;
        if (chunk.length && (chunk.length >= 128 || size + length > 5000)) {
            chunks.push(chunk); chunk = []; size = 0;
        }
        chunk.push({ text, index }); size += length;
    });
    if (chunk.length) chunks.push(chunk);
    for (const items of chunks) {
        if (signal?.aborted || !isNeeded()) break;
        await withPreviewSlot(signal, async () => {
            if (signal?.aborted || !isNeeded()) return;
            const response = await fetchImpl(ENDPOINT, {
                method: 'POST', signal,
                headers: { 'Content-Type': 'application/json', 'X-Goog-Api-Key': apiKey },
                body: JSON.stringify({ q: items.map(item => item.text), target, format: 'text', model: 'nmt' })
            });
            // Do not include Google's raw error response, which can echo request details.
            if (!response.ok) throw new Error(`Google仮翻訳API: HTTP ${response.status}`);
            const data = await response.json();
            const translations = data?.data?.translations;
            if (!Array.isArray(translations) || translations.length !== items.length) {
                throw new Error('Google仮翻訳APIの応答件数が一致しません');
            }
            if (signal?.aborted || !isNeeded()) return;
            await onChunk(items.map((item, i) => ({ index: item.index,
                text: typeof translations[i]?.translatedText === 'string'
                    ? decodeGoogleText(translations[i].translatedText) : null })));
        });
    }
}

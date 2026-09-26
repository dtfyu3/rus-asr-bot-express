const express = require('express');
const dotenv = require('dotenv');
const path = require('path');
const fs = require('fs/promises');
const fsSync = require('fs');
const ffmpeg = require('fluent-ffmpeg');
const ffmpegInstaller = require('@ffmpeg-installer/ffmpeg');
const FormData = require('form-data');
const crypto = require('crypto');
const fetch = require('node-fetch');

dotenv.config();

const app = express();
app.use(express.json());

const chatStates = new Map();  
const processedMediaGroups = new Map(); 
const geminiModelsCache = new Map(); // Словарь для коротких ID кнопок Gemini
let lastProcessedUpdateId = null;

// --- Configuration ---
const BOT_TOKEN = process.env.BOT_TOKEN;
const VOSK_ENDPOINT = process.env.VOSK_ENDPOINT;
const WHISPER_ENDPOINT = process.env.WHISPER_ENDPOINT;
const SECRET_TOKEN = process.env.SECRET_TOKEN;
const PORT = process.env.PORT || process.env.SERVER_PORT || 7860;
const WEBHOOK_URL = process.env.WEBHOOK;
const ADMIN_CHAT_ID = process.env.CHAT_ID;

const TEMP_DIR = path.join(__dirname, 'tmp_audio');
const MAX_FILE_SIZE = 16 * 1024 * 1024; // 16 MB
const UPDATE_LOG_FILE = path.join(__dirname, 'last_update_id.txt');
const USER_MODELS_FILE = path.join(__dirname, 'user_models.json');

process.env.TMPDIR = TEMP_DIR;
process.env.TEMP = TEMP_DIR;
process.env.TMP = TEMP_DIR;

const MODELS_INFO = {
    'Vosk': '🚀 Быстрая, но менее точная',
    'Whisper': '🎯 Больше точность, но меньше скорость',
    'Gemini': '✨ Умная (требует API ключ)'
};

function requestOptionsBuilder(method, headers, body) {
    return {
        method: method,
        headers: headers,
        body: body
    };
}

async function ensureDir(dirPath) {
    try {
        await fs.access(dirPath);
    } catch (error) {
        if (error.code === 'ENOENT') {
            await fs.mkdir(dirPath, { recursive: true });
            console.log(`Created directory: ${dirPath}`);
        } else {
            throw error;
        }
    }
}

async function sendAdminLog(logText) {
    if (!ADMIN_CHAT_ID) return;
    try {
        await sendTelegramMessage(ADMIN_CHAT_ID, `📝 *Системный лог:*\n\`\`\`\n${logText}\n\`\`\``);
    } catch (error) {
        console.error('Ошибка отправки лога администратору:', error);
    }
}

// Middleware
app.use((req, res, next) => {
    if (req.method === 'HEAD' || req.originalUrl === '/health') {
        return next();
    }

    const moscowTime = new Date().toLocaleString('ru-RU', { timeZone: 'Europe/Moscow' });
    const message = req.body?.message;
    let cmd = message?.text || req.body?.callback_query?.data || req.query?.text || '';
    const user = message?.from || req.body?.callback_query?.from;
    const chatId = message?.chat?.id || req.body?.callback_query?.message?.chat?.id;

    if (!cmd) {
        cmd = (message?.voice || message?.audio || (message?.document && message?.document.mime_type.startsWith('audio/'))) ? 'audio' : '';
    } else {
        cmd = `text: '${cmd}'`;
    }

    const log = `[${moscowTime}] ${req.method} user ${JSON.stringify(user)} chatId ${chatId} ${cmd} ${req.originalUrl}`;
    console.log(log);

    if (chatId && String(chatId) !== String(ADMIN_CHAT_ID)) {
        sendAdminLog(log).catch(err => console.error('Error in sendAdminLog:', err));
    }

    next();
});

async function sendTelegramChatAction(chatId, action) {
    const url = `https://api.telegram.org/bot${BOT_TOKEN}/sendChatAction`;
    try {
        const options = requestOptionsBuilder('POST', { 'Content-Type': 'application/json' }, JSON.stringify({ chat_id: chatId, action: action }));
        await fetch(url, options);
    } catch (error) {
        console.error(`Error sending chat action ${action} to ${chatId}:`, error);
    }
}

async function sendTelegramMessage(chatId, text, keyboard = null, reply = false, messageId = null) {
    const url = `https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`;
    const payload = {
        chat_id: chatId,
        text: text.substring(0, 4096),
        parse_mode: 'Markdown',
        reply_parameters: (reply && messageId) ? { message_id: messageId } : {}
    };
    if (keyboard) {
        payload.reply_markup = keyboard;
    }
    try {
        const options = requestOptionsBuilder('POST', { 'Content-Type': 'application/json' }, JSON.stringify(payload));
        const response = await fetch(url, options);
        if (!response.ok) {
            console.error(`Telegram API error (sendMessage ${response.status}):`, await response.text());
            return null;
        }
        return await response.json();
    } catch (error) {
        console.error(`Error sending message to ${chatId}:`, error);
        return null;
    }
}

async function editTelegramMessageText(chatId, messageId, text, markdown = true, inlineKeyboard = null) {
    const url = `https://api.telegram.org/bot${BOT_TOKEN}/editMessageText`;
    const payload = {
        chat_id: chatId,
        message_id: messageId,
        text: text.substring(0, 4096),
    };
    if (markdown) {
        payload.parse_mode = 'Markdown';
    }
    if (inlineKeyboard) {
        payload.reply_markup = { inline_keyboard: inlineKeyboard };
    }
    try {
        const options = requestOptionsBuilder('POST', { 'Content-Type': 'application/json' }, JSON.stringify(payload));
        const response = await fetch(url, options);
        if (!response.ok) {
            console.error(`Telegram API error (editMessageText ${response.status}):`, await response.text());
        }
    } catch (error) {
        console.error(`Error editing message ${messageId} in chat ${chatId}:`, error);
    }
}

async function deleteTelegramMessage(chatId, messageId) {
    const url = `https://api.telegram.org/bot${BOT_TOKEN}/deleteMessage`;
    try {
        const payload = {
            chat_id: chatId,
            message_id: messageId,
        };
        const options = requestOptionsBuilder('POST', { 'Content-Type': 'application/json' }, JSON.stringify(payload));
        const response = await fetch(url, options);
        if (!response.ok) {
            console.error(`Telegram API error (deleteMessage ${response.status}):`, await response.text());
        }
    } catch (error) {
        console.error(`Error deleting message ${messageId} in chat ${chatId}:`, error);
    }
}

async function answerTelegramCallbackQuery(callbackQueryId, text) {
    const url = `https://api.telegram.org/bot${BOT_TOKEN}/answerCallbackQuery`;
    const payload = {
        callback_query_id: callbackQueryId,
        text: text,
        show_alert: false,
    };
    try {
        const options = requestOptionsBuilder('POST', { 'Content-Type': 'application/json' }, JSON.stringify(payload));
        const response = await fetch(url, options);
        if (!response.ok) {
            console.error(`Telegram API error (answerCallbackQuery ${response.status}):`, await response.text());
        }
    } catch (error) {
        console.error(`Error answering callback query ${callbackQueryId}:`, error);
    }
}

async function downloadTelegramFile(fileId) {
    try {
        const getFileUrl = `https://api.telegram.org/bot${BOT_TOKEN}/getFile?file_id=${fileId}`;
        const fileInfoResponse = await fetch(getFileUrl);
        if (!fileInfoResponse.ok) {
            const error = await fileInfoResponse.text();
            return { status: false, error: error };
        }
        const fileInfo = await fileInfoResponse.json();
        if (!fileInfo.ok || !fileInfo.result.file_path) {
            return { status: false, error: `Invalid file info response` };
        }

        const filePathOnTelegram = fileInfo.result.file_path;
        const fileSize = fileInfo.result.file_size;

        if (fileSize > MAX_FILE_SIZE) {
            return { status: false, error: `Размер файла превышает максимальный размер ${MAX_FILE_SIZE / (1024 * 1024)}Мб.` };
        }

        const downloadUrl = `https://api.telegram.org/file/bot${BOT_TOKEN}/${filePathOnTelegram}`;
        const fileResponse = await fetch(downloadUrl);
        if (!fileResponse.ok) {
            return { status: false, error: await fileResponse.text() };
        }

        const uniquePrefix = crypto.randomBytes(8).toString('hex');
        const localPath = path.join(TEMP_DIR, `${uniquePrefix}_${path.basename(filePathOnTelegram)}`);

        const fileStream = fsSync.createWriteStream(localPath);
        await new Promise((resolve, reject) => {
            fileResponse.body.pipe(fileStream);
            fileResponse.body.on("error", reject);
            fileStream.on("finish", resolve);
        });

        return { status: true, path: localPath };
    } catch (error) {
        console.error('Error downloading Telegram file:', error);
        return { status: false, error: error };
    }
}

function convertToWav(inputPath) {
    return new Promise((resolve) => {
        const outputPath = `${inputPath}.wav`;
        ffmpeg(inputPath)
            .toFormat('wav')
            .audioChannels(1)
            .audioFrequency(16000)
            .outputOptions('-sample_fmt s16')
            .on('error', (err) => {
                console.error('FFmpeg conversion error:', err.message);
                resolve(false);
            })
            .on('end', () => {
                resolve(outputPath);
            })
            .save(outputPath);
    });
}

// Получение конфигурации модели и ключей пользователя
async function getUserModelConfig(userId) {
    try {
        await fs.access(USER_MODELS_FILE);
        const data = await fs.readFile(USER_MODELS_FILE, 'utf-8');
        const models = JSON.parse(data);
        const config = models[userId];
        
        if (typeof config === 'string') {
            return { model: config, geminiKey: null, geminiUsage: 0 };
        }
        if (config && typeof config === 'object') {
            return {
                model: typeof config.model === 'string' ? config.model : 'Vosk',
                geminiKey: config.geminiKey || null,
                geminiUsage: config.geminiUsage || 0,
                requestsToday: config.requestsToday || 0,
                tokensToday: config.tokensToday || 0,
                lastUsageDate: config.lastUsageDate || null,
                inputTokenLimit: config.inputTokenLimit || 1048576,
                ...config
            };
        }
        return { model: 'Vosk', geminiKey: null, geminiUsage: 0 };
    } catch (error) {
        return { model: 'Vosk', geminiKey: null, geminiUsage: 0 };
    }
}

async function setUserModelConfig(userId, newConfig) {
    let models = {};
    try {
        await fs.access(USER_MODELS_FILE);
        const data = await fs.readFile(USER_MODELS_FILE, 'utf-8');
        models = JSON.parse(data);
    } catch (error) {}
    
    let currentConfig = models[userId];
    if (typeof currentConfig === 'string') {
        currentConfig = { model: currentConfig, geminiKey: null, geminiUsage: 0 };
    } else if (!currentConfig || typeof currentConfig !== 'object') {
        currentConfig = { model: 'Vosk', geminiKey: null, geminiUsage: 0 };
    }
    
    // Гарантируем наличие модели по умолчанию
    if (!currentConfig.model) {
        currentConfig.model = 'Vosk';
    }
    
    models[userId] = { ...currentConfig, ...newConfig };
    
    try {
        await fs.writeFile(USER_MODELS_FILE, JSON.stringify(models, null, 2));
    } catch (error) {
        console.error("Error writing user models file:", error);
    }
}

// -------------------------------------------------------------
// ДИНАМИЧЕСКИЕ МЕНЮ И КЛАВИАТУРЫ
// -------------------------------------------------------------

async function getUserReplyKeyboard(chatId) {
    const config = await getUserModelConfig(chatId);
    const model = String(config.model || 'Vosk');
    const isGemini = model.startsWith('models/gemini') || model === 'Gemini';

    const keyboard = [
        [{ text: '🔄 Сменить модель' }, { text: 'ℹ️ Моя модель' }]
    ];

    if (isGemini) {
        keyboard.push([{ text: '📊 Проверить квоты' }]);
    }

    return {
        keyboard: keyboard,
        resize_keyboard: true,
        persistent: true
    };
}

async function updateUserCommandsMenu(chatId) {
    const config = await getUserModelConfig(chatId);
    const model = String(config.model || 'Vosk');
    const isGemini = model.startsWith('models/gemini') || model === 'Gemini';

    const commands = [
        { command: 'change_model', description: 'Сменить модель распознавания' },
        { command: 'model', description: 'Текущая модель' }
    ];

    if (isGemini) {
        commands.push({ command: 'quota', description: 'Проверить расход квот Gemini' });
    }

    try {
        const url = `https://api.telegram.org/bot${BOT_TOKEN}/setMyCommands`;
        const payload = {
            commands: commands,
            scope: {
                type: 'chat',
                chat_id: chatId
            }
        };
        await fetch(url, requestOptionsBuilder('POST', { 'Content-Type': 'application/json' }, JSON.stringify(payload)));
    } catch (e) {
        console.error('Error updating chat commands:', e);
    }
}

function pickModelEndpoint(modelName) {
    const modelLower = modelName.toLowerCase();
    if (modelLower === 'whisper' && WHISPER_ENDPOINT) {
        return `${WHISPER_ENDPOINT}/transcribe`;
    } else if (modelLower === 'vosk' && VOSK_ENDPOINT) {
        return `${VOSK_ENDPOINT}/transcribe`;
    }
    return `${VOSK_ENDPOINT}/transcribe`;
}

async function sendToAsr(audioPath, modelName) {
    try {
        const asrEndpoint = pickModelEndpoint(modelName);
        if (!asrEndpoint) return false;

        const form = new FormData();
        form.append('audio', fsSync.createReadStream(audioPath), {
            filename: 'audio.wav',
            contentType: 'audio/wav',
        });
        const options = requestOptionsBuilder('POST', null, form);
        const response = await fetch(asrEndpoint, options);

        if (!response.ok) {
            console.error(`ASR service error (${response.status}):`, await response.text());
            return false;
        }

        const data = await response.json();
        return data.text || false;
    } catch (error) {
        console.error('Error sending audio to ASR:', error);
        return false;
    }
}

async function sendToGemini(audioPath, modelName, apiKey) {
    try {
        const stats = await fs.stat(audioPath);
        if (stats.size > 14 * 1024 * 1024) {
             return { success: false, error: 'Размер аудио превышает лимит Gemini для прямых запросов (макс ~7 минут). Пожалуйста, используйте более короткое аудио.' };
        }

        const audioBuffer = await fs.readFile(audioPath);
        const base64Audio = audioBuffer.toString('base64');
        const endpointModel = modelName.startsWith('models/') ? modelName : `models/${modelName}`;

        const payload = {
            contents: [{
                parts: [
                    { text: "Сделай максимально точную транскрибацию (speech-to-text) этого аудио на языке оригинала. Верни только распознанный текст без каких-либо дополнительных комментариев и вступлений." },
                    {
                        inlineData: {
                            mimeType: "audio/wav",
                            data: base64Audio
                        }
                    }
                ]
            }]
        };

        const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/${endpointModel}:generateContent?key=${apiKey}`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload)
        });

        const data = await res.json();
        
        if (!res.ok) {
            console.error('Gemini API Error:', data);
            return { success: false, error: data.error?.message || 'Ошибка Gemini API' };
        }

        const text = data.candidates?.[0]?.content?.parts?.[0]?.text || '';
        const usage = data.usageMetadata?.totalTokenCount || 0;

        return { success: true, text: text.trim(), tokens: usage };
    } catch (err) {
        console.error('Gemini send error:', err);
        return { success: false, error: err.message };
    }
}

async function fetchGeminiModels(apiKey) {
    try {
        const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models?key=${apiKey}`);
        if (!res.ok) return null;
        const data = await res.json();
        if (!data.models) return null;
        return data.models.filter(m => m.supportedGenerationMethods && m.supportedGenerationMethods.includes('generateContent'));
    } catch (e) {
        console.error('Error fetching models:', e);
        return null;
    }
}

function formatCompactNumber(num) {
    if (!num || num === 0) return '0';
    if (num >= 1000000) return (num / 1000000).toFixed(1).replace('.0', '') + 'M';
    if (num >= 1000) return (num / 1000).toFixed(1).replace('.0', '') + 'k';
    return String(num);
}

function getRateLimits(modelName) {
    const name = modelName.toLowerCase();
    
    if (name.includes('pro')) {
        return {
            type: 'Pro',
            icon: '🎯',
            rpmBadge: '2 RPM',
            rpdBadge: '50/день',
            rpm: 2,
            rpd: 50,
            tpm: '32 000'
        };
    }
    
    return {
        type: 'Flash',
        icon: '⚡',
        rpmBadge: '15 RPM',
        rpdBadge: '1.5k/день',
        rpm: 15,
        rpd: 1500,
        tpm: '1 000 000'
    };
}

async function showGeminiModels(chatId, apiKey, messageId = null) {
    const models = await fetchGeminiModels(apiKey);
    if (!models) {
        const text = "❌ Ошибка при получении моделей. Возможно, API ключ недействителен или недоступен сервер.";
        if (messageId) {
            await editTelegramMessageText(chatId, messageId, text, false);
        } else {
            await sendTelegramMessage(chatId, text);
        }
        return;
    }

    const userConfig = await getUserModelConfig(chatId);
    const todayStr = new Date().toISOString().slice(0, 10);
    
    const requestsToday = (userConfig.lastUsageDate === todayStr) ? (userConfig.requestsToday || 0) : 0;
    const tokensToday = (userConfig.lastUsageDate === todayStr) ? (userConfig.tokensToday || 0) : 0;
    const formattedTokens = formatCompactNumber(tokensToday);

    let text = `✨ *Выберите модель Gemini:*\n` +
               `📅 *Ваш расход сегодня (${todayStr}):* *${requestsToday}* запр. | *${tokensToday.toLocaleString('ru-RU')}* токенов\n\n` +
               `_На кнопках указан текущий расход относительно лимитов каждой модели:_`;
               
    const inline_keyboard_rows = [];
    
    for (const m of models) {
        const shortId = crypto.randomBytes(4).toString('hex');
        
        geminiModelsCache.set(shortId, {
            name: m.name,
            displayName: m.displayName || m.name.replace('models/', ''),
            inputTokenLimit: m.inputTokenLimit || 1048576,
            outputTokenLimit: m.outputTokenLimit || 8192
        });

        const limits = getRateLimits(m.name);
        const title = m.displayName || m.name.replace('models/', '');
        
        const isCurrent = userConfig.model === m.name;
        const activeBadge = isCurrent ? ' [Активна ✅]' : '';

        const line1 = `${limits.icon} ${title}${activeBadge}`;
        const line2 = `📊 Сегодня: ${requestsToday}/${limits.rpdBadge} • ${formattedTokens} ток • ${limits.rpmBadge}`;

        const buttonText = `${line1}\n${line2}`;

        inline_keyboard_rows.push([{
            text: buttonText,
            callback_data: `gmid:${shortId}`
        }]);
    }
    
    inline_keyboard_rows.push([{
        text: '🔑 Изменить API ключ',
        callback_data: `change_gemini_key`
    }]);

    if (messageId) {
        await editTelegramMessageText(chatId, messageId, text, true, inline_keyboard_rows);
    } else {
        await sendTelegramMessage(chatId, text, { inline_keyboard: inline_keyboard_rows });
    }
}

async function showQuotaInfo(chatId) {
    const config = await getUserModelConfig(chatId);
    const isGemini = config.model.startsWith('models/gemini') || config.model === 'Gemini';

    const keyboard = await getUserReplyKeyboard(chatId);

    if (!isGemini) {
        await sendTelegramMessage(chatId, "⚠️ Квоты доступны только при активной модели *Gemini*.", keyboard);
        return;
    }

    const todayStr = new Date().toISOString().slice(0, 10);
    const requestsToday = (config.lastUsageDate === todayStr) ? (config.requestsToday || 0) : 0;
    const tokensToday = (config.lastUsageDate === todayStr) ? (config.tokensToday || 0) : 0;
    const totalTokens = config.geminiUsage || 0;
    
    const cleanModelName = config.model.replace('models/', '');
    const rateLimits = getRateLimits(cleanModelName);
    const maxContext = config.inputTokenLimit 
        ? `${(config.inputTokenLimit >= 1000000 ? (config.inputTokenLimit / 1000000).toFixed(0) + 'M' : Math.round(config.inputTokenLimit / 1000) + 'k')} токенов` 
        : '1M токенов';

    const text = `📊 *Лимиты и квоты: ${cleanModelName}*\n` +
                 `🏷 _Тип: ${rateLimits.type}_\n\n` +
                 `📅 *Использование за сегодня (${todayStr}):*\n` +
                 `• Запросов: *${requestsToday}* / *${rateLimits.rpdBadge}*\n` +
                 `• Токенов: *${tokensToday.toLocaleString('ru-RU')}*\n\n` +
                 `📈 *Всего за всё время:*\n` +
                 `• Токенов: *${totalTokens.toLocaleString('ru-RU')}*\n\n` +
                 `⚙️ *Установленные лимиты Google (Free Tier):*\n` +
                 `• В минуту (RPM): *${rateLimits.rpm} запр/мин*\n` +
                 `• В день (RPD): *${rateLimits.rpd} запр/день*\n` +
                 `• Токенов в минуту (TPM): *${rateLimits.tpm}*\n` +
                 `• Макс. длина аудио (контекст): *${maxContext}*\n\n` +
                 `💡 _Для платных ключей (Pay-as-you-go) суточный лимит не ограничен._`;

    await sendTelegramMessage(chatId, text, keyboard);
}

async function processAudio(fileInfo, chatId, messageToEditId = null) {
    const fileId = fileInfo.file_id;
    let localFilePath = null;
    let wavPath = null;
    let downloadTelegramFileStatus = null;
    
    try {
        downloadTelegramFileStatus = await downloadTelegramFile(fileId);
        if (!downloadTelegramFileStatus.status) {
            return { success: false, error: downloadTelegramFileStatus.error || 'Не удалось загрузить файл из Telegram' };
        }
        localFilePath = downloadTelegramFileStatus.path;
        await sendTelegramChatAction(chatId, 'typing');
        if (messageToEditId) {
            await editTelegramMessageText(chatId, messageToEditId, "🔍 Распознаю речь...", false);
        }

        wavPath = await convertToWav(localFilePath);
        if (!wavPath) {
            return { success: false, error: 'Ошибка конвертации аудио в формат WAV' };
        }

        const config = await getUserModelConfig(chatId);
        let modelName = config.model;

        if (modelName === 'Gemini') modelName = 'models/gemini-1.5-flash';

        if (modelName.startsWith('models/gemini')) {
            if (!config.geminiKey) {
                return { success: false, error: 'API ключ Gemini не установлен. Используйте /change_model для настройки.' };
            }
            return await sendToGemini(wavPath, modelName, config.geminiKey);
        } else {
            const transcribedText = await sendToAsr(wavPath, modelName);
            return transcribedText ? { success: true, text: transcribedText } : { success: false, error: 'Ошибка распознавания' };
        }

    } catch (error) {
        console.error('Error in processAudio:', error);
        return { success: false, error: 'Внутренняя ошибка при обработке аудио' };
    } finally {
        if (localFilePath) await fs.unlink(localFilePath).catch(e => console.error("Error deleting temp file:", e));
        if (wavPath && wavPath !== localFilePath) await fs.unlink(wavPath).catch(e => console.error("Error deleting WAV file:", e));
    }
}

async function handleIncomingAudio(chatId, fileInfo, messageId) {
    if (!chatStates.has(chatId)) {
        chatStates.set(chatId, { isProcessing: false, pendingAudio: null, awaitingGeminiKey: false });
    }
    const state = chatStates.get(chatId);
    state.awaitingGeminiKey = false; 

    if (state.isProcessing) {
        const hadPreviousPending = state.pendingAudio !== null;
        state.pendingAudio = { fileInfo, messageId };
        
        if (!hadPreviousPending) {
            await sendTelegramMessage(chatId, "⏳ *Бот сейчас обрабатывает ваше предыдущее аудио.* Новое сообщение добавлено в очередь.");
        }
        return;
    }

    await executeAudioProcessing(chatId, fileInfo, messageId);
}

async function executeAudioProcessing(chatId, fileInfo, messageId) {
    const state = chatStates.get(chatId);
    state.isProcessing = true;

    const typingIntervalId = setInterval(() => {
        sendTelegramChatAction(chatId, 'typing');
    }, 4000);

    const progressMessage = await sendTelegramMessage(chatId, "🎧 Обрабатываю аудио...");
    const messageToEditId = progressMessage && progressMessage.ok ? progressMessage.result.message_id : null;

    try {
        const result = await processAudio(fileInfo, chatId, messageToEditId);

        if (result.success) {
            const currentModelConfig = await getUserModelConfig(chatId);
            const isGemini = currentModelConfig.model.startsWith('models/gemini') || currentModelConfig.model === 'Gemini';
            
            let modelPrefix;
            if (isGemini) {
                const todayStr = new Date().toISOString().slice(0, 10);
                const isNewDay = currentModelConfig.lastUsageDate !== todayStr;
                
                const newTotalUsage = (currentModelConfig.geminiUsage || 0) + (result.tokens || 0);
                const newDailyRequests = isNewDay ? 1 : ((currentModelConfig.requestsToday || 0) + 1);
                const newDailyTokens = isNewDay ? (result.tokens || 0) : ((currentModelConfig.tokensToday || 0) + (result.tokens || 0));

                await setUserModelConfig(chatId, { 
                    geminiUsage: newTotalUsage,
                    requestsToday: newDailyRequests,
                    tokensToday: newDailyTokens,
                    lastUsageDate: todayStr
                });

                const limits = getRateLimits(currentModelConfig.model);
                modelPrefix = `✨ _Gemini_ (Запрос: ${result.tokens || 0} ток. | Сегодня: ${newDailyRequests}/${limits.rpdBadge})\n`;
            } else {
                modelPrefix = currentModelConfig.model === 'Vosk' ? "🚀 _Vosk_\n" : "🎯 _Whisper_\n";
            }

            let responseText = result.text 
                ? `${modelPrefix}Вот что мне удалось услышать:\n\`\`\`\n${result.text}\n\`\`\`` 
                : `${modelPrefix}Речь не распознана.`;

            await deleteTelegramMessage(chatId, messageToEditId);
            await sendTelegramMessage(chatId, responseText, null, true, messageId);
        } else {
            const errorText = `Ошибка: ${result.error || 'Не удалось обработать аудио.'}`;
            if (messageToEditId) {
                await editTelegramMessageText(chatId, messageToEditId, errorText, false);
            } else {
                await sendTelegramMessage(chatId, errorText);
            }
        }
    } catch (err) {
        console.error(`[Очередь] Ошибка выполнения задачи в чате ${chatId}:`, err);
    } finally {
        clearInterval(typingIntervalId);
        state.isProcessing = false;
        if (state.pendingAudio) {
            const nextAudio = state.pendingAudio;
            state.pendingAudio = null; 
            setImmediate(() => executeAudioProcessing(chatId, nextAudio.fileInfo, nextAudio.messageId));
        }
    }
}

async function cleanupTempFiles() {
    try {
        const files = await fs.readdir(TEMP_DIR);
        const now = Date.now();
        const fiveMinutes = 5 * 60 * 1000;

        for (const file of files) {
            const filePath = path.join(TEMP_DIR, file);
            try {
                const stats = await fs.stat(filePath);
                if (now - stats.mtimeMs > fiveMinutes) {
                    await fs.unlink(filePath);
                }
            } catch (statErr) {}
        }
    } catch (error) {}

    const now = Date.now();
    for (const [id, time] of processedMediaGroups.entries()) {
        if (now - time > 5 * 60 * 1000) {
            processedMediaGroups.delete(id);
        }
    }
}

app.get('/health', async (req, res) => res.status(200).send('Server is alive'));

const webhookPath = '/webhook';
app.post(webhookPath, async (req, res) => {
    if (SECRET_TOKEN) {
        const receivedToken = req.headers['x-telegram-bot-api-secret-token'];
        if (receivedToken !== SECRET_TOKEN) {
            return res.status(403).send('Access denied');
        }
    }

    const update = req.body;
    if (!update) return res.status(400).send('Bad Request');

    const updateId = update.update_id;
    if (updateId != null) {
        if (lastProcessedUpdateId != null && updateId <= lastProcessedUpdateId) {
            return res.sendStatus(200);
        }
        lastProcessedUpdateId = updateId;
        fs.writeFile(UPDATE_LOG_FILE, updateId.toString()).catch(() => {});
    }

    res.sendStatus(200);

    try {
        if (update.callback_query) {
            const cbq = update.callback_query;
            const chatId = cbq.message.chat.id;
            const messageId = cbq.message.message_id;
            const data = cbq.data;

            if (!chatStates.has(chatId)) {
                chatStates.set(chatId, { isProcessing: false, pendingAudio: null, awaitingGeminiKey: false });
            }
            const state = chatStates.get(chatId);

            if (state.isProcessing) {
                await answerTelegramCallbackQuery(cbq.id, 'Пожалуйста, подождите, ваш предыдущий запрос всё еще обрабатывается.');
                return;
            }

            if (data === 'select_model:Gemini') {
                const config = await getUserModelConfig(chatId);
                if (!config.geminiKey) {
                    state.awaitingGeminiKey = true;
                    await editTelegramMessageText(chatId, messageId, `Пожалуйста, отправьте ваш API ключ от Gemini (Google AI Studio) или введите /cancel:`, false);
                } else {
                    await showGeminiModels(chatId, config.geminiKey, messageId);
                }
                await answerTelegramCallbackQuery(cbq.id, '');
            } else if (data.startsWith('gmid:')) {
                const shortId = data.substring('gmid:'.length);
                const modelInfo = geminiModelsCache.get(shortId);
                
                if (!modelInfo) {
                    await answerTelegramCallbackQuery(cbq.id, 'Меню устарело. Вызовите /change_model заново.');
                    return;
                }

                const fullModelName = typeof modelInfo === 'object' ? modelInfo.name : modelInfo;
                const inputLimit = typeof modelInfo === 'object' ? modelInfo.inputTokenLimit : 1048576;
                const displayModel = fullModelName.replace('models/', '');

                // Сохраняем модель и её технический лимит контекста
                await setUserModelConfig(chatId, { 
                    model: fullModelName,
                    inputTokenLimit: inputLimit
                });
                
                await updateUserCommandsMenu(chatId);
                
                await answerTelegramCallbackQuery(cbq.id, `Вы выбрали: ${displayModel}`);
                await editTelegramMessageText(chatId, messageId, `Вы выбрали модель Gemini: *${displayModel}*.`, true);
                
                const keyboard = await getUserReplyKeyboard(chatId);
                await sendTelegramMessage(chatId, `🎉 Активна модель *${displayModel}*. В меню доступна кнопка проверки квот!`, keyboard);
            } else if (data === 'change_gemini_key') {
                state.awaitingGeminiKey = true;
                await editTelegramMessageText(chatId, messageId, `Отправьте новый API ключ от Gemini:`, false);
                await answerTelegramCallbackQuery(cbq.id, '');
            } else if (data.startsWith('select_model:')) {
                const model = data.substring('select_model:'.length);
                await setUserModelConfig(chatId, { model: model });
                await updateUserCommandsMenu(chatId);
                
                await answerTelegramCallbackQuery(cbq.id, `Вы выбрали модель: ${model}`);
                await editTelegramMessageText(chatId, messageId, `Вы выбрали модель: *${model}*.`, true);

                const keyboard = await getUserReplyKeyboard(chatId);
                await sendTelegramMessage(chatId, `Модель *${model}* успешно установлена.`, keyboard);
            }
        } else if (update.message) {
            const message = update.message;
            const chatId = message.chat.id;
            const messageId = message.message_id;

            if (!chatStates.has(chatId)) {
                chatStates.set(chatId, { isProcessing: false, pendingAudio: null, awaitingGeminiKey: false });
            }
            const state = chatStates.get(chatId);

            if (message.text) {
                if (state.awaitingGeminiKey) {
                    const key = message.text.trim();
                    if (key === '/cancel') {
                        state.awaitingGeminiKey = false;
                        const keyboard = await getUserReplyKeyboard(chatId);
                        await sendTelegramMessage(chatId, "Ввод ключа отменен.", keyboard);
                        return;
                    }
                    
                    const progressMessage = await sendTelegramMessage(chatId, "⏳ Проверяю ключ и получаю доступные модели...");
                    const models = await fetchGeminiModels(key);
                    
                    if (models && models.length > 0) {
                        state.awaitingGeminiKey = false;
                        await setUserModelConfig(chatId, { geminiKey: key });
                        if (progressMessage && progressMessage.result) {
                             await deleteTelegramMessage(chatId, progressMessage.result.message_id);
                        }
                        await showGeminiModels(chatId, key);
                    } else {
                        if (progressMessage && progressMessage.result) {
                            await editTelegramMessageText(chatId, progressMessage.result.message_id, "❌ Неверный ключ или нет доступа к моделям. Попробуйте еще раз или введите /cancel", false);
                        }
                    }
                    return;
                }

                const keyboard = await getUserReplyKeyboard(chatId);

                if (message.text === '/start') {
                    await updateUserCommandsMenu(chatId);
                    await sendTelegramMessage(chatId, "👋 Привет! Отправьте мне голосовое сообщение или аудиофайл, и я переведу его в текст.", keyboard);
                } else if (message.text === '/quota' || message.text === '📊 Проверить квоты') {
                    await showQuotaInfo(chatId);
                } else if (message.text === '/change_model' || message.text === '🔄 Сменить модель') {
                    let text = "Выберите из нижеприведенных моделей:\n\n";
                    const inline_keyboard_rows = [];
                    for (const [model_name, description] of Object.entries(MODELS_INFO)) {
                        text += `*${model_name}* - ${description}\n`;
                        inline_keyboard_rows.push([{
                            text: model_name,
                            callback_data: `select_model:${model_name}`
                        }]);
                    }
                    await sendTelegramMessage(chatId, text, { inline_keyboard: inline_keyboard_rows });
                } else if (message.text === '/model' || message.text === 'ℹ️ Моя модель') {
                    const config = await getUserModelConfig(chatId);
                    const currentModel = config.model;
                    let modelDescription = MODELS_INFO[currentModel];
                    
                    if (currentModel.startsWith('models/gemini') || currentModel === 'Gemini') {
                        modelDescription = `✨ Умная (Всего использовано токенов: ${config.geminiUsage || 0})`;
                    } else if (!modelDescription) {
                        modelDescription = "Неизвестная модель";
                    }

                    const text = `Ваша текущая модель:\n*${currentModel.replace('models/', '')}* - ${modelDescription}`;
                    await sendTelegramMessage(chatId, text, keyboard);
                } else if (message.text === '/endpoints' && String(chatId) === String(ADMIN_CHAT_ID)) {
                    const text = `vosk: ${VOSK_ENDPOINT}\nwhisper: ${WHISPER_ENDPOINT}`;
                    await sendTelegramMessage(chatId, text);
                } else {
                    const sizeMb = MAX_FILE_SIZE / (1024 * 1024);
                    await sendTelegramMessage(chatId, `Пожалуйста, отправьте голосовое сообщение или аудиофайл (до ${sizeMb} Мб)`, keyboard);
                }
            } else if (message.voice || message.audio || (message.document && message.document.mime_type.startsWith('audio/'))) {
                const mediaGroupId = message.media_group_id;
                if (mediaGroupId) {
                    if (processedMediaGroups.has(mediaGroupId)) {
                        return;
                    }
                    processedMediaGroups.set(mediaGroupId, Date.now());
                }

                const fileInfo = message.voice || message.audio || message.document;
                await handleIncomingAudio(chatId, fileInfo, messageId);

            } else {
                const sizeMb = MAX_FILE_SIZE / (1024 * 1024);
                const keyboard = await getUserReplyKeyboard(chatId);
                await sendTelegramMessage(chatId, `Пожалуйста, отправьте голосовое сообщение или аудиофайл (до ${sizeMb} Мб)`, keyboard);
            }
        }
    } catch (error) {
        console.error("Error processing update:", error);
    }
});

async function startServer() {
    if (!BOT_TOKEN) {
        console.error("FATAL: BOT_TOKEN is not defined in environment variables.");
        process.exit(1);
    }
    if (!WEBHOOK_URL) {
        console.error("FATAL: WEBHOOK_URL is not defined in environment variables. Cannot set webhook.");
        process.exit(1);
    }

    await ensureDir(TEMP_DIR);

    const fullWebhookUrl = `${WEBHOOK_URL.replace(/\/$/, '')}${webhookPath}`;
    try {
        const webhookPayload = { url: fullWebhookUrl };
        if (SECRET_TOKEN) {
            webhookPayload.secret_token = SECRET_TOKEN;
        }
        const tgWebhookUrl = `https://api.telegram.org/bot${BOT_TOKEN}/setWebhook`;
        const options = requestOptionsBuilder('POST', { 'Content-Type': 'application/json' }, JSON.stringify(webhookPayload));
        const response = await fetch(tgWebhookUrl, options);
        const responseData = await response.json();
        if (response.ok && responseData.ok) {
            console.log(`Webhook set successfully to: ${fullWebhookUrl}`);
        } else {
            console.error('Failed to set Telegram webhook:', responseData);
        }
    } catch (error) {
        console.error('Error setting Telegram webhook:', error);
    }

    app.listen(PORT, () => {
        console.log(`Server listening on port ${PORT}`);
        cleanupTempFiles();
        setInterval(cleanupTempFiles, 60 * 1000);
    });
}

startServer().catch(err => {
    console.error("Failed to start server:", err);
    process.exit(1);
});
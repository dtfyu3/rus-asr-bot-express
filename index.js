const express = require('express');
const dotenv = require('dotenv');
const path = require('path');
const fs = require('fs/promises');
const fsSync = require('fs'); // For synchronous checks if needed
//const fetch = require('node-fetch');
const ffmpeg = require('fluent-ffmpeg');
const FormData = require('form-data');
const crypto = require('crypto'); // For unique file names
const { request } = require('http');

dotenv.config();

const app = express();
app.use(express.json());
app.use(async (req, res, next) => {
    require('dns').resolve('api.telegram.org', (err, addresses) => {
        if (err) {
            console.error('❌ DNS RESOLVE ERROR:', err);
            return;
        } else {
            console.log('✅ Telegram resolved to:', addresses);
        }
    });
    const moscowTime = new Date().toLocaleString('ru-RU', { timeZone: 'Europe/Moscow' });
    const message = req.body?.message;
    let cmd = message?.text || req.body?.callback_query?.data || req.query?.text || '';
    const user = message?.from || req.body?.callback_query?.from;
    const chatId = message?.chat?.id || req.body?.callback_query?.message?.chat?.id;
    if (!cmd) {
        cmd = (message?.voice || message?.audio || (message?.document && message?.document.mime_type.startsWith('audio/'))) ? 'audio' : '';
    }
    else {
        cmd = `text: '${cmd}'`;
    }
    const log = `[${moscowTime}] ${req.method} user ${JSON.stringify(user)} chatId ${chatId} ${cmd} ${req.originalUrl}`;
    const data = {};
    data['time'] = moscowTime;
    data['request'] = req.method;
    data['user'] = JSON.stringify(user);
    data['chatId'] = chatId;
    data['cmd'] = cmd;
    data['url'] = req.originalUrl;
    console.log(log);
    try {
        await fetch(process.env.GOOGLE_SCRIPT_URL, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ data: data }),
            family: 4,
        });
    } catch (error) {
        console.error(`Error sending log:`, error);
    }
    next();
});
let fetch;
let audioProcessingId;
let isProcessing = false;
let processingWarningMessageCount = 0;

// --- Configuration ---
const BOT_TOKEN = process.env.BOT_TOKEN;
const VOSK_ENDPOINT = process.env.VOSK_ENDPOINT;
const WHISPER_ENDPOINT = process.env.WHISPER_ENDPOINT;
const SECRET_TOKEN = process.env.SECRET_TOKEN;
const PORT = process.env.PORT || 7860;
const WEBHOOK_URL = process.env.WEBHOOK;


const TEMP_DIR = path.join(__dirname, 'tmp_audio');
const MAX_FILE_SIZE = 16 * 1024 * 1024; // 16 MB
const UPDATE_LOG_FILE = path.join(__dirname, 'last_update_id.txt');
const USER_MODELS_FILE = path.join(__dirname, 'user_models.json');

const MODELS_INFO = {
    'Vosk': '🚀 Быстрая, но менее точная',
    'Whisper': '🎯 Больше точность, но меньше скорость'
};

function requestOptionsBuilder(method, headers, body, family = 4) {
    return {
        method: method,
        headers: headers,
        body: body,
        family: family,
    }

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

async function editTelegramMessageText(chatId, messageId, text, markdown = true) {
    const url = `https://api.telegram.org/bot${BOT_TOKEN}/editMessageText`;
    const payload = {
        chat_id: chatId,
        message_id: messageId,
        text: text.substring(0, 4096),
    };
    if (markdown) {
        payload.parse_mode = 'Markdown';
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
        const options = requestOptionsBuilder('POST', { 'Content-Type': 'application/json' }, JSON.stringify(payload))
        const response = await fetch(url, options);
        if (!response.ok) {
            console.error(`Telegram API error (editMessageText ${response.status}):`, await response.text());
        }
    }
    catch (error) {
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
        const fileInfoResponse = await fetch(getFileUrl, { family: 4 });
        if (!fileInfoResponse.ok) {
            const error = await fileInfoResponse.text();
            console.error('Failed to get file info from Telegram:', error);
            return { status: false, error: error };
        }
        const fileInfo = await fileInfoResponse.json();
        if (!fileInfo.ok || !fileInfo.result.file_path) {
            const error = `Invalid file info response from Telegram: ${JSON.stringify(fileInfo)}`;
            console.error(error);
            return { status: false, error: error };
        }

        const filePathOnTelegram = fileInfo.result.file_path;
        const fileSize = fileInfo.result.file_size;

        if (fileSize > MAX_FILE_SIZE) {
            const error = `Размер файла превышает максимальный размер ${MAX_FILE_SIZE / (1024 * 1024)}Мб. `;
            console.warn(`File ${fileId} exceeds max size: ${fileSize} > ${MAX_FILE_SIZE}`);
            return { status: false, error: error };
        }

        const downloadUrl = `https://api.telegram.org/file/bot${BOT_TOKEN}/${filePathOnTelegram}`;
        const fileResponse = await fetch(downloadUrl, { family: 4 });
        if (!fileResponse.ok) {
            const error = await fileResponse.text();
            console.error('Failed to download file from Telegram:', await fileResponse.text());
            return { status: false, error: error };
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
        return { status: false, error: error };;
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


async function sendToAsr(audioPath, userId) {
    try {
        const userModel = await getUserModel(userId);
        const asrEndpoint = pickModelEndpoint(userModel);

        if (!asrEndpoint) {
            console.error(`ASR endpoint not configured for model: ${userModel}`);
            return false;
        }

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


async function processAudio(fileInfo, chatId, messageToEditId = null) {
    const fileId = fileInfo.file_id;
    let localFilePath = null;
    let wavPath = null;
    let downloadTelegramFileStatus = null;
    audioProcessingId = chatId;
    isProcessing = true;
    try {
        downloadTelegramFileStatus = await downloadTelegramFile(fileId);
        if (!downloadTelegramFileStatus.status) {
            return { success: false, error: 'Не удалось загрузить файл' };
        }
        localFilePath = downloadTelegramFileStatus.path;
        await sendTelegramChatAction(chatId, 'typing');
        if (messageToEditId) await editTelegramMessageText(chatId, messageToEditId, "🔍 Распознаю речь...");
        else await sendTelegramMessage(chatId, "🔍 Распознаю речь...");

        wavPath = await convertToWav(localFilePath);
        if (!wavPath) {
            return { success: false, error: 'Ошибка конвертации в WAV' };
        }

        const transcribedText = await sendToAsr(wavPath, chatId);
        return { success: true, text: transcribedText };

    } catch (error) {
        console.error('Error in processAudio:', error);
        return { success: false, error: 'Внутренняя ошибка при обработке аудио' };
    } finally {
        if (localFilePath) await fs.unlink(localFilePath).catch(e => console.error("Error deleting temp file:", e));
        if (wavPath && wavPath !== localFilePath) await fs.unlink(wavPath).catch(e => console.error("Error deleting WAV file:", e));
    }
}


async function getUserModel(userId) {
    try {
        await fs.access(USER_MODELS_FILE);
        const data = await fs.readFile(USER_MODELS_FILE, 'utf-8');
        const models = JSON.parse(data);
        return models[userId] || 'Vosk';
    } catch (error) {
        return 'Vosk';
    }
}


async function setUserModel(userId, model) {
    let models = {};
    try {
        await fs.access(USER_MODELS_FILE);
        const data = await fs.readFile(USER_MODELS_FILE, 'utf-8');
        models = JSON.parse(data);
    } catch (error) {
    }
    models[userId] = model;
    try {
        await fs.writeFile(USER_MODELS_FILE, JSON.stringify(models, null, 2));
    } catch (error) {
        console.error("Error writing user models file:", error);
    }
}


function pickModelEndpoint(modelName) {
    const modelLower = modelName.toLowerCase();
    if (modelLower === 'whisper' && WHISPER_ENDPOINT) {
        return `${WHISPER_ENDPOINT}/transcribe`;
    } else if (modelLower === 'vosk' && VOSK_ENDPOINT) {
        return `${VOSK_ENDPOINT}/transcribe`;
    }
    console.warn(`Endpoint not found or not configured for model: ${modelName}`);
    return `${VOSK_ENDPOINT}/transcribe`;
}

async function cleanupTempFiles() {
    try {
        const files = await fs.readdir(TEMP_DIR);
        const now = Date.now();
        const oneHour = 60 * 60 * 1000;
        const fiveMinutes = 5 * 60 * 1000;
        
        for (const file of files) {
            const filePath = path.join(TEMP_DIR, file);
            try {
                const stats = await fs.stat(filePath);
                if (now - stats.mtimeMs > fiveMinutes) {
                    await fs.unlink(filePath);
                    console.log(`Deleted old temp file: ${filePath}`);
                }
            } catch (statErr) {
                console.warn(`Could not stat/delete temp file ${filePath}:`, statErr.message);
            }
        }
    } catch (error) {
        if (error.code !== 'ENOENT') {
            console.error('Error during temp file cleanup:', error);
        }
    }
}



app.get('/health', async (req, res) => {
    return res.status(200).send('Server is alive');
})

const webhookPath = '/webhook';
app.post(webhookPath, async (req, res) => {
    if (SECRET_TOKEN) {
        const receivedToken = req.headers['x-telegram-bot-api-secret-token'];
        if (receivedToken !== SECRET_TOKEN) {
            console.warn('Unauthorized: Invalid Secret Token');
            return res.status(403).send('Access denied');
        }
    }

    const update = req.body;

    if (!update) {
        console.warn('Bad Request: Received empty update body');
        return res.status(400).send('Bad Request');
    }
    if (update.message == null && update.callback_query == null) {
        console.log('Received an update type that is not a message or callback query. Update content:', update);
    }
    const updateId = update.update_id;
    if (updateId != null) {
        try {
            let lastId = null;
            try {
                await fs.access(UPDATE_LOG_FILE);
                lastId = parseInt(await fs.readFile(UPDATE_LOG_FILE, 'utf-8'), 10);
            } catch (e) { }

            if (lastId != null && updateId <= lastId) {
                console.log(`Duplicate update_id: ${updateId} <= ${lastId}. Ignoring.`);
                return res.sendStatus(200);
            }
            await fs.writeFile(UPDATE_LOG_FILE, updateId.toString());
        } catch (e) {
            console.error("Error handling update_id log:", e);
        }
    }

    res.sendStatus(200);

    try {
        let processingWarningMessageId;
        if (update.callback_query) {
            const cbq = update.callback_query;
            const chatId = cbq.message.chat.id;
            const messageId = cbq.message.message_id;
            const data = cbq.data;

            if (chatId === audioProcessingId && isProcessing) {
                if (processingWarningMessageCount === 0) {
                    processingWarningMessageId = await sendTelegramMessage(chatId, 'Пожалуйста, подождите, ваш запрос обрабатывается.');
                    processingWarningMessageCount++;
                }
                return;
            }
            if (data.startsWith('select_model:')) {
                const model = data.substring('select_model:'.length);
                await setUserModel(chatId, model);
                await answerTelegramCallbackQuery(cbq.id, `Вы выбрали модель: ${model}`);
                await editTelegramMessageText(chatId, messageId, `Вы выбрали модель: *${model}*.`, true);
            }
        } else if (update.message) {
            const message = update.message;
            const chatId = message.chat.id;
            const messageId = message.message_id;
            if (chatId === audioProcessingId && isProcessing) {
                if (processingWarningMessageCount === 0) {
                    processingWarningMessageId = await sendTelegramMessage(chatId, 'Пожалуйста, подождите, ваш запрос обрабатывается.');
                    processingWarningMessageCount++;
                }
                return;
            }
            if (message.text) {
                if (message.text === '/change_model') {
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
                } else if (message.text === '/model') {
                    const currentModel = await getUserModel(chatId);
                    const modelDescription = MODELS_INFO[currentModel] || "Неизвестная модель";
                    const text = `Ваша текущая модель:\n*${currentModel}* - ${modelDescription}`;
                    await sendTelegramMessage(chatId, text);
                } else {
                    const sizeMb = MAX_FILE_SIZE / (1024 * 1024);
                    await sendTelegramMessage(chatId, `Пожалуйста, отправьте голосовое сообщение или аудиофайл (поддерживаются WAV, MP3, OGG) до ${sizeMb} Мб`);
                }
            } else if (message.voice || message.audio || (message.document && message.document.mime_type.startsWith('audio/'))) {
                const fileInfo = message.voice || message.audio || message.document;

                const typingIntervalId = setInterval(() => {
                    sendTelegramChatAction(chatId, 'typing');

                }, 4000);
                // await sendTelegramChatAction(chatId, 'typing');
                const progressMessage = await sendTelegramMessage(chatId, "🎧 Обрабатываю аудио...");
                const messageToEditId = progressMessage && progressMessage.ok ? progressMessage.result.message_id : null;



                const result = await processAudio(fileInfo, chatId, messageToEditId).then(res => {
                    isProcessing = false;
                    audioProcessingId = null;
                    processingWarningMessageCount = 0;
                    clearInterval(typingIntervalId);
                    return res;
                });


                if (result.success) {
                    const currentModel = await getUserModel(chatId);
                    const modelPrefix = currentModel === 'Vosk' ? "🚀_Vosk_\n" : "🎯_Whisper_\n";
                    let responseText = result.text ? `${modelPrefix}Вот что мне удалось услышать:\n\`\`\`\n${result.text}\n\`\`\`` : `${modelPrefix}Речь не распознана.`;

                    // if (messageToEditId) {
                    //     await editTelegramMessageText(chatId, messageToEditId, responseText);
                    // } else {
                    //     await sendTelegramMessage(chatId, responseText);
                    // }
                    await deleteTelegramMessage(chatId, messageToEditId);
                    processingWarningMessageId && deleteTelegramMessage(chatId, processingWarningMessageId);

                    await sendTelegramMessage(chatId, responseText, null, true, messageId);
                } else {
                    const errorText = `Ошибка: ${result.error || 'Не удалось обработать аудио.'}`;
                    if (messageToEditId) {
                        await editTelegramMessageText(chatId, messageToEditId, errorText);
                    } else {
                        await sendTelegramMessage(chatId, errorText);
                    }
                }
            } else {
                const sizeMb = MAX_FILE_SIZE / (1024 * 1024);
                await sendTelegramMessage(chatId, `Пожалуйста, отправьте голосовое сообщение или аудиофайл (поддерживаются WAV, MP3, OGG) до ${sizeMb} Мб`);
            }
        }
    } catch (error) {
        console.error("Error processing update:", error);
        // Optionally, send a generic error message to the user if a chatId is available
        if (chatId) await sendTelegramMessage(chatId, "Произошла внутренняя ошибка. Попробуйте позже.");
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
    if (!VOSK_ENDPOINT && !WHISPER_ENDPOINT) {
        console.warn("WARNING: Neither VOSK_ENDPOINT nor WHISPER_ENDPOINT are defined. ASR functionality will be limited.");
    }


    await ensureDir(TEMP_DIR);

    // Set webhook with Telegram
    const fullWebhookUrl = `${WEBHOOK_URL.replace(/\/$/, '')}${webhookPath}`;
    // try {
    //     const webhookPayload = { url: fullWebhookUrl };
    //     if (SECRET_TOKEN) {
    //         webhookPayload.secret_token = SECRET_TOKEN;
    //     }
    //     const tgWebhookUrl = `https://api.telegram.org/bot${BOT_TOKEN}/setWebhook`;
    //     const options = requestOptionsBuilder('POST', { 'Content-Type': 'application/json' }, JSON.stringify(webhookPayload));
    //     const response = await fetch(tgWebhookUrl, options);
    //     const responseData = await response.json();
    //     if (response.ok && responseData.ok) {
    //         console.log(`Webhook set successfully to: ${fullWebhookUrl}`);
    //         console.log(`Telegram response: ${responseData.description}`);
    //     } else {
    //         console.error('Failed to set Telegram webhook:');
    //         console.error(`Status: ${response.status}`);
    //         console.error('Response:', responseData);
    //     }
    // } catch (error) {
    //     console.error('Error setting Telegram webhook:', error);
    // }

    app.listen(PORT, () => {
        console.log(`Server listening on port ${PORT}`);
        console.log(`Webhook endpoint available at: ${webhookPath}`);

        cleanupTempFiles();
        setInterval(cleanupTempFiles, 60 * 1000);
    });
}

import('node-fetch')
    .then(module => {
        fetch = module.default; // Assign the default export (the fetch function)
        if (typeof fetch !== 'function') {
            // This check is a safeguard, module.default should be the function for node-fetch v3+
            console.error("Failed to load fetch function from node-fetch. Ensure 'node-fetch' is installed correctly (v3+ expected).");
            process.exit(1);
        }
        // Now that fetch is initialized, start the server
        startServer().catch(err => {
            console.error("Failed to start server:", err);
            process.exit(1);
        });
    })
    .catch(err => {
        console.error("Failed to dynamically import node-fetch. Make sure 'node-fetch' is installed.", err);
        process.exit(1);
    });

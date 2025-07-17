const TelegramBot = require('node-telegram-bot-api');
const axios = require('axios');
const FormData = require('form-data');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

// Bot Configuration - Using environment variables only
const BOT_TOKEN = process.env.BOT_TOKEN;
const GEMINI_KEYS = [
    process.env.GEMINI_API_KEY_1,
    process.env.GEMINI_API_KEY_2,
    process.env.GEMINI_API_KEY_3
].filter(key => key); // Remove undefined keys

// Validate required environment variables
if (!BOT_TOKEN) {
    console.error('❌ BOT_TOKEN environment variable is required');
    process.exit(1);
}

if (GEMINI_KEYS.length === 0) {
    console.error('❌ At least one GEMINI_API_KEY environment variable is required');
    process.exit(1);
}

// Initialize bot
const bot = new TelegramBot(BOT_TOKEN, { polling: true });

// Enhanced global variables
let currentKeyIndex = 0;
let rateLimitResetTime = {};
let userSessions = new Map(); // Store user conversation history
let botMetrics = {
    messagesProcessed: 0,
    imagesAnalyzed: 0,
    voiceMessagesReceived: 0,
    errorsEncountered: 0,
    startTime: Date.now()
};

// Enhanced models configuration
const MODELS = {
    TEXT: 'gemini-2.0-flash-exp',
    VOICE: 'gemini-1.5-pro',
    IMAGE: 'gemini-1.5-pro',
    DOCUMENT: 'gemini-1.5-pro',
    FALLBACK: 'gemini-1.5-flash'
};

// User session management
class UserSession {
    constructor(userId) {
        this.userId = userId;
        this.conversationHistory = [];
        this.preferredLanguage = 'auto'; // auto, ar, en
        this.lastActivity = Date.now();
        this.messageCount = 0;
        this.preferences = {
            longResponses: false,
            includeEmojis: true,
            formalTone: false
        };
    }

    addMessage(role, content) {
        this.conversationHistory.push({
            role,
            content,
            timestamp: Date.now()
        });
        
        // Keep only last 10 messages to manage memory
        if (this.conversationHistory.length > 10) {
            this.conversationHistory = this.conversationHistory.slice(-10);
        }
        
        this.lastActivity = Date.now();
        this.messageCount++;
    }

    getContextPrompt() {
        if (this.conversationHistory.length === 0) return '';
        
        const recentMessages = this.conversationHistory.slice(-5);
        return recentMessages.map(msg => `${msg.role}: ${msg.content}`).join('\n');
    }

    detectLanguage(text) {
        const arabicPattern = /[\u0600-\u06FF]/;
        const darjaKeywords = ['راك', 'شكون', 'وش', 'نشاط', 'بصح', 'شنو', 'كيفاش', 'مليح', 'برك'];
        
        if (arabicPattern.test(text)) {
            return darjaKeywords.some(keyword => text.includes(keyword)) ? 'dz' : 'ar';
        }
        return 'en';
    }
}

// Enhanced API key management
function getCurrentApiKey() {
    return GEMINI_KEYS[currentKeyIndex];
}

function rotateApiKey() {
    currentKeyIndex = (currentKeyIndex + 1) % GEMINI_KEYS.length;
    console.log(`🔄 Rotated to API key ${currentKeyIndex + 1}/${GEMINI_KEYS.length}`);
}

function canUseCurrentKey() {
    const now = Date.now();
    const resetTime = rateLimitResetTime[currentKeyIndex];
    return !resetTime || now >= resetTime;
}

function handleRateLimit() {
    const now = Date.now();
    rateLimitResetTime[currentKeyIndex] = now + (60 * 1000); // Wait 1 minute
    console.log(`⚠️ Rate limit hit for key ${currentKeyIndex + 1}, waiting...`);
    rotateApiKey();
}

// Enhanced Gemini API request with better error handling
async function makeGeminiRequest(model, prompt, imageData = null, retryCount = 0) {
    let attempts = 0;
    const maxAttempts = GEMINI_KEYS.length * 2; // Allow multiple retries per key
    
    while (attempts < maxAttempts) {
        if (!canUseCurrentKey()) {
            rotateApiKey();
            attempts++;
            continue;
        }
        
        try {
            const apiKey = getCurrentApiKey();
            const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`;
            
            let requestBody = {
                contents: [{
                    parts: imageData ? 
                        [{ text: prompt }, { inline_data: imageData }] : 
                        [{ text: prompt }]
                }],
                generationConfig: {
                    temperature: 0.7,
                    topK: 40,
                    topP: 0.95,
                    maxOutputTokens: 2048,
                },
                safetySettings: [
                    {
                        category: "HARM_CATEGORY_HARASSMENT",
                        threshold: "BLOCK_MEDIUM_AND_ABOVE"
                    },
                    {
                        category: "HARM_CATEGORY_HATE_SPEECH",
                        threshold: "BLOCK_MEDIUM_AND_ABOVE"
                    }
                ]
            };
            
            const response = await axios.post(url, requestBody, {
                headers: { 'Content-Type': 'application/json' },
                timeout: 45000 // Increased timeout
            });
            
            if (response.data.candidates && response.data.candidates.length > 0) {
                const result = response.data.candidates[0].content.parts[0].text;
                return result;
            } else {
                throw new Error('No valid response from Gemini API');
            }
            
        } catch (error) {
            console.error(`❌ Error with API key ${currentKeyIndex + 1}:`, error.message);
            
            if (error.response?.status === 429) {
                handleRateLimit();
            } else if (error.response?.status === 400) {
                // Bad request - try with fallback model
                if (model !== MODELS.FALLBACK && retryCount < 1) {
                    console.log('🔄 Retrying with fallback model...');
                    return await makeGeminiRequest(MODELS.FALLBACK, prompt, imageData, retryCount + 1);
                }
                throw new Error('Invalid request format');
            } else {
                rotateApiKey();
            }
            
            attempts++;
        }
    }
    
    throw new Error('All API keys exhausted');
}

// Enhanced language detection and response generation
function generateEnhancedPrompt(messageText, userName, session) {
    const language = session.detectLanguage(messageText);
    const context = session.getContextPrompt();
    
    let systemPrompt = `You are ChatWME, an intelligent AI assistant created by Abdou. You are conversational, helpful, and culturally aware.

PERSONALITY TRAITS:
- Friendly and approachable
- Intelligent but not condescending  
- Culturally sensitive to Algerian context
- Adaptable communication style
- Problem-solving oriented

LANGUAGE CAPABILITIES:
- Fluent in English and Algerian Darija (الدارجة الجزائرية)
- Understand mixed Arabic-French expressions common in Algeria
- Respond in the same language as the user
- Use appropriate cultural references and expressions

RESPONSE GUIDELINES:
- Keep responses concise but informative
- Use emojis naturally (${session.preferences.includeEmojis ? 'enabled' : 'disabled'})
- ${session.preferences.formalTone ? 'Use formal tone' : 'Use conversational tone'}
- ${session.preferences.longResponses ? 'Provide detailed explanations' : 'Keep responses concise'}

ALGERIAN DARIJA EXPRESSIONS YOU UNDERSTAND:
- "كيفاش راك؟" (How are you?)
- "وش تقدر دير؟" (What can you do?)
- "شنو هذا؟" (What is this?)
- "نشاط؟" (What's up?)
- "بصح؟" (Really?)
- "مليح" (Good/Nice)
- "برك" (Enough/Stop)
- "شكون نت؟" (Who are you?)

CONVERSATION CONTEXT:
${context ? `Previous conversation:\n${context}\n` : 'This is a new conversation.'}

USER INFO:
- Name: ${userName}
- Detected language: ${language}
- Messages in session: ${session.messageCount}

Current message: "${messageText}"

Please respond appropriately, maintaining context and using the appropriate language:`;

    return systemPrompt;
}

// Enhanced text message handler
async function handleTextMessage(chatId, messageText, userName, messageId) {
    try {
        botMetrics.messagesProcessed++;
        
        // Get or create user session
        let session = userSessions.get(chatId);
        if (!session) {
            session = new UserSession(chatId);
            userSessions.set(chatId, session);
        }
        
        // Add user message to history
        session.addMessage('user', messageText);
        
        // Handle special commands
        if (await handleSpecialCommands(chatId, messageText, userName, session)) {
            return;
        }
        
        // Check for creator-related queries
        const creatorQueries = [
            'who made you', 'who created you', 'who is your creator', 'your developer',
            'من صنعك', 'من عملك', 'شكون صنعك', 'شكون عملك', 'مطورك', 'صانعك'
        ];
        
        if (creatorQueries.some(query => messageText.toLowerCase().includes(query))) {
            const creatorMessage = session.detectLanguage(messageText) === 'en' ?
                `👨‍💻 I was created by **Abdou**!\n\nHe's a talented developer who built me to help people like you. You can connect with him on Facebook! 🚀` :
                `👨‍💻 تم إنشائي من قبل **عبدو**!\n\nهو مطور موهوب قام ببنائي لمساعدة أشخاص مثلك. يمكنك التواصل معه على Facebook! 🚀`;
            
            await bot.sendMessage(chatId, creatorMessage, {
                parse_mode: 'Markdown',
                reply_markup: {
                    inline_keyboard: [[{
                        text: '👤 Visit Abdou\'s Facebook',
                        url: 'https://www.facebook.com/abdou.tsu.446062'
                    }]]
                }
            });
            return;
        }
        
        // Generate enhanced prompt
        const prompt = generateEnhancedPrompt(messageText, userName, session);
        
        // Send typing indicator
        await bot.sendChatAction(chatId, 'typing');
        
        // Get response from Gemini
        const response = await makeGeminiRequest(MODELS.TEXT, prompt);
        
        // Add bot response to history
        session.addMessage('assistant', response);
        
        // Send response with better formatting
        await bot.sendMessage(chatId, response, {
            parse_mode: 'Markdown',
            reply_to_message_id: messageId
        });
        
    } catch (error) {
        console.error('❌ Error handling text message:', error);
        botMetrics.errorsEncountered++;
        
        const errorMessage = session?.detectLanguage(messageText) === 'en' ?
            '⚠️ Sorry, I encountered an error. Please try again.' :
            '⚠️ عذراً، واجهت خطأ. حاول مرة أخرى.';
            
        await bot.sendMessage(chatId, errorMessage);
    }
}

// Special commands handler
async function handleSpecialCommands(chatId, messageText, userName, session) {
    const command = messageText.toLowerCase().trim();
    
    // Settings command
    if (command === '/settings' || command === 'إعدادات') {
        const settingsMessage = session.detectLanguage(messageText) === 'en' ?
            `⚙️ **Settings for ${userName}**\n\n` +
            `🗣️ Language: ${session.preferredLanguage}\n` +
            `📝 Long responses: ${session.preferences.longResponses ? 'On' : 'Off'}\n` +
            `😊 Emojis: ${session.preferences.includeEmojis ? 'On' : 'Off'}\n` +
            `🎩 Formal tone: ${session.preferences.formalTone ? 'On' : 'Off'}\n\n` +
            `Use /toggle_long, /toggle_emojis, /toggle_formal to change settings.` :
            `⚙️ **إعدادات ${userName}**\n\n` +
            `🗣️ اللغة: ${session.preferredLanguage}\n` +
            `📝 الردود الطويلة: ${session.preferences.longResponses ? 'مفعل' : 'معطل'}\n` +
            `😊 الإيموجي: ${session.preferences.includeEmojis ? 'مفعل' : 'معطل'}\n` +
            `🎩 نبرة رسمية: ${session.preferences.formalTone ? 'مفعل' : 'معطل'}\n\n` +
            `استخدم /toggle_long، /toggle_emojis، /toggle_formal لتغيير الإعدادات.`;
        
        await bot.sendMessage(chatId, settingsMessage, { parse_mode: 'Markdown' });
        return true;
    }
    
    // Toggle commands
    if (command === '/toggle_long') {
        session.preferences.longResponses = !session.preferences.longResponses;
        await bot.sendMessage(chatId, `📝 Long responses: ${session.preferences.longResponses ? 'On' : 'Off'}`);
        return true;
    }
    
    if (command === '/toggle_emojis') {
        session.preferences.includeEmojis = !session.preferences.includeEmojis;
        await bot.sendMessage(chatId, `😊 Emojis: ${session.preferences.includeEmojis ? 'On' : 'Off'}`);
        return true;
    }
    
    if (command === '/toggle_formal') {
        session.preferences.formalTone = !session.preferences.formalTone;
        await bot.sendMessage(chatId, `🎩 Formal tone: ${session.preferences.formalTone ? 'On' : 'Off'}`);
        return true;
    }
    
    // Stats command
    if (command === '/stats' || command === 'إحصائيات') {
        const uptime = Math.floor((Date.now() - botMetrics.startTime) / 1000 / 60); // minutes
        const statsMessage = `📊 **Bot Statistics**\n\n` +
                            `⏰ Uptime: ${uptime} minutes\n` +
                            `💬 Messages processed: ${botMetrics.messagesProcessed}\n` +
                            `🖼️ Images analyzed: ${botMetrics.imagesAnalyzed}\n` +
                            `🎤 Voice messages: ${botMetrics.voiceMessagesReceived}\n` +
                            `❌ Errors: ${botMetrics.errorsEncountered}\n` +
                            `👤 Your messages: ${session.messageCount}`;
        
        await bot.sendMessage(chatId, statsMessage, { parse_mode: 'Markdown' });
        return true;
    }
    
    return false;
}

// Enhanced voice message handler
async function handleVoiceMessage(chatId, voice, userName) {
    try {
        botMetrics.voiceMessagesReceived++;
        
        let session = userSessions.get(chatId);
        if (!session) {
            session = new UserSession(chatId);
            userSessions.set(chatId, session);
        }
        
        const processingMessage = session.detectLanguage('voice') === 'en' ?
            '🎤 Processing your voice message...' :
            '🎤 جاري معالجة رسالتك الصوتية...';
            
        await bot.sendMessage(chatId, processingMessage);
        
        // Enhanced voice response
        const voiceResponse = session.detectLanguage('voice') === 'en' ?
            `🎤 **Voice Message Received from ${userName}!**\n\n` +
            `I can hear you! However, voice-to-text processing requires additional setup with Google Speech-to-Text API.\n\n` +
            `💡 **For now, you can:**\n` +
            `• Type your message instead\n` +
            `• Send an image with text\n` +
            `• Use voice commands like "Hello" or "Help"\n\n` +
            `I'll respond instantly to any text message! 😊` :
            `🎤 **استلمت رسالتك الصوتية يا ${userName}!**\n\n` +
            `أستطيع سماعك! لكن معالجة الصوت تحتاج إعداد إضافي مع Google Speech-to-Text API.\n\n` +
            `💡 **في الوقت الحالي، يمكنك:**\n` +
            `• كتابة رسالتك بدلاً من ذلك\n` +
            `• إرسال صورة بها نص\n` +
            `• استخدام أوامر صوتية مثل "مرحبا" أو "مساعدة"\n\n` +
            `سأجيب فوراً على أي رسالة نصية! 😊`;
        
        await bot.sendMessage(chatId, voiceResponse, { parse_mode: 'Markdown' });
        
    } catch (error) {
        console.error('❌ Error handling voice message:', error);
        botMetrics.errorsEncountered++;
        await bot.sendMessage(chatId, '⚠️ خطأ في معالجة الرسالة الصوتية / Error processing voice message');
    }
}

// Enhanced image message handler
async function handleImageMessage(chatId, photo, userName) {
    try {
        botMetrics.imagesAnalyzed++;
        
        let session = userSessions.get(chatId);
        if (!session) {
            session = new UserSession(chatId);
            userSessions.set(chatId, session);
        }
        
        const analyzingMessage = session.detectLanguage('image') === 'en' ?
            '🖼️ Analyzing your image...' :
            '🖼️ جاري تحليل صورتك...';
            
        await bot.sendMessage(chatId, analyzingMessage);
        await bot.sendChatAction(chatId, 'upload_photo');
        
        // Get the highest resolution photo
        const bestPhoto = photo[photo.length - 1];
        const file = await bot.getFile(bestPhoto.file_id);
        const fileUrl = `https://api.telegram.org/file/bot${BOT_TOKEN}/${file.file_path}`;
        
        // Download and process image
        const imageResponse = await axios.get(fileUrl, { 
            responseType: 'arraybuffer',
            timeout: 30000 
        });
        const imageBase64 = Buffer.from(imageResponse.data).toString('base64');
        
        // Enhanced image analysis prompt
        const prompt = `You are ChatWME, analyzing an image for ${userName}. Provide a detailed, helpful analysis.

ANALYSIS REQUIREMENTS:
- Describe what you see in detail
- Identify objects, people, text, or scenes
- Mention colors, composition, and notable features
- If there's text, transcribe it accurately
- Provide cultural context if relevant
- Be observant about details that might be important

LANGUAGE: ${session.detectLanguage('analysis') === 'en' ? 'Respond in English' : 'Respond in Arabic/Algerian Darija'}

TONE: Be helpful, descriptive, and engaging. If you see something interesting or unusual, mention it.

Please analyze this image thoroughly:`;
        
        const imageData = {
            mimeType: 'image/jpeg',
            data: imageBase64
        };
        
        const response = await makeGeminiRequest(MODELS.IMAGE, prompt, imageData);
        
        // Add to conversation history
        session.addMessage('user', '[Image uploaded]');
        session.addMessage('assistant', response);
        
        const headerText = session.detectLanguage('analysis') === 'en' ?
            '🖼️ **Image Analysis:**' :
            '🖼️ **تحليل الصورة:**';
        
        await bot.sendMessage(chatId, `${headerText}\n\n${response}`, {
            parse_mode: 'Markdown'
        });
        
    } catch (error) {
        console.error('❌ Error handling image message:', error);
        botMetrics.errorsEncountered++;
        await bot.sendMessage(chatId, '⚠️ خطأ في تحليل الصورة / Error analyzing image');
    }
}

// Enhanced document handler
async function handleDocumentMessage(chatId, document, userName) {
    try {
        let session = userSessions.get(chatId);
        if (!session) {
            session = new UserSession(chatId);
            userSessions.set(chatId, session);
        }
        
        const processingMessage = session.detectLanguage('document') === 'en' ?
            '📄 Processing your document...' :
            '📄 جاري معالجة المستند...';
            
        await bot.sendMessage(chatId, processingMessage);
        
        const fileName = document.file_name || 'document';
        const fileSize = (document.file_size / 1024 / 1024).toFixed(2);
        const fileExtension = path.extname(fileName).toLowerCase();
        
        // Enhanced document info
        const supportedTypes = ['.pdf', '.txt', '.doc', '.docx', '.jpg', '.jpeg', '.png'];
        const isSupported = supportedTypes.includes(fileExtension);
        
        const response = session.detectLanguage('document') === 'en' ?
            `📄 **Document Information:**\n\n` +
            `📝 **File Name:** ${fileName}\n` +
            `📊 **File Size:** ${fileSize} MB\n` +
            `🔧 **File Type:** ${fileExtension}\n` +
            `✅ **Supported:** ${isSupported ? 'Yes' : 'No'}\n` +
            `👤 **Uploaded by:** ${userName}\n\n` +
            `${isSupported ? 
                '✅ Document received! For text analysis, convert to image or copy the text content.' :
                '⚠️ This file type needs special processing. Try converting to PDF or image format.'
            }\n\n` +
            `💡 **Tip:** Send images of document pages for instant analysis!` :
            `📄 **معلومات المستند:**\n\n` +
            `📝 **اسم الملف:** ${fileName}\n` +
            `📊 **حجم الملف:** ${fileSize} ميجابايت\n` +
            `🔧 **نوع الملف:** ${fileExtension}\n` +
            `✅ **مدعوم:** ${isSupported ? 'نعم' : 'لا'}\n` +
            `👤 **رفع بواسطة:** ${userName}\n\n` +
            `${isSupported ? 
                '✅ تم استلام المستند! لتحليل النص، حوله إلى صورة أو انسخ المحتوى.' :
                '⚠️ هذا النوع من الملفات يحتاج معالجة خاصة. جرب تحويله إلى PDF أو صورة.'
            }\n\n` +
            `💡 **نصيحة:** أرسل صور لصفحات المستند للتحليل الفوري!`;
        
        await bot.sendMessage(chatId, response, { parse_mode: 'Markdown' });
        
    } catch (error) {
        console.error('❌ Error handling document message:', error);
        botMetrics.errorsEncountered++;
        await bot.sendMessage(chatId, '⚠️ خطأ في معالجة المستند / Error processing document');
    }
}

// Enhanced main message handler
bot.on('message', async (msg) => {
    const chatId = msg.chat.id;
    const userName = msg.from.first_name || 'Friend';
    const messageId = msg.message_id;
    
    try {
        // Handle different message types
        if (msg.text) {
            await handleTextMessage(chatId, msg.text, userName, messageId);
        } else if (msg.voice) {
            await handleVoiceMessage(chatId, msg.voice, userName);
        } else if (msg.photo) {
            await handleImageMessage(chatId, msg.photo, userName);
        } else if (msg.document) {
            await handleDocumentMessage(chatId, msg.document, userName);
        } else if (msg.video) {
            await bot.sendMessage(chatId, 
                '🎥 Video received! Currently I can process text, images, and voice messages. ' +
                'Try extracting a frame as an image for analysis! / ' +
                'تم استلام فيديو! حالياً أستطيع معالجة النصوص والصور والأصوات. ' +
                'جرب استخراج إطار كصورة للتحليل!'
            );
        } else {
            await bot.sendMessage(chatId, 
                '🤔 Unsupported message type. Try text, image, or voice! / ' +
                'نوع رسالة غير مدعوم. جرب النص أو الصورة أو الصوت!'
            );
        }
    } catch (error) {
        console.error('❌ Error in message handler:', error);
        botMetrics.errorsEncountered++;
        await bot.sendMessage(chatId, 
            '⚠️ An unexpected error occurred. Please try again. / ' +
            'حدث خطأ غير متوقع. يرجى المحاولة مرة أخرى.'
        );
    }
});

// Enhanced /start command
bot.onText(/\/start/, async (msg) => {
    const chatId = msg.chat.id;
    const userName = msg.from.first_name || 'Friend';
    
    // Create new session
    const session = new UserSession(chatId);
    userSessions.set(chatId, session);
    
    const welcomeMessage = `🤖 **أهلاً وسهلاً ${userName}، أنا ChatWME!**\n\n` +
                          `🌟 **مساعد ذكي متطور يمكنني:**\n` +
                          `💬 المحادثة بالعربية الجزائرية والإنجليزية\n` +
                          `🎤 معالجة الرسائل الصوتية\n` +
                          `🖼️ تحليل الصور بتفصيل\n` +
                          `📄 قراءة المستندات\n` +
                          `🧠 تذكر المحادثة والسياق\n` +
                          `⚙️ إعدادات قابلة للتخصيص\n\n` +
                          `---\n\n` +
                          `🤖 **Hello ${userName}, I'm ChatWME!**\n\n` +
                          `🌟 **Advanced AI assistant that can:**\n` +
                          `💬 Chat in Algerian Darija and English\n` +
                          `🎤 Process voice messages\n` +
                          `🖼️ Analyze images in detail\n` +
                          `📄 Read documents\n` +
                          `🧠 Remember conversation context\n` +
                          `⚙️ Customizable settings\n\n` +
                          `💡 **جرب قول "مرحبا" أو إرسال صورة! / Try saying "Hello" or send an image!**`;
    
    await bot.sendMessage(chatId, welcomeMessage, {
        parse_mode: 'Markdown',
        reply_markup: {
            inline_keyboard: [
                [{ text: '👤 Meet Abdou (Creator)', url: 'https://www.facebook.com/abdou.tsu.446062' }],
                [{ text: '⚙️ Settings', callback_data: 'settings' }],
                [{ text: '📊 Stats', callback_data: 'stats' }],
                [{ text: '🚀 Start Chatting', callback_data: 'start_chat' }]
            ]
        }
    });
});


// Handle callback queries
bot.on('callback_query', async (query) => {
    const chatId = query.message.chat.id;
    const data = query.data;
    
    if (data === 'start_chat') {
        await bot.sendMessage(chatId, '🚀 رائع! أرسل لي أي رسالة وسأجيبك فوراً! / Great! Send me any message and I\'ll respond instantly!');
    }
    
    await bot.answerCallbackQuery(query.id);
});

// Handle /help command
bot.onText(/\/help/, async (msg) => {
    const chatId = msg.chat.id;
    
    const helpMessage = `🆘 **مساعدة ChatWME / ChatWME Help**\n\n` +
                       `📋 **الأوامر المتاحة / Available Commands:**\n` +
                       `• /start - بدء محادثة جديدة / Start new conversation\n` +
                       `• /help - عرض هذه المساعدة / Show this help\n` +
                       `• /creator - معلومات عن المطور / Creator information\n\n` +
                       `💡 **ما يمكنني فعله / What I can do:**\n` +
                       `✅ الرد على الأسئلة بالعربية والإنجليزية\n` +
                       `✅ Answer questions in Arabic and English\n` +
                       `✅ معالجة الرسائل الصوتية\n` +
                       `✅ Process voice messages\n` +
                       `✅ تحليل الصور والمستندات\n` +
                       `✅ Analyze images and documents\n\n` +
                       `🎯 **نصائح / Tips:**\n` +
                       `• اكتب بالدارجة الجزائرية وسأجيبك بنفس اللغة\n` +
                       `• Write in Algerian Darija and I'll respond in the same language\n` +
                       `• أرسل صور لأحللها لك\n` +
                       `• Send images for analysis`;
    
    await bot.sendMessage(chatId, helpMessage, {
        parse_mode: 'Markdown'
    });
});

// Handle /creator command
bot.onText(/\/creator/, async (msg) => {
    const chatId = msg.chat.id;
    
    const creatorMessage = `👨‍💻 **معلومات عن المطور / Creator Information**\n\n` +
                          `🌟 **اسم المطور / Creator Name:** Abdou\n` +
                          `🤖 **اسم البوت / Bot Name:** ChatWME\n` +
                          `🚀 **المهارات / Skills:** AI Development, Telegram Bots\n` +
                          `🌍 **الموقع / Location:** Algeria\n\n` +
                          `💬 **تواصل معه / Connect with him:**\n` +
                          `يمكنك التواصل مع Abdou على Facebook للاستفسارات أو التعاون!\n` +
                          `You can connect with Abdou on Facebook for inquiries or collaboration!`;
    
    await bot.sendMessage(chatId, creatorMessage, {
        parse_mode: 'Markdown',
        reply_markup: {
            inline_keyboard: [[{
                text: '📘 Visit Abdou\'s Facebook',
                url: 'https://www.facebook.com/abdou.tsu.446062'
            }]]
        }
    });
});

// Error handling
bot.on('error', (error) => {
    console.error('❌ Bot error:', error);
});

// Graceful shutdown
process.on('SIGTERM', () => {
    console.log('🛑 Received SIGTERM, shutting down gracefully...');
    bot.stopPolling();
    process.exit(0);
});

process.on('SIGINT', () => {
    console.log('🛑 Received SIGINT, shutting down gracefully...');
    bot.stopPolling();
    process.exit(0);
});

// Start the bot
console.log('🚀 ChatWME bot is starting...');
console.log('🤖 Bot created by Abdou');
console.log('🔑 Using 3 Gemini API keys for rotation');
console.log('✅ Bot is ready and listening for messages!');

// Keep the process alive
setInterval(() => {
    console.log('💓 Bot heartbeat - Active and running');
}, 300000); // Every 5 minutes
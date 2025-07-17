const TelegramBot = require('node-telegram-bot-api');
const axios = require('axios');

// Bot Configuration
const BOT_TOKEN = process.env.BOT_TOKEN;
const GEMINI_KEYS = [
    process.env.GEMINI_API_KEY_1,
    process.env.GEMINI_API_KEY_2,
    process.env.GEMINI_API_KEY_3
].filter(key => key);

const PORT = process.env.PORT || 3000;

// Validate environment variables
if (!BOT_TOKEN) {
    console.error('❌ BOT_TOKEN is required');
    process.exit(1);
}

if (GEMINI_KEYS.length === 0) {
    console.error('❌ At least one GEMINI_API_KEY is required');
    process.exit(1);
}

// Initialize bot for Railway webhook
const bot = new TelegramBot(BOT_TOKEN, { polling: false });

// Express server for webhook
const express = require('express');
const app = express();
app.use(express.json());

// Webhook endpoint
app.post(`/webhook/${BOT_TOKEN}`, (req, res) => {
    bot.processUpdate(req.body);
    res.sendStatus(200);
});

// Health check endpoint
app.get('/', (req, res) => {
    res.send('ChatWME Bot is running! 🤖');
});

app.listen(PORT, () => {
    console.log(`🌐 Server running on port ${PORT}`);
});

// Set webhook for Railway
const WEBHOOK_URL = process.env.RAILWAY_STATIC_URL || process.env.RAILWAY_URL;
if (WEBHOOK_URL) {
    bot.setWebHook(`${WEBHOOK_URL}/webhook/${BOT_TOKEN}`)
        .then(() => console.log('✅ Webhook set successfully'))
        .catch(err => console.error('❌ Webhook error:', err));
}

// API key rotation
let currentKeyIndex = 0;
const getCurrentApiKey = () => GEMINI_KEYS[currentKeyIndex];
const rotateApiKey = () => {
    currentKeyIndex = (currentKeyIndex + 1) % GEMINI_KEYS.length;
    console.log(`🔄 Rotated to API key ${currentKeyIndex + 1}`);
};

// Enhanced user sessions
const userSessions = new Map();
const userStats = new Map();

class UserSession {
    constructor(userId) {
        this.userId = userId;
        this.conversationHistory = [];
        this.lastActivity = Date.now();
        this.language = null; // Will be set after first message
        this.messageCount = 0;
        this.createdAt = Date.now();
    }

    addMessage(role, content) {
        this.conversationHistory.push({ 
            role, 
            content, 
            timestamp: Date.now() 
        });
        
        // Keep last 10 messages for better context
        if (this.conversationHistory.length > 10) {
            this.conversationHistory = this.conversationHistory.slice(-10);
        }
        
        this.lastActivity = Date.now();
        this.messageCount++;
    }

    detectLanguage(text) {
        const arabicPattern = /[\u0600-\u06FF]/;
        const detected = arabicPattern.test(text) ? 'ar' : 'en';
        
        // Set user's preferred language on first detection
        if (!this.language) {
            this.language = detected;
            console.log(`🌐 User ${this.userId} language set to: ${detected}`);
        }
        
        return this.language; // Always return user's preferred language
    }

    getContext() {
        return this.conversationHistory
            .slice(-6) // Use last 6 messages for context
            .map(msg => `${msg.role}: ${msg.content}`)
            .join('\n');
    }

    clearHistory() {
        this.conversationHistory = [];
        console.log(`🧹 Cleared history for user ${this.userId}`);
    }
}

// Gemini API request with better error handling
async function makeGeminiRequest(prompt, retries = 0) {
    const maxRetries = GEMINI_KEYS.length;
    
    for (let attempt = 0; attempt < maxRetries; attempt++) {
        try {
            const apiKey = getCurrentApiKey();
            const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:generateContent?key=${apiKey}`;
            
            const response = await axios.post(url, {
                contents: [{
                    parts: [{ text: prompt }]
                }],
                generationConfig: {
                    temperature: 0.8,
                    maxOutputTokens: 1500,
                    topK: 40,
                    topP: 0.95
                }
            }, {
                timeout: 30000,
                headers: {
                    'Content-Type': 'application/json'
                }
            });
            
            if (response.data.candidates?.[0]?.content?.parts?.[0]?.text) {
                return response.data.candidates[0].content.parts[0].text.trim();
            }
            
            throw new Error('No valid response from Gemini');
            
        } catch (error) {
            console.error(`❌ Error with API key ${currentKeyIndex + 1}:`, error.message);
            
            if (error.response?.status === 429) {
                console.log('⚠️ Rate limit hit, rotating key...');
                rotateApiKey();
                continue;
            }
            
            if (attempt === maxRetries - 1) {
                throw error;
            }
            
            rotateApiKey();
        }
    }
}

// Enhanced prompt generation
function generatePrompt(messageText, userName, session) {
    const language = session.detectLanguage(messageText);
    const context = session.getContext();
    
    const systemPrompt = `You are ChatWME, an intelligent AI assistant created by Abdou.

PERSONALITY & BEHAVIOR:
- Be helpful, friendly, and conversational
- Give direct, clear answers without unnecessary fluff
- Use natural language and appropriate emojis
- Be culturally aware, especially for Algerian/Arabic context
- Stay focused and avoid being overly verbose

LANGUAGE RULES:
- User's preferred language: ${language === 'ar' ? 'Arabic/Algerian Darija' : 'English'}
- ALWAYS respond in ${language === 'ar' ? 'Arabic/Algerian Darija' : 'English'} ONLY
- Use emojis naturally but don't overuse them
- Be concise but informative

CONVERSATION CONTEXT:
${context ? `Previous conversation:\n${context}\n` : 'This is the start of conversation.'}

USER: ${userName}
CURRENT MESSAGE: ${messageText}

Respond appropriately and naturally in ${language === 'ar' ? 'Arabic' : 'English'} only:`;

    return systemPrompt;
}

// Command handlers
const commands = {
    start: async (msg) => {
        const chatId = msg.chat.id;
        const userName = msg.from.first_name || 'Friend';
        
        // Create or get session to detect language
        let session = userSessions.get(chatId);
        if (!session) {
            session = new UserSession(chatId);
            userSessions.set(chatId, session);
        }
        
        // Detect language from command or use English as default
        const language = msg.text?.includes('العربية') || msg.from.language_code === 'ar' ? 'ar' : 'en';
        session.language = language;
        
        const welcomeMessage = language === 'ar' ?
            `🤖 **مرحباً ${userName}، أنا ChatWME!**\n\n` +
            `مساعد ذكي تم إنشاؤه من قبل عبدو 👨‍💻\n\n` +
            `**ما يمكنني فعله:**\n` +
            `💬 محادثة طبيعية\n` +
            `🧠 تذكر المحادثة السابقة\n` +
            `📚 الإجابة على الأسئلة\n` +
            `🎯 تقديم المساعدة\n\n` +
            `**الأوامر المتاحة:**\n` +
            `• /help - عرض المساعدة\n` +
            `• /clear - مسح تاريخ المحادثة\n` +
            `• /stats - إحصائيات الاستخدام\n` +
            `• /creator - معلومات المطور\n\n` +
            `أرسل لي أي رسالة وسأجيبك! 🚀` :
            
            `🤖 **Hello ${userName}, I'm ChatWME!**\n\n` +
            `An intelligent AI assistant created by Abdou 👨‍💻\n\n` +
            `**What I can do:**\n` +
            `💬 Natural conversation\n` +
            `🧠 Remember previous conversation\n` +
            `📚 Answer questions\n` +
            `🎯 Provide assistance\n\n` +
            `**Available commands:**\n` +
            `• /help - Show help\n` +
            `• /clear - Clear conversation history\n` +
            `• /stats - Usage statistics\n` +
            `• /creator - Creator information\n\n` +
            `Send me any message and I'll respond! 🚀`;
        
        await bot.sendMessage(chatId, welcomeMessage, {
            parse_mode: 'Markdown',
            reply_markup: {
                inline_keyboard: [
                    [{ text: '👤 Meet Abdou (Creator)', url: 'https://www.facebook.com/abdou.tsu.446062' }]
                ]
            }
        });
    },

    help: async (msg) => {
        const chatId = msg.chat.id;
        const session = userSessions.get(chatId);
        const language = session?.language || 'en';
        
        const helpMessage = language === 'ar' ?
            `🆘 **مساعدة ChatWME**\n\n` +
            `**الأوامر المتاحة:**\n` +
            `• /start - بدء المحادثة\n` +
            `• /help - عرض هذه المساعدة\n` +
            `• /clear - مسح تاريخ المحادثة\n` +
            `• /stats - إحصائيات الاستخدام\n` +
            `• /creator - معلومات المطور\n` +
            `• /language - تغيير اللغة\n\n` +
            `**المميزات:**\n` +
            `✅ محادثة طبيعية\n` +
            `✅ تذكر السياق\n` +
            `✅ فهم اللهجة الجزائرية\n` +
            `✅ إجابات سريعة ومباشرة\n\n` +
            `**نصائح:**\n` +
            `• تحدث معي بشكل طبيعي\n` +
            `• اسأل أي سؤال تريده\n` +
            `• سأتذكر محادثتنا السابقة` :
            
            `🆘 **ChatWME Help**\n\n` +
            `**Available Commands:**\n` +
            `• /start - Start conversation\n` +
            `• /help - Show this help\n` +
            `• /clear - Clear conversation history\n` +
            `• /stats - Usage statistics\n` +
            `• /creator - Creator information\n` +
            `• /language - Change language\n\n` +
            `**Features:**\n` +
            `✅ Natural conversation\n` +
            `✅ Context memory\n` +
            `✅ Algerian Darija support\n` +
            `✅ Fast and direct answers\n\n` +
            `**Tips:**\n` +
            `• Talk to me naturally\n` +
            `• Ask me anything you want\n` +
            `• I'll remember our previous conversation`;
        
        await bot.sendMessage(chatId, helpMessage, { parse_mode: 'Markdown' });
    },

    clear: async (msg) => {
        const chatId = msg.chat.id;
        const session = userSessions.get(chatId);
        
        if (session) {
            session.clearHistory();
            const language = session.language || 'en';
            
            const clearMessage = language === 'ar' ?
                `🧹 **تم مسح تاريخ المحادثة!**\n\nيمكنك الآن بدء محادثة جديدة معي 🚀` :
                `🧹 **Conversation history cleared!**\n\nYou can now start a fresh conversation with me 🚀`;
            
            await bot.sendMessage(chatId, clearMessage, { parse_mode: 'Markdown' });
        }
    },

    stats: async (msg) => {
        const chatId = msg.chat.id;
        const session = userSessions.get(chatId);
        const language = session?.language || 'en';
        
        if (session) {
            const uptime = Math.floor((Date.now() - session.createdAt) / 1000);
            const days = Math.floor(uptime / 86400);
            const hours = Math.floor((uptime % 86400) / 3600);
            const minutes = Math.floor((uptime % 3600) / 60);
            
            const statsMessage = language === 'ar' ?
                `📊 **إحصائيات الاستخدام**\n\n` +
                `💬 عدد الرسائل: ${session.messageCount}\n` +
                `🕐 مدة الجلسة: ${days}د ${hours}س ${minutes}دق\n` +
                `🌐 اللغة: ${session.language === 'ar' ? 'العربية' : 'الإنجليزية'}\n` +
                `🧠 رسائل في الذاكرة: ${session.conversationHistory.length}\n` +
                `📱 جلسات نشطة: ${userSessions.size}` :
                
                `📊 **Usage Statistics**\n\n` +
                `💬 Messages sent: ${session.messageCount}\n` +
                `🕐 Session duration: ${days}d ${hours}h ${minutes}m\n` +
                `🌐 Language: ${session.language === 'ar' ? 'Arabic' : 'English'}\n` +
                `🧠 Messages in memory: ${session.conversationHistory.length}\n` +
                `📱 Active sessions: ${userSessions.size}`;
            
            await bot.sendMessage(chatId, statsMessage, { parse_mode: 'Markdown' });
        }
    },

    creator: async (msg) => {
        const chatId = msg.chat.id;
        const session = userSessions.get(chatId);
        const language = session?.language || 'en';
        
        const creatorMessage = language === 'ar' ?
            `👨‍💻 **معلومات المطور**\n\n` +
            `**الاسم:** عبدو\n` +
            `**البوت:** ChatWME\n` +
            `**المهارات:** تطوير الذكاء الاصطناعي، بوتات التليجرام\n` +
            `**الموقع:** الجزائر 🇩🇿\n\n` +
            `**عن البوت:**\n` +
            `تم تطوير ChatWME ليكون مساعد ذكي يفهم اللغة العربية والإنجليزية\n\n` +
            `تواصل مع عبدو على الفيسبوك! 📘` :
            
            `👨‍💻 **Creator Information**\n\n` +
            `**Name:** Abdou\n` +
            `**Bot:** ChatWME\n` +
            `**Skills:** AI Development, Telegram Bots\n` +
            `**Location:** Algeria 🇩🇿\n\n` +
            `**About the Bot:**\n` +
            `ChatWME was developed to be an intelligent assistant that understands Arabic and English\n\n` +
            `Connect with Abdou on Facebook! 📘`;
        
        await bot.sendMessage(chatId, creatorMessage, {
            parse_mode: 'Markdown',
            reply_markup: {
                inline_keyboard: [[{
                    text: '📘 Visit Facebook',
                    url: 'https://www.facebook.com/abdou.tsu.446062'
                }]]
            }
        });
    },

    language: async (msg) => {
        const chatId = msg.chat.id;
        const session = userSessions.get(chatId);
        
        if (session) {
            const currentLang = session.language || 'en';
            const newLang = currentLang === 'ar' ? 'en' : 'ar';
            session.language = newLang;
            
            const langMessage = newLang === 'ar' ?
                `🌐 **تم تغيير اللغة إلى العربية!**\n\nسأجيب الآن بالعربية 🇩🇿` :
                `🌐 **Language changed to English!**\n\nI will now respond in English 🇺🇸`;
            
            await bot.sendMessage(chatId, langMessage, { parse_mode: 'Markdown' });
        }
    }
};

// Handle text messages
async function handleTextMessage(chatId, messageText, userName, messageId) {
    try {
        // Get or create user session
        let session = userSessions.get(chatId);
        if (!session) {
            session = new UserSession(chatId);
            userSessions.set(chatId, session);
        }
        
        // Add user message to history
        session.addMessage('user', messageText);
        
        // Generate prompt and get response
        const prompt = generatePrompt(messageText, userName, session);
        
        // Send typing indicator
        await bot.sendChatAction(chatId, 'typing');
        
        // Get response from Gemini
        const response = await makeGeminiRequest(prompt);
        
        // Add response to history
        session.addMessage('assistant', response);
        
        // Send response
        await bot.sendMessage(chatId, response, {
            reply_to_message_id: messageId,
            parse_mode: 'Markdown'
        });
        
    } catch (error) {
        console.error('❌ Error handling message:', error);
        
        const session = userSessions.get(chatId);
        const language = session?.language || 'en';
        
        const errorMessage = language === 'ar' ?
            'عذراً، حدث خطأ. حاول مرة أخرى 🔄' :
            'Sorry, I encountered an error. Please try again 🔄';
        
        await bot.sendMessage(chatId, errorMessage);
    }
}

// Message handler with command routing
bot.on('message', async (msg) => {
    const chatId = msg.chat.id;
    const userName = msg.from.first_name || 'Friend';
    const messageId = msg.message_id;
    
    try {
        // Handle commands
        if (msg.text && msg.text.startsWith('/')) {
            const command = msg.text.split(' ')[0].substring(1);
            
            if (commands[command]) {
                await commands[command](msg);
                return;
            }
        }
        
        // Handle text messages
        if (msg.text) {
            await handleTextMessage(chatId, msg.text, userName, messageId);
        } else {
            // Handle non-text messages
            const session = userSessions.get(chatId);
            const language = session?.language || 'en';
            
            const notSupportedMessage = language === 'ar' ?
                'أعالج الرسائل النصية فقط حالياً. أرسل لي رسالة نصية! 📝' :
                'I only process text messages for now. Please send me a text message! 📝';
            
            await bot.sendMessage(chatId, notSupportedMessage);
        }
    } catch (error) {
        console.error('❌ Error in message handler:', error);
        
        const session = userSessions.get(chatId);
        const language = session?.language || 'en';
        
        const errorMessage = language === 'ar' ?
            'حدث خطأ. حاول مرة أخرى 🔄' :
            'An error occurred. Please try again 🔄';
        
        await bot.sendMessage(chatId, errorMessage);
    }
});

// Error handling
bot.on('error', (error) => {
    console.error('❌ Bot error:', error);
});

// Enhanced cleanup with statistics
setInterval(() => {
    const now = Date.now();
    let cleanedCount = 0;
    
    for (const [chatId, session] of userSessions.entries()) {
        if (now - session.lastActivity > 7200000) { // 2 hours
            userSessions.delete(chatId);
            cleanedCount++;
        }
    }
    
    if (cleanedCount > 0) {
        console.log(`🧹 Cleaned up ${cleanedCount} old sessions. Active sessions: ${userSessions.size}`);
    }
}, 1800000); // Run every 30 minutes

// Startup messages
console.log('🚀 ChatWME bot started successfully!');
console.log('🤖 Created by Abdou');
console.log('✅ Enhanced with proper commands and language handling!');
console.log(`📊 API Keys loaded: ${GEMINI_KEYS.length}`);
console.log(`🌐 Webhook URL: ${WEBHOOK_URL || 'Not set'}`);

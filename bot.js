const TelegramBot = require('node-telegram-bot-api');
const axios = require('axios');
const express = require('express');

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
const app = express();
app.use(express.json());

// Enhanced webhook endpoint with better error handling
app.post(`/webhook/${BOT_TOKEN}`, (req, res) => {
    try {
        console.log('📨 Received webhook:', JSON.stringify(req.body, null, 2));
        bot.processUpdate(req.body);
        res.sendStatus(200);
    } catch (error) {
        console.error('❌ Webhook processing error:', error);
        res.sendStatus(500);
    }
});

// Health check endpoint
app.get('/', (req, res) => {
    res.json({
        status: 'running',
        bot: 'ChatWME',
        timestamp: new Date().toISOString(),
        sessions: userSessions.size
    });
});

// Webhook info endpoint for debugging
app.get('/webhook-info', async (req, res) => {
    try {
        const info = await bot.getWebhookInfo();
        res.json(info);
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// Start server
app.listen(PORT, '0.0.0.0', () => {
    console.log(`🌐 Server running on port ${PORT}`);
    setupWebhook();
});

// Enhanced webhook setup
async function setupWebhook() {
    try {
        // Get Railway URL from environment
        const WEBHOOK_URL = process.env.RAILWAY_STATIC_URL || 
                           process.env.RAILWAY_PUBLIC_DOMAIN || 
                           process.env.RAILWAY_URL;
        
        if (!WEBHOOK_URL) {
            console.error('❌ No Railway URL found in environment variables');
            console.log('Available env vars:', Object.keys(process.env).filter(key => key.includes('RAILWAY')));
            return;
        }
        
        console.log('🔗 Using webhook URL:', WEBHOOK_URL);
        
        // Delete existing webhook
        await bot.deleteWebhook();
        console.log('🗑️ Deleted existing webhook');
        
        // Set new webhook
        const webhookUrl = `${WEBHOOK_URL}/webhook/${BOT_TOKEN}`;
        await bot.setWebhook(webhookUrl);
        console.log('✅ Webhook set to:', webhookUrl);
        
        // Verify webhook
        const info = await bot.getWebhookInfo();
        console.log('📡 Webhook info:', info);
        
        if (info.url && info.url.includes(WEBHOOK_URL)) {
            console.log('✅ Webhook verified successfully');
        } else {
            console.error('❌ Webhook verification failed');
        }
        
    } catch (error) {
        console.error('❌ Webhook setup error:', error);
    }
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

class UserSession {
    constructor(userId) {
        this.userId = userId;
        this.conversationHistory = [];
        this.lastActivity = Date.now();
        this.language = null;
        this.messageCount = 0;
        this.createdAt = Date.now();
    }

    addMessage(role, content) {
        this.conversationHistory.push({ 
            role, 
            content, 
            timestamp: Date.now() 
        });
        
        // Keep last 8 messages for better context
        if (this.conversationHistory.length > 8) {
            this.conversationHistory = this.conversationHistory.slice(-8);
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
        
        return this.language;
    }

    getContext() {
        return this.conversationHistory
            .slice(-6)
            .map(msg => `${msg.role}: ${msg.content}`)
            .join('\n');
    }

    clearHistory() {
        this.conversationHistory = [];
        console.log(`🧹 Cleared history for user ${this.userId}`);
    }
}

// Enhanced Gemini API request with better error handling
async function makeGeminiRequest(prompt) {
    const maxRetries = GEMINI_KEYS.length * 2; // More retries
    
    for (let attempt = 0; attempt < maxRetries; attempt++) {
        try {
            const apiKey = getCurrentApiKey();
            const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:generateContent?key=${apiKey}`;
            
            console.log(`🤖 Making Gemini request (attempt ${attempt + 1})`);
            
            const response = await axios.post(url, {
                contents: [{
                    parts: [{ text: prompt }]
                }],
                generationConfig: {
                    temperature: 0.7,
                    maxOutputTokens: 1024,
                    topK: 40,
                    topP: 0.95
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
            }, {
                timeout: 30000,
                headers: {
                    'Content-Type': 'application/json'
                }
            });
            
            if (response.data.candidates && 
                response.data.candidates[0] && 
                response.data.candidates[0].content && 
                response.data.candidates[0].content.parts && 
                response.data.candidates[0].content.parts[0]) {
                
                const result = response.data.candidates[0].content.parts[0].text.trim();
                console.log('✅ Gemini response received');
                return result;
            }
            
            throw new Error('No valid response from Gemini');
            
        } catch (error) {
            console.error(`❌ Error with API key ${currentKeyIndex + 1}:`, error.message);
            
            // Handle specific errors
            if (error.response) {
                const status = error.response.status;
                const data = error.response.data;
                
                console.error(`HTTP ${status}:`, data);
                
                if (status === 429) {
                    console.log('⚠️ Rate limit hit, rotating key...');
                    rotateApiKey();
                    continue;
                } else if (status === 400) {
                    console.error('❌ Bad request to Gemini API');
                    throw new Error('Invalid request to AI service');
                } else if (status === 403) {
                    console.error('❌ API key invalid or quota exceeded');
                    rotateApiKey();
                    continue;
                }
            }
            
            if (attempt === maxRetries - 1) {
                throw new Error('All API keys failed or quota exceeded');
            }
            
            rotateApiKey();
            await new Promise(resolve => setTimeout(resolve, 1000)); // Wait 1 second
        }
    }
}

// Generate prompt
function generatePrompt(messageText, userName, session) {
    const language = session.detectLanguage(messageText);
    const context = session.getContext();
    
    const systemPrompt = `You are ChatWME, an AI assistant created by Abdou.

PERSONALITY:
- Be helpful, friendly, and conversational
- Give direct, clear answers
- Use natural language with appropriate emojis
- Be culturally aware, especially for Algerian context

LANGUAGE:
- User's preferred language: ${language === 'ar' ? 'Arabic/Algerian Darija' : 'English'}
- ALWAYS respond in ${language === 'ar' ? 'Arabic' : 'English'} only
- Be concise but informative

CONTEXT:
${context ? `Previous conversation:\n${context}\n` : ''}

USER: ${userName}
MESSAGE: ${messageText}

Respond naturally in ${language === 'ar' ? 'Arabic' : 'English'}:`;

    return systemPrompt;
}

// Start command
bot.onText(/\/start/, async (msg) => {
    const chatId = msg.chat.id;
    const userName = msg.from.first_name || 'Friend';
    
    console.log(`🚀 Start command from user ${chatId}`);
    
    try {
        // Create or get session
        let session = userSessions.get(chatId);
        if (!session) {
            session = new UserSession(chatId);
            userSessions.set(chatId, session);
        }
        
        // Detect language preference
        const language = msg.from.language_code === 'ar' ? 'ar' : 'en';
        session.language = language;
        
        const welcomeMessage = language === 'ar' ?
            `🤖 مرحباً ${userName}، أنا ChatWME!\n\n` +
            `مساعد ذكي تم إنشاؤه من قبل عبدو 👨‍💻\n\n` +
            `أستطيع:\n` +
            `💬 المحادثة الطبيعية\n` +
            `🧠 تذكر المحادثة السابقة\n` +
            `📚 الإجابة على الأسئلة\n\n` +
            `الأوامر:\n` +
            `/help - المساعدة\n` +
            `/clear - مسح المحادثة\n` +
            `/stats - الإحصائيات\n` +
            `/creator - معلومات المطور\n\n` +
            `أرسل لي أي رسالة! 🚀` :
            
            `🤖 Hello ${userName}, I'm ChatWME!\n\n` +
            `An AI assistant created by Abdou 👨‍💻\n\n` +
            `I can:\n` +
            `💬 Natural conversation\n` +
            `🧠 Remember previous conversation\n` +
            `📚 Answer questions\n\n` +
            `Commands:\n` +
            `/help - Show help\n` +
            `/clear - Clear conversation\n` +
            `/stats - Show statistics\n` +
            `/creator - Creator info\n\n` +
            `Send me any message! 🚀`;
        
        await bot.sendMessage(chatId, welcomeMessage, {
            reply_markup: {
                inline_keyboard: [
                    [{ text: '👤 Meet Abdou', url: 'https://www.facebook.com/abdou.tsu.446062' }]
                ]
            }
        });
        
        console.log(`✅ Start message sent to user ${chatId}`);
        
    } catch (error) {
        console.error('❌ Error in start command:', error);
        await bot.sendMessage(chatId, 'Error starting bot. Please try again.');
    }
});

// Help command
bot.onText(/\/help/, async (msg) => {
    const chatId = msg.chat.id;
    const session = userSessions.get(chatId);
    const language = session && session.language ? session.language : 'en';
    
    try {
        const helpMessage = language === 'ar' ?
            `🆘 مساعدة ChatWME\n\n` +
            `الأوامر:\n` +
            `• /start - بدء المحادثة\n` +
            `• /help - عرض المساعدة\n` +
            `• /clear - مسح المحادثة\n` +
            `• /stats - الإحصائيات\n` +
            `• /creator - معلومات المطور\n\n` +
            `المميزات:\n` +
            `✅ محادثة طبيعية\n` +
            `✅ تذكر السياق\n` +
            `✅ إجابات مباشرة\n\n` +
            `تحدث معي بشكل طبيعي!` :
            
            `🆘 ChatWME Help\n\n` +
            `Commands:\n` +
            `• /start - Start conversation\n` +
            `• /help - Show help\n` +
            `• /clear - Clear conversation\n` +
            `• /stats - Show statistics\n` +
            `• /creator - Creator info\n\n` +
            `Features:\n` +
            `✅ Natural conversation\n` +
            `✅ Context memory\n` +
            `✅ Direct answers\n\n` +
            `Talk to me naturally!`;
        
        await bot.sendMessage(chatId, helpMessage);
        
    } catch (error) {
        console.error('❌ Error in help command:', error);
        await bot.sendMessage(chatId, 'Error showing help.');
    }
});

// Clear command
bot.onText(/\/clear/, async (msg) => {
    const chatId = msg.chat.id;
    const session = userSessions.get(chatId);
    
    try {
        if (session) {
            session.clearHistory();
            const language = session.language || 'en';
            
            const clearMessage = language === 'ar' ?
                `🧹 تم مسح تاريخ المحادثة!\n\nيمكنك بدء محادثة جديدة 🚀` :
                `🧹 Conversation history cleared!\n\nYou can start fresh 🚀`;
            
            await bot.sendMessage(chatId, clearMessage);
        } else {
            await bot.sendMessage(chatId, 'No conversation to clear.');
        }
        
    } catch (error) {
        console.error('❌ Error in clear command:', error);
        await bot.sendMessage(chatId, 'Error clearing conversation.');
    }
});

// Stats command
bot.onText(/\/stats/, async (msg) => {
    const chatId = msg.chat.id;
    const session = userSessions.get(chatId);
    
    try {
        if (session) {
            const language = session.language || 'en';
            const uptime = Math.floor((Date.now() - session.createdAt) / 1000);
            const hours = Math.floor(uptime / 3600);
            const minutes = Math.floor((uptime % 3600) / 60);
            
            const statsMessage = language === 'ar' ?
                `📊 الإحصائيات\n\n` +
                `💬 الرسائل: ${session.messageCount}\n` +
                `🕐 المدة: ${hours}س ${minutes}دق\n` +
                `🌐 اللغة: ${session.language === 'ar' ? 'العربية' : 'الإنجليزية'}\n` +
                `🧠 الذاكرة: ${session.conversationHistory.length} رسالة\n` +
                `📱 الجلسات النشطة: ${userSessions.size}` :
                
                `📊 Statistics\n\n` +
                `💬 Messages: ${session.messageCount}\n` +
                `🕐 Duration: ${hours}h ${minutes}m\n` +
                `🌐 Language: ${session.language === 'ar' ? 'Arabic' : 'English'}\n` +
                `🧠 Memory: ${session.conversationHistory.length} messages\n` +
                `📱 Active sessions: ${userSessions.size}`;
            
            await bot.sendMessage(chatId, statsMessage);
        } else {
            await bot.sendMessage(chatId, 'No statistics available.');
        }
        
    } catch (error) {
        console.error('❌ Error in stats command:', error);
        await bot.sendMessage(chatId, 'Error showing statistics.');
    }
});

// Creator command
bot.onText(/\/creator/, async (msg) => {
    const chatId = msg.chat.id;
    const session = userSessions.get(chatId);
    const language = session && session.language ? session.language : 'en';
    
    try {
        const creatorMessage = language === 'ar' ?
            `👨‍💻 معلومات المطور\n\n` +
            `الاسم: عبدو\n` +
            `البوت: ChatWME\n` +
            `المهارات: تطوير الذكاء الاصطناعي\n` +
            `الموقع: الجزائر 🇩🇿\n\n` +
            `تواصل معه على الفيسبوك!` :
            
            `👨‍💻 Creator Information\n\n` +
            `Name: Abdou\n` +
            `Bot: ChatWME\n` +
            `Skills: AI Development\n` +
            `Location: Algeria 🇩🇿\n\n` +
            `Connect with him on Facebook!`;
        
        await bot.sendMessage(chatId, creatorMessage, {
            reply_markup: {
                inline_keyboard: [[{
                    text: '📘 Facebook',
                    url: 'https://www.facebook.com/abdou.tsu.446062'
                }]]
            }
        });
        
    } catch (error) {
        console.error('❌ Error in creator command:', error);
        await bot.sendMessage(chatId, 'Error showing creator info.');
    }
});

// Handle all other messages
bot.on('message', async (msg) => {
    const chatId = msg.chat.id;
    const userName = msg.from.first_name || 'Friend';
    const messageId = msg.message_id;
    
    console.log(`📨 Message from user ${chatId}: ${msg.text}`);
    
    try {
        // Skip if it's a command
        if (msg.text && msg.text.startsWith('/')) {
            return;
        }
        
        // Handle only text messages
        if (!msg.text) {
            const session = userSessions.get(chatId);
            const language = session && session.language ? session.language : 'en';
            
            const notSupportedMessage = language === 'ar' ?
                'أعالج الرسائل النصية فقط. أرسل رسالة نصية! 📝' :
                'I only process text messages. Send a text message! 📝';
            
            await bot.sendMessage(chatId, notSupportedMessage);
            return;
        }
        
        // Get or create user session
        let session = userSessions.get(chatId);
        if (!session) {
            session = new UserSession(chatId);
            userSessions.set(chatId, session);
        }
        
        // Add user message to history
        session.addMessage('user', msg.text);
        
        // Generate prompt and get response
        const prompt = generatePrompt(msg.text, userName, session);
        
        // Send typing indicator
        await bot.sendChatAction(chatId, 'typing');
        
        // Get response from Gemini
        const response = await makeGeminiRequest(prompt);
        
        // Add response to history
        session.addMessage('assistant', response);
        
        // Send response
        await bot.sendMessage(chatId, response, {
            reply_to_message_id: messageId
        });
        
        console.log(`✅ Response sent to user ${chatId}`);
        
    } catch (error) {
        console.error('❌ Error handling message:', error);
        
        const session = userSessions.get(chatId);
        const language = session && session.language ? session.language : 'en';
        
        const errorMessage = language === 'ar' ?
            'عذراً، حدث خطأ. حاول مرة أخرى 🔄' :
            'Sorry, error occurred. Try again 🔄';
        
        await bot.sendMessage(chatId, errorMessage);
    }
});

// Enhanced error handling
bot.on('error', (error) => {
    console.error('❌ Bot error:', error);
});

bot.on('polling_error', (error) => {
    console.error('❌ Polling error:', error);
});

// Cleanup old sessions
setInterval(() => {
    const now = Date.now();
    let cleanedCount = 0;
    
    for (const [chatId, session] of userSessions.entries()) {
        if (now - session.lastActivity > 3600000) { // 1 hour
            userSessions.delete(chatId);
            cleanedCount++;
        }
    }
    
    if (cleanedCount > 0) {
        console.log(`🧹 Cleaned ${cleanedCount} sessions. Active: ${userSessions.size}`);
    }
}, 1800000); // 30 minutes

// Graceful shutdown
process.on('SIGINT', async () => {
    console.log('🛑 Shutting down gracefully...');
    try {
        await bot.deleteWebhook();
        console.log('🗑️ Webhook deleted');
    } catch (error) {
        console.error('❌ Error during shutdown:', error);
    }
    process.exit(0);
});

console.log('🚀 ChatWME bot started!');
console.log('🤖 Created by Abdou');
console.log('✅ Ready for messages!');

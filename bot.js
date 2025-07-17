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

// Initialize Express app first
const app = express();
app.use(express.json());

// Initialize bot for Railway webhook
const bot = new TelegramBot(BOT_TOKEN, { polling: false });

// Health check endpoint
app.get('/', (req, res) => {
    res.json({ 
        status: 'ok', 
        message: 'ChatWME Bot is running!',
        timestamp: new Date().toISOString()
    });
});

// Webhook endpoint
app.post(`/webhook/${BOT_TOKEN}`, (req, res) => {
    try {
        bot.processUpdate(req.body);
        res.sendStatus(200);
    } catch (error) {
        console.error('❌ Webhook processing error:', error);
        res.sendStatus(500);
    }
});

// Start server
const server = app.listen(PORT, '0.0.0.0', () => {
    console.log(`🌐 Server running on port ${PORT}`);
});

// Graceful shutdown
process.on('SIGTERM', () => {
    console.log('🛑 SIGTERM received, shutting down gracefully...');
    server.close(() => {
        console.log('✅ Server closed');
        process.exit(0);
    });
});

process.on('SIGINT', () => {
    console.log('🛑 SIGINT received, shutting down gracefully...');
    server.close(() => {
        console.log('✅ Server closed');
        process.exit(0);
    });
});

// Set webhook for Railway - with better error handling
async function setupWebhook() {
    try {
        const WEBHOOK_URL = process.env.RAILWAY_STATIC_URL || process.env.RAILWAY_URL;
        
        if (!WEBHOOK_URL) {
            console.error('❌ No Railway URL found. Please check your Railway deployment.');
            return;
        }

        const webhookUrl = `${WEBHOOK_URL}/webhook/${BOT_TOKEN}`;
        console.log(`🔗 Setting webhook to: ${webhookUrl}`);
        
        await bot.setWebHook(webhookUrl);
        console.log('✅ Webhook set successfully');
        
        // Verify webhook
        const webhookInfo = await bot.getWebHookInfo();
        console.log('📋 Webhook info:', {
            url: webhookInfo.url,
            has_custom_certificate: webhookInfo.has_custom_certificate,
            pending_update_count: webhookInfo.pending_update_count
        });
        
    } catch (error) {
        console.error('❌ Webhook setup error:', error.message);
        // Don't exit, try to continue
    }
}

// Setup webhook after server starts
setTimeout(setupWebhook, 3000);

// Simple API key rotation
let currentKeyIndex = 0;
const getCurrentApiKey = () => GEMINI_KEYS[currentKeyIndex];
const rotateApiKey = () => {
    currentKeyIndex = (currentKeyIndex + 1) % GEMINI_KEYS.length;
    console.log(`🔄 Rotated to API key ${currentKeyIndex + 1}`);
};

// Simple user sessions
const userSessions = new Map();

class UserSession {
    constructor(userId) {
        this.userId = userId;
        this.conversationHistory = [];
        this.lastActivity = Date.now();
    }

    addMessage(role, content) {
        this.conversationHistory.push({ role, content });
        // Keep only last 6 messages
        if (this.conversationHistory.length > 6) {
            this.conversationHistory = this.conversationHistory.slice(-6);
        }
        this.lastActivity = Date.now();
    }

    getContext() {
        return this.conversationHistory
            .map(msg => `${msg.role}: ${msg.content}`)
            .join('\n');
    }

    detectLanguage(text) {
        const arabicPattern = /[\u0600-\u06FF]/;
        return arabicPattern.test(text) ? 'ar' : 'en';
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
                    temperature: 0.7,
                    maxOutputTokens: 1024
                }
            }, {
                timeout: 30000,
                headers: {
                    'Content-Type': 'application/json'
                }
            });
            
            if (response.data.candidates?.[0]?.content?.parts?.[0]?.text) {
                return response.data.candidates[0].content.parts[0].text;
            }
            
            throw new Error('No valid response from Gemini');
            
        } catch (error) {
            console.error(`❌ Error with API key ${currentKeyIndex + 1}:`, error.message);
            
            if (error.response?.status === 429) {
                console.log('⚠️ Rate limit hit, rotating key...');
                rotateApiKey();
                continue;
            }
            
            if (error.response?.status === 400) {
                console.error('❌ Bad request to Gemini API:', error.response?.data);
                throw new Error('Invalid request to Gemini API');
            }
            
            if (attempt === maxRetries - 1) {
                throw error;
            }
            
            rotateApiKey();
            await new Promise(resolve => setTimeout(resolve, 1000)); // Wait 1 second before retry
        }
    }
}

// Generate prompt based on user message
function generatePrompt(messageText, userName, session) {
    const language = session.detectLanguage(messageText);
    const context = session.getContext();
    
    const systemPrompt = `You are ChatWME, an AI assistant created by Abdou.

PERSONALITY:
- Friendly and helpful
- Culturally aware (especially Algerian context)
- Conversational and engaging

LANGUAGE:
- Respond in ${language === 'ar' ? 'Arabic/Algerian Darija' : 'English'}
- Use emojis naturally
- Be concise but informative

CONTEXT:
${context ? `Previous conversation:\n${context}\n` : ''}

USER: ${userName}
MESSAGE: ${messageText}

Respond appropriately:`;

    return systemPrompt;
}

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
        
        // Handle creator queries
        const creatorQueries = [
            'who made you', 'who created you', 'your creator', 'developer',
            'من صنعك', 'من عملك', 'شكون صنعك', 'مطورك'
        ];
        
        if (creatorQueries.some(query => messageText.toLowerCase().includes(query))) {
            const creatorMessage = session.detectLanguage(messageText) === 'ar' ?
                `👨‍💻 تم إنشائي من قبل **عبدو**!\n\nمطور موهوب قام ببنائي لمساعدتك. يمكنك زيارة صفحته على Facebook! 🚀` :
                `👨‍💻 I was created by **Abdou**!\n\nA talented developer who built me to help you. You can visit his Facebook page! 🚀`;
            
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
            reply_to_message_id: messageId
        });
        
    } catch (error) {
        console.error('❌ Error handling message:', error);
        
        const errorMessage = session?.detectLanguage(messageText) === 'ar' ?
            'عذراً، حدث خطأ. حاول مرة أخرى.' :
            'Sorry, I encountered an error. Please try again.';
        
        try {
            await bot.sendMessage(chatId, errorMessage);
        } catch (sendError) {
            console.error('❌ Error sending error message:', sendError);
        }
    }
}

// Handle all messages
bot.on('message', async (msg) => {
    const chatId = msg.chat.id;
    const userName = msg.from.first_name || 'Friend';
    const messageId = msg.message_id;
    
    console.log(`📨 Message from ${userName} (${chatId}): ${msg.text || 'non-text'}`);
    
    try {
        if (msg.text) {
            await handleTextMessage(chatId, msg.text, userName, messageId);
        } else {
            // Handle non-text messages
            const notSupportedMessage = 'I only process text messages for now. Please send me a text message! / أعالج الرسائل النصية فقط حالياً. أرسل لي رسالة نصية!';
            await bot.sendMessage(chatId, notSupportedMessage);
        }
    } catch (error) {
        console.error('❌ Error in message handler:', error);
        try {
            await bot.sendMessage(chatId, 'An error occurred. Please try again. / حدث خطأ. حاول مرة أخرى.');
        } catch (sendError) {
            console.error('❌ Error sending error message:', sendError);
        }
    }
});

// Start command
bot.onText(/\/start/, async (msg) => {
    const chatId = msg.chat.id;
    const userName = msg.from.first_name || 'Friend';
    
    console.log(`🚀 Start command from ${userName} (${chatId})`);
    
    const welcomeMessage = `🤖 **مرحباً ${userName}، أنا ChatWME!**\n\n` +
                          `مساعد ذكي يمكنني المحادثة معك بالعربية والإنجليزية 💬\n\n` +
                          `---\n\n` +
                          `🤖 **Hello ${userName}, I'm ChatWME!**\n\n` +
                          `An AI assistant that can chat with you in Arabic and English 💬\n\n` +
                          `💡 **أرسل لي أي رسالة وسأجيبك! / Send me any message and I'll respond!**`;
    
    try {
        await bot.sendMessage(chatId, welcomeMessage, {
            parse_mode: 'Markdown',
            reply_markup: {
                inline_keyboard: [
                    [{ text: '👤 Meet Abdou (Creator)', url: 'https://www.facebook.com/abdou.tsu.446062' }]
                ]
            }
        });
    } catch (error) {
        console.error('❌ Error sending start message:', error);
    }
});

// Help command
bot.onText(/\/help/, async (msg) => {
    const chatId = msg.chat.id;
    
    const helpMessage = `🆘 **ChatWME Help**\n\n` +
                       `**Commands:**\n` +
                       `• /start - Start conversation\n` +
                       `• /help - Show this help\n` +
                       `• /creator - Creator info\n\n` +
                       `**What I can do:**\n` +
                       `✅ Chat in Arabic and English\n` +
                       `✅ Remember conversation context\n` +
                       `✅ Understand Algerian Darija\n\n` +
                       `**Tips:**\n` +
                       `• Write in any language\n` +
                       `• Ask me anything!\n` +
                       `• I'll respond in your language`;
    
    try {
        await bot.sendMessage(chatId, helpMessage, { parse_mode: 'Markdown' });
    } catch (error) {
        console.error('❌ Error sending help message:', error);
    }
});

// Creator command
bot.onText(/\/creator/, async (msg) => {
    const chatId = msg.chat.id;
    
    const creatorMessage = `👨‍💻 **Creator Information**\n\n` +
                          `**Name:** Abdou\n` +
                          `**Bot:** ChatWME\n` +
                          `**Skills:** AI Development, Telegram Bots\n` +
                          `**Location:** Algeria\n\n` +
                          `Connect with Abdou on Facebook!`;
    
    try {
        await bot.sendMessage(chatId, creatorMessage, {
            parse_mode: 'Markdown',
            reply_markup: {
                inline_keyboard: [[{
                    text: '📘 Visit Facebook',
                    url: 'https://www.facebook.com/abdou.tsu.446062'
                }]]
            }
        });
    } catch (error) {
        console.error('❌ Error sending creator message:', error);
    }
});

// Error handling
bot.on('error', (error) => {
    console.error('❌ Bot error:', error);
});

bot.on('webhook_error', (error) => {
    console.error('❌ Webhook error:', error);
});

// Cleanup old sessions every hour
setInterval(() => {
    const now = Date.now();
    for (const [chatId, session] of userSessions.entries()) {
        if (now - session.lastActivity > 3600000) { // 1 hour
            userSessions.delete(chatId);
        }
    }
    console.log(`🧹 Cleaned up old sessions. Active sessions: ${userSessions.size}`);
}, 3600000);

console.log('🚀 ChatWME bot started successfully!');
console.log('🤖 Created by Abdou');
console.log('✅ Ready for text messages only!');
console.log(`🔧 Environment: ${process.env.NODE_ENV || 'development'}`);
console.log(`📊 Available Gemini API keys: ${GEMINI_KEYS.length}`);

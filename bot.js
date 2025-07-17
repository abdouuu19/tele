bot.js
11.30 KB •332 lines
•
Formatting may be inconsistent from source
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
    res.send('ChatWME Bot is running!');
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

// Gemini API request
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
                timeout: 30000
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
            
            if (attempt === maxRetries - 1) {
                throw error;
            }
            
            rotateApiKey();
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
        
        const errorMessage = 'Sorry, I encountered an error. Please try again. / عذراً، حدث خطأ. حاول مرة أخرى.';
        await bot.sendMessage(chatId, errorMessage);
    }
}

// Handle all messages
bot.on('message', async (msg) => {
    const chatId = msg.chat.id;
    const userName = msg.from.first_name || 'Friend';
    const messageId = msg.message_id;
    
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
        await bot.sendMessage(chatId, 'An error occurred. Please try again. / حدث خطأ. حاول مرة أخرى.');
    }
});

// Start command
bot.onText(/\/start/, async (msg) => {
    const chatId = msg.chat.id;
    const userName = msg.from.first_name || 'Friend';
    
    const welcomeMessage = `🤖 **مرحباً ${userName}، أنا ChatWME!**\n\n` +
                          `مساعد ذكي يمكنني المحادثة معك بالعربية والإنجليزية 💬\n\n` +
                          `---\n\n` +
                          `🤖 **Hello ${userName}, I'm ChatWME!**\n\n` +
                          `An AI assistant that can chat with you in Arabic and English 💬\n\n` +
                          `💡 **أرسل لي أي رسالة وسأجيبك! / Send me any message and I'll respond!**`;
    
    await bot.sendMessage(chatId, welcomeMessage, {
        parse_mode: 'Markdown',
        reply_markup: {
            inline_keyboard: [
                [{ text: '👤 Meet Abdou (Creator)', url: 'https://www.facebook.com/abdou.tsu.446062' }]
            ]
        }
    });
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
    
    await bot.sendMessage(chatId, helpMessage, { parse_mode: 'Markdown' });
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
    
    await bot.sendMessage(chatId, creatorMessage, {
        parse_mode: 'Markdown',
        reply_markup: {
            inline_keyboard: [[{
                text: '📘 Visit Facebook',
                url: 'https://www.facebook.com/abdou.tsu.446062'
            }]]
        }
    });
});

// Error handling
bot.on('error', (error) => {
    console.error('❌ Bot error:', error);
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

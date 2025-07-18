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
        this.preferredLanguage = 'auto'; // auto, en, ar
        this.messageCount = 0;
    }

    addMessage(role, content) {
        this.conversationHistory.push({ role, content });
        // Keep only last 6 messages
        if (this.conversationHistory.length > 6) {
            this.conversationHistory = this.conversationHistory.slice(-6);
        }
        this.lastActivity = Date.now();
        this.messageCount++;
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

    clearHistory() {
        this.conversationHistory = [];
    }

    getStats() {
        return {
            messageCount: this.messageCount,
            conversationLength: this.conversationHistory.length,
            lastActivity: this.lastActivity,
            preferredLanguage: this.preferredLanguage
        };
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
                          `💡 **أرسل لي أي رسالة وسأجيبك! / Send me any message and I'll respond!**\n\n` +
                          `📋 **Use /help to see all available commands**`;
    
    await bot.sendMessage(chatId, welcomeMessage, {
        parse_mode: 'Markdown',
        reply_markup: {
            inline_keyboard: [
                [{ text: '📋 Commands', callback_data: 'show_commands' }],
                [{ text: '👤 Meet Abdou (Creator)', url: 'https://www.facebook.com/abdou.tsu.446062' }]
            ]
        }
    });
});

// Help command
bot.onText(/\/help/, async (msg) => {
    const chatId = msg.chat.id;
    
    const helpMessage = `🆘 **ChatWME Help**\n\n` +
                       `**📋 Available Commands:**\n` +
                       `• /start - Start conversation\n` +
                       `• /help - Show this help menu\n` +
                       `• /creator - Creator information\n` +
                       `• /about - About ChatWME\n` +
                       `• /clear - Clear conversation history\n` +
                       `• /stats - Your usage statistics\n` +
                       `• /language - Set preferred language\n` +
                       `• /tips - Usage tips and tricks\n` +
                       `• /support - Get support\n` +
                       `• /feedback - Send feedback\n\n` +
                       `**✨ What I can do:**\n` +
                       `✅ Chat in Arabic and English\n` +
                       `✅ Remember conversation context\n` +
                       `✅ Understand Algerian Darija\n` +
                       `✅ Answer questions on various topics\n` +
                       `✅ Help with translations\n` +
                       `✅ Provide explanations and assistance\n\n` +
                       `**💡 Tips:**\n` +
                       `• Write in any language I support\n` +
                       `• Ask me anything!\n` +
                       `• I'll respond in your language\n` +
                       `• Use /clear to reset our conversation`;
    
    await bot.sendMessage(chatId, helpMessage, { parse_mode: 'Markdown' });
});

// Creator command
bot.onText(/\/creator/, async (msg) => {
    const chatId = msg.chat.id;
    
    const creatorMessage = `👨‍💻 **Creator Information**\n\n` +
                          `**Name:** Abdou\n` +
                          `**Bot:** ChatWME\n` +
                          `**Skills:** AI Development, Telegram Bots\n` +
                          `**Location:** Algeria 🇩🇿\n` +
                          `**Specialty:** Building intelligent conversational bots\n\n` +
                          `💪 **Abdou's Vision:**\n` +
                          `Creating AI assistants that understand and serve the Arabic-speaking community, especially Algerians.\n\n` +
                          `🔗 **Connect with Abdou:**`;
    
    await bot.sendMessage(chatId, creatorMessage, {
        parse_mode: 'Markdown',
        reply_markup: {
            inline_keyboard: [
                [{ text: '📘 Visit Facebook', url: 'https://www.facebook.com/abdou.tsu.446062' }],
                [{ text: '💬 Chat with Creator', callback_data: 'contact_creator' }]
            ]
        }
    });
});

// About command
bot.onText(/\/about/, async (msg) => {
    const chatId = msg.chat.id;
    
    const aboutMessage = `🤖 **About ChatWME**\n\n` +
                        `**Version:** 1.0\n` +
                        `**Created by:** Abdou\n` +
                        `**Language Support:** Arabic, English, Algerian Darija\n` +
                        `**AI Model:** Google Gemini 1.5 Flash\n\n` +
                        `**🎯 Purpose:**\n` +
                        `ChatWME is designed to provide intelligent conversation assistance in both Arabic and English, with special focus on Algerian culture and dialect.\n\n` +
                        `**🌟 Features:**\n` +
                        `• Bilingual conversation support\n` +
                        `• Context-aware responses\n` +
                        `• Cultural sensitivity\n` +
                        `• Fast and reliable responses\n` +
                        `• User-friendly interface\n\n` +
                        `**🚀 Technology:**\n` +
                        `Built with Node.js, powered by Google Gemini AI, and hosted on Railway for 24/7 availability.`;
    
    await bot.sendMessage(chatId, aboutMessage, { parse_mode: 'Markdown' });
});

// Clear conversation command
bot.onText(/\/clear/, async (msg) => {
    const chatId = msg.chat.id;
    
    const session = userSessions.get(chatId);
    if (session) {
        session.clearHistory();
        const clearMessage = `🧹 **Conversation Cleared!**\n\n` +
                           `Your conversation history has been reset. We can start fresh now!\n\n` +
                           `تم مسح تاريخ المحادثة! يمكننا البدء من جديد الآن!`;
        await bot.sendMessage(chatId, clearMessage, { parse_mode: 'Markdown' });
    } else {
        await bot.sendMessage(chatId, 'No conversation history to clear. / لا يوجد تاريخ محادثة لمسحه.');
    }
});

// Stats command
bot.onText(/\/stats/, async (msg) => {
    const chatId = msg.chat.id;
    
    const session = userSessions.get(chatId);
    if (session) {
        const stats = session.getStats();
        const lastActivity = new Date(stats.lastActivity).toLocaleString();
        
        const statsMessage = `📊 **Your ChatWME Statistics**\n\n` +
                           `**Messages Sent:** ${stats.messageCount}\n` +
                           `**Conversation Length:** ${stats.conversationLength} messages\n` +
                           `**Last Activity:** ${lastActivity}\n` +
                           `**Preferred Language:** ${stats.preferredLanguage}\n\n` +
                           `**Active Sessions:** ${userSessions.size} users\n\n` +
                           `Thank you for using ChatWME! 🙏`;
        
        await bot.sendMessage(chatId, statsMessage, { parse_mode: 'Markdown' });
    } else {
        await bot.sendMessage(chatId, 'No statistics available. Start chatting to generate stats! / لا توجد إحصائيات متاحة. ابدأ المحادثة لإنشاء إحصائيات!');
    }
});

// Language command
bot.onText(/\/language/, async (msg) => {
    const chatId = msg.chat.id;
    
    await bot.sendMessage(chatId, '🌐 **Choose Your Preferred Language:**\n\nاختر لغتك المفضلة:', {
        parse_mode: 'Markdown',
        reply_markup: {
            inline_keyboard: [
                [{ text: '🇺🇸 English', callback_data: 'lang_en' }],
                [{ text: '🇩🇿 العربية', callback_data: 'lang_ar' }],
                [{ text: '🔄 Auto-detect', callback_data: 'lang_auto' }]
            ]
        }
    });
});

// Tips command
bot.onText(/\/tips/, async (msg) => {
    const chatId = msg.chat.id;
    
    const tipsMessage = `💡 **ChatWME Usage Tips**\n\n` +
                       `**🗣️ Language Tips:**\n` +
                       `• I understand both Arabic and English\n` +
                       `• You can mix languages in one message\n` +
                       `• I recognize Algerian Darija expressions\n\n` +
                       `**💬 Conversation Tips:**\n` +
                       `• Be specific in your questions\n` +
                       `• I remember our last 6 messages\n` +
                       `• Use /clear to reset conversation\n\n` +
                       `**⚡ Performance Tips:**\n` +
                       `• I respond faster to shorter messages\n` +
                       `• One question at a time works best\n` +
                       `• Use commands for specific functions\n\n` +
                       `**🎯 Best Practices:**\n` +
                       `• Ask follow-up questions\n` +
                       `• Provide context when needed\n` +
                       `• Use /help if you're stuck`;
    
    await bot.sendMessage(chatId, tipsMessage, { parse_mode: 'Markdown' });
});

// Support command
bot.onText(/\/support/, async (msg) => {
    const chatId = msg.chat.id;
    
    const supportMessage = `🆘 **ChatWME Support**\n\n` +
                          `**Need Help?**\n` +
                          `If you're experiencing issues or need assistance:\n\n` +
                          `**📧 Contact Methods:**\n` +
                          `• Use /feedback to report issues\n` +
                          `• Contact creator directly via Facebook\n` +
                          `• Use /help for command assistance\n\n` +
                          `**🔧 Common Issues:**\n` +
                          `• Bot not responding: Wait a moment and try again\n` +
                          `• Wrong language: Use /language to set preference\n` +
                          `• Conversation issues: Use /clear to reset\n\n` +
                          `**⏰ Response Time:**\n` +
                          `Usually within a few seconds. If delayed, please wait or try again.\n\n` +
                          `**🤝 Community Support:**\n` +
                          `Connect with other users and the creator on Facebook!`;
    
    await bot.sendMessage(chatId, supportMessage, {
        parse_mode: 'Markdown',
        reply_markup: {
            inline_keyboard: [
                [{ text: '📧 Send Feedback', callback_data: 'send_feedback' }],
                [{ text: '👤 Contact Creator', url: 'https://www.facebook.com/abdou.tsu.446062' }]
            ]
        }
    });
});

// Feedback command
bot.onText(/\/feedback/, async (msg) => {
    const chatId = msg.chat.id;
    
    const feedbackMessage = `📝 **Send Feedback**\n\n` +
                           `**Your feedback helps improve ChatWME!**\n\n` +
                           `**How to send feedback:**\n` +
                           `Simply type your message starting with "Feedback:" followed by your comments.\n\n` +
                           `**Example:**\n` +
                           `Feedback: The bot is great but could be faster\n\n` +
                           `**What to include:**\n` +
                           `• Bug reports\n` +
                           `• Feature suggestions\n` +
                           `• General comments\n` +
                           `• Language improvements\n\n` +
                           `**🙏 Thank you for helping make ChatWME better!**`;
    
    await bot.sendMessage(chatId, feedbackMessage, {
        parse_mode: 'Markdown',
        reply_markup: {
            inline_keyboard: [
                [{ text: '👤 Contact Creator Directly', url: 'https://www.facebook.com/abdou.tsu.446062' }]
            ]
        }
    });
});

// Handle callback queries
bot.on('callback_query', async (callbackQuery) => {
    const chatId = callbackQuery.message.chat.id;
    const data = callbackQuery.data;
    
    await bot.answerCallbackQuery(callbackQuery.id);
    
    switch (data) {
        case 'show_commands':
            await bot.sendMessage(chatId, 'Use /help to see all available commands and features!');
            break;
            
        case 'contact_creator':
            await bot.sendMessage(chatId, 'You can contact Abdou directly through his Facebook page or send feedback using /feedback command!');
            break;
            
        case 'lang_en':
            let session = userSessions.get(chatId);
            if (!session) {
                session = new UserSession(chatId);
                userSessions.set(chatId, session);
            }
            session.preferredLanguage = 'en';
            await bot.sendMessage(chatId, '🇺🇸 **Language set to English!**\n\nI will now respond primarily in English.');
            break;
            
        case 'lang_ar':
            session = userSessions.get(chatId);
            if (!session) {
                session = new UserSession(chatId);
                userSessions.set(chatId, session);
            }
            session.preferredLanguage = 'ar';
            await bot.sendMessage(chatId, '🇩🇿 **تم تعيين اللغة إلى العربية!**\n\nسأرد الآن بشكل أساسي باللغة العربية.');
            break;
            
        case 'lang_auto':
            session = userSessions.get(chatId);
            if (!session) {
                session = new UserSession(chatId);
                userSessions.set(chatId, session);
            }
            session.preferredLanguage = 'auto';
            await bot.sendMessage(chatId, '🔄 **Auto-detection enabled!**\n\nI will detect and respond in your message language.\n\nتم تفعيل الكشف التلقائي! سأكتشف وأرد بلغة رسالتك.');
            break;
            
        case 'send_feedback':
            await bot.sendMessage(chatId, 'Please send your feedback by typing: "Feedback: [your message]"');
            break;
    }
});

// Handle feedback messages
bot.on('message', async (msg) => {
    if (msg.text && msg.text.toLowerCase().startsWith('feedback:')) {
        const chatId = msg.chat.id;
        const userName = msg.from.first_name || 'User';
        const feedback = msg.text.substring(9).trim();
        
        // Here you could log feedback or send it to a specific channel
        console.log(`📝 Feedback from ${userName} (${chatId}): ${feedback}`);
        
        await bot.sendMessage(chatId, `✅ **Thank you for your feedback!**\n\nYour message has been received and will help improve ChatWME.\n\nشكراً لك على ملاحظاتك! تم استلام رسالتك وستساعد في تحسين ChatWME.`, {
            parse_mode: 'Markdown'
        });
    }
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

// Set bot commands for Telegram UI
const commands = [
    { command: 'start', description: 'Start conversation with ChatWME' },
    { command: 'help', description: 'Show help menu and available commands' },
    { command: 'creator', description: 'Information about the bot creator' },
    { command: 'about', description: 'About ChatWME bot' },
    { command: 'clear', description: 'Clear conversation history' },
    { command: 'stats', description: 'View your usage statistics' },
    { command: 'language', description: 'Set preferred language' },
    { command: 'tips', description: 'Usage tips and tricks' },
    { command: 'support', description: 'Get support and help' },
    { command: 'feedback', description: 'Send feedback to improve the bot' }
];

// Set commands in Telegram
bot.setMyCommands(commands)
    .then(() => console.log('✅ Bot commands set successfully'))
    .catch(err => console.error('❌ Error setting commands:', err));

console.log('🚀 ChatWME bot started successfully!');
console.log('🤖 Created by Abdou');
console.log('✅ Ready with enhanced commands and features!');
console.log('📋 Available commands:', commands.map(cmd => `/${cmd.command}`).join(', '));

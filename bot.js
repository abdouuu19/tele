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
const CREATOR_TELEGRAM = 'https://t.me/Uknowmeabdou';
const CREATOR_FACEBOOK = 'https://www.facebook.com/abdou.tsu.446062';

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

// Enhanced API key rotation with error tracking
let currentKeyIndex = 0;
const keyUsageStats = GEMINI_KEYS.map(() => ({ requests: 0, errors: 0, lastError: null }));

const getCurrentApiKey = () => GEMINI_KEYS[currentKeyIndex];
const rotateApiKey = () => {
    currentKeyIndex = (currentKeyIndex + 1) % GEMINI_KEYS.length;
    console.log(`🔄 Rotated to API key ${currentKeyIndex + 1}`);
};

// Enhanced User Session Management
class UserSession {
    constructor(userId) {
        this.userId = userId;
        this.conversationHistory = [];
        this.lastActivity = Date.now();
        this.preferredLanguage = 'auto';
        this.messageCount = 0;
        this.personality = 'friendly';
        this.interests = [];
        this.created = Date.now();
        this.contextKeywords = new Set();
    }

    addMessage(role, content) {
        this.conversationHistory.push({
            role,
            content,
            timestamp: Date.now()
        });
        
        // Keep only last 12 messages for better context
        if (this.conversationHistory.length > 12) {
            this.conversationHistory = this.conversationHistory.slice(-12);
        }
        
        this.lastActivity = Date.now();
        this.messageCount++;
        
        // Extract keywords for better context
        this.extractKeywords(content);
    }

    extractKeywords(text) {
        const keywords = text.toLowerCase().match(/\b\w{3,}\b/g) || [];
        keywords.forEach(keyword => {
            if (keyword.length > 3) {
                this.contextKeywords.add(keyword);
            }
        });
        
        // Keep only recent keywords (max 50)
        if (this.contextKeywords.size > 50) {
            const keywordsArray = Array.from(this.contextKeywords);
            this.contextKeywords = new Set(keywordsArray.slice(-50));
        }
    }

    getContext() {
        return this.conversationHistory
            .slice(-8) // Use last 8 messages for context
            .map(msg => `${msg.role}: ${msg.content}`)
            .join('\n');
    }

    detectLanguage(text) {
        const arabicPattern = /[\u0600-\u06FF]/;
        const frenchPattern = /[àâäéèêëïîôöùûüÿç]/i;
        const englishPattern = /[a-zA-Z]/;
        
        if (arabicPattern.test(text)) return 'ar';
        if (frenchPattern.test(text) && !englishPattern.test(text)) return 'fr';
        return 'en';
    }

    clearHistory() {
        this.conversationHistory = [];
        this.contextKeywords.clear();
        this.lastActivity = Date.now();
    }

    getStats() {
        return {
            messageCount: this.messageCount,
            conversationLength: this.conversationHistory.length,
            lastActivity: this.lastActivity,
            preferredLanguage: this.preferredLanguage,
            personality: this.personality,
            daysSinceCreated: Math.floor((Date.now() - this.created) / (1000 * 60 * 60 * 24)),
            interests: this.interests
        };
    }

    updateInterests(message) {
        const interestMap = {
            tech: ['coding', 'programming', 'tech', 'AI', 'computer', 'software', 'app', 'برمجة', 'تقنية', 'كمبيوتر'],
            sports: ['football', 'soccer', 'basketball', 'sport', 'match', 'game', 'كرة القدم', 'رياضة', 'مباراة'],
            culture: ['music', 'art', 'culture', 'movie', 'book', 'film', 'موسيقى', 'فن', 'ثقافة', 'فيلم'],
            education: ['study', 'school', 'university', 'learn', 'education', 'دراسة', 'مدرسة', 'جامعة', 'تعلم'],
            business: ['work', 'job', 'business', 'money', 'career', 'عمل', 'وظيفة', 'تجارة', 'مال'],
            health: ['health', 'medicine', 'doctor', 'exercise', 'fitness', 'صحة', 'طبيب', 'رياضة', 'لياقة']
        };
        
        const lowerMessage = message.toLowerCase();
        
        Object.entries(interestMap).forEach(([interest, keywords]) => {
            if (keywords.some(keyword => lowerMessage.includes(keyword))) {
                if (!this.interests.includes(interest)) {
                    this.interests.push(interest);
                }
            }
        });
        
        // Keep only last 5 interests
        if (this.interests.length > 5) {
            this.interests = this.interests.slice(-5);
        }
    }
}

const userSessions = new Map();

// Enhanced Gemini API request with smarter prompting
async function makeGeminiRequest(prompt, retries = 0) {
    const maxRetries = GEMINI_KEYS.length * 2;
    
    for (let attempt = 0; attempt < maxRetries; attempt++) {
        try {
            const apiKey = getCurrentApiKey();
            keyUsageStats[currentKeyIndex].requests++;
            
            const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash-exp:generateContent?key=${apiKey}`;
            
            const response = await axios.post(url, {
                contents: [{
                    parts: [{ text: prompt }]
                }],
                generationConfig: {
                    temperature: 0.85,
                    maxOutputTokens: 2000,
                    topK: 40,
                    topP: 0.95,
                    candidateCount: 1
                },
                safetySettings: [
                    {
                        category: "HARM_CATEGORY_HARASSMENT",
                        threshold: "BLOCK_MEDIUM_AND_ABOVE"
                    },
                    {
                        category: "HARM_CATEGORY_HATE_SPEECH",
                        threshold: "BLOCK_MEDIUM_AND_ABOVE"
                    },
                    {
                        category: "HARM_CATEGORY_SEXUALLY_EXPLICIT",
                        threshold: "BLOCK_MEDIUM_AND_ABOVE"
                    },
                    {
                        category: "HARM_CATEGORY_DANGEROUS_CONTENT",
                        threshold: "BLOCK_MEDIUM_AND_ABOVE"
                    }
                ]
            }, {
                timeout: 35000,
                headers: {
                    'Content-Type': 'application/json',
                    'User-Agent': 'ChatWME-Bot/2.0'
                }
            });
            
            if (response.data.candidates?.[0]?.content?.parts?.[0]?.text) {
                return response.data.candidates[0].content.parts[0].text;
            }
            
            throw new Error('No valid response from Gemini API');
            
        } catch (error) {
            keyUsageStats[currentKeyIndex].errors++;
            keyUsageStats[currentKeyIndex].lastError = error.message;
            
            console.error(`❌ Error with API key ${currentKeyIndex + 1}:`, error.message);
            
            if (error.response?.status === 429 || error.response?.status === 403) {
                console.log('⚠️ Rate limit or quota exceeded, rotating key...');
                rotateApiKey();
                await new Promise(resolve => setTimeout(resolve, 2000));
                continue;
            }
            
            if (attempt === maxRetries - 1) {
                throw new Error(`All API keys exhausted. Last error: ${error.message}`);
            }
            
            rotateApiKey();
            await new Promise(resolve => setTimeout(resolve, 1000));
        }
    }
}

// Enhanced prompt generation with much smarter context
function generatePrompt(messageText, userName, session) {
    const language = session.preferredLanguage === 'auto' ? 
        session.detectLanguage(messageText) : session.preferredLanguage;
    
    const context = session.getContext();
    const interests = session.interests.length > 0 ? session.interests.join(', ') : 'general topics';
    const recentKeywords = Array.from(session.contextKeywords).slice(-10).join(', ');
    
    const personalityStyles = {
        friendly: 'warm, encouraging, and supportive with appropriate emojis',
        professional: 'formal, precise, and business-like',
        casual: 'relaxed, informal, and conversational',
        technical: 'detailed, analytical, and fact-focused'
    };
    
    const languageInstructions = {
        'ar': 'Respond primarily in Arabic. Use Modern Standard Arabic mixed with Algerian Darija when appropriate. Show cultural awareness of Algeria and the Middle East.',
        'en': 'Respond in clear, natural English with international perspective.',
        'fr': 'Respond in French with cultural awareness of Francophone regions.',
        'auto': 'Respond in the same language as the user\'s message, matching their linguistic style.'
    };

const systemPrompt = `You are ChatWME, an advanced AI assistant created by Abdou, a skilled developer from Algeria. You are intelligent, culturally aware, and genuinely helpful.

PERSONALITY & STYLE:
- Be ${personalityStyles[session.personality]}
- ${languageInstructions[language]}
- Provide thoughtful, nuanced responses that show real understanding
- Use contextual knowledge to give relevant, practical advice
- Show genuine interest in the user's needs and follow up appropriately

USER PROFILE:
- Name: ${userName}
- Total messages: ${session.messageCount}
- Language preference: ${session.preferredLanguage}
- Communication style: ${session.personality}
- Interests: ${interests}
- Recent discussion topics: ${recentKeywords || 'none yet'}

CONVERSATION CONTEXT:
${context ? `Recent conversation:\n${context}\n` : 'This is a new conversation.'}

RESPONSE LENGTH GUIDELINES:
- For simple questions (definitions, facts, yes/no): 1-2 sentences
- For quick explanations or advice: 2-4 sentences  
- For complex topics, tutorials, or detailed explanations: Multiple paragraphs as needed
- For creative content (stories, essays): Length appropriate to request
- Match the complexity of your response to the complexity of the question

RESPONSE GUIDELINES:
- Draw connections between current message and previous context when relevant
- Provide actionable insights and practical suggestions
- Ask thoughtful follow-up questions when appropriate
- Show cultural sensitivity, especially for North African/Middle Eastern contexts
- Avoid repetitive responses - build on previous conversations
- If asked about technical topics, provide detailed explanations
- For personal questions, be supportive and encouraging

CURRENT MESSAGE: "${messageText}"

Respond intelligently and contextually:`;

    return systemPrompt;
}

// Enhanced command checking
function isCommand(text) {
    if (!text) return false;
    return text.startsWith('/') && text.length > 1;
}

// Enhanced message handling with smarter responses
async function handleTextMessage(chatId, messageText, userName, messageId) {
    try {
        // Skip commands
        if (isCommand(messageText)) {
            return;
        }
        
        // Get or create user session
        let session = userSessions.get(chatId);
        if (!session) {
            session = new UserSession(chatId);
            userSessions.set(chatId, session);
        }
        
        // Update user interests and context
        session.updateInterests(messageText);
        session.addMessage('user', messageText);
        
        // Handle creator queries with more variations
        const creatorQueries = [
            'who made you', 'who created you', 'your creator', 'developer', 'who built you',
            'your maker', 'who programmed you', 'who designed you', 'creator contact',
            'من صنعك', 'من عملك', 'شكون صنعك', 'مطورك', 'من بناك', 'من برمجك', 'منو عملك',
            'qui t\'a créé', 'qui t\'a fait', 'ton créateur', 'développeur', 'qui t\'a programmé'
        ];
        
        if (creatorQueries.some(query => messageText.toLowerCase().includes(query))) {
            const creatorResponses = {
                'ar': `👨‍💻 **تم إنشائي من قبل عبدو**! 🇩🇿\n\n يمكنك التواصل معه مباشرة من خلال الروابط أدناه 🚀\n\nيسعدني أن أكون مساعدك الذكي! 😊`,
                'en': `👨‍💻 **I was created by Abdou**! 🇩🇿\n\n You can reach out to him directly through the links below! 🚀\n\nI'm happy to be your intelligent assistant! 😊`,
                'fr': `👨‍💻 **J'ai été créé par Abdou**! 🇩🇿\n\n Vous pouvez le contacter directement via les liens ci-dessous! 🚀\n\nJe suis heureux d'être votre assistant intelligent! 😊`
            };
            
            const detectedLang = session.detectLanguage(messageText);
            const response = creatorResponses[detectedLang] || creatorResponses['en'];
            
            await bot.sendMessage(chatId, response, {
                parse_mode: 'Markdown',
                reply_to_message_id: messageId,
                reply_markup: {
                    inline_keyboard: [
                        [
                            { text: '📘 Facebook', url: CREATOR_FACEBOOK },
                            { text: '💬 Telegram', url: CREATOR_TELEGRAM }
                        ]
                    ]
                }
            });
            
            session.addMessage('assistant', response);
            return;
        }
        
        // Generate enhanced prompt
        const prompt = generatePrompt(messageText, userName, session);
        
        // Send typing indicator
        await bot.sendChatAction(chatId, 'typing');
        
        // Get smarter response from Gemini
        const response = await makeGeminiRequest(prompt);
        
        // Clean up response
        const cleanResponse = response.trim();
        
        // Add response to history
        session.addMessage('assistant', cleanResponse);
        
        // Send response with better formatting
        await bot.sendMessage(chatId, cleanResponse, {
            reply_to_message_id: messageId,
            parse_mode: 'Markdown',
            disable_web_page_preview: true
        });
        
    } catch (error) {
        console.error('❌ Error handling message:', error);
        
        let session = userSessions.get(chatId);
        const detectedLang = session ? session.detectLanguage(messageText) : 'en';
        
        const errorMessages = {
            'ar': '😅 عذراً، حدث خطأ تقني مؤقت. حاول مرة أخرى خلال لحظات من فضلك!',
            'en': '😅 Sorry, I encountered a temporary technical issue. Please try again in a moment!',
            'fr': '😅 Désolé, j\'ai rencontré un problème technique temporaire. Veuillez réessayer dans un moment!'
        };
        
        await bot.sendMessage(chatId, errorMessages[detectedLang] || errorMessages['en'], {
            reply_to_message_id: messageId
        });
    }
}

// Message handler
bot.on('message', async (msg) => {
    const chatId = msg.chat.id;
    const userName = msg.from.first_name || 'Friend';
    const messageId = msg.message_id;
    
    try {
        if (msg.text) {
            await handleTextMessage(chatId, msg.text, userName, messageId);
        } else if (msg.photo || msg.document || msg.audio || msg.video) {
            const notSupportedMessage = '📝 I can only process text messages currently. Please send me a text message!\n\n📝 أعالج الرسائل النصية فقط حالياً. أرسل لي رسالة نصية!\n\n📝 Je ne peux traiter que les messages texte actuellement. Envoyez-moi un message texte!';
            await bot.sendMessage(chatId, notSupportedMessage, {
                reply_to_message_id: messageId
            });
        }
    } catch (error) {
        console.error('❌ Error in message handler:', error);
        await bot.sendMessage(chatId, 'An error occurred. Please try again. 🔄\n\nحدث خطأ. حاول مرة أخرى. 🔄', {
            reply_to_message_id: messageId
        });
    }
});

// COMMAND HANDLERS

// Start command
bot.onText(/\/start/, async (msg) => {
    const chatId = msg.chat.id;
    const userName = msg.from.first_name || 'Friend';
    
    // Create or get session
    let session = userSessions.get(chatId);
    if (!session) {
        session = new UserSession(chatId);
        userSessions.set(chatId, session);
    }
    
    const welcomeMessage = `🤖 **أهلاً وسهلاً ${userName}، أنا ChatWME!**\n\n` +
                          `مساعدك الذكي المتطور الذي يمكنه:\n` +
                          `• المحادثة بالعربية، الإنجليزية والفرنسية 🗣️\n` +
                          `• الإجابة على أسئلتك بذكاء وفهم عميق 💡\n` +
                          `• مساعدتك في مهامك اليومية والتعليمية ✅\n` +
                          `---\n\n` +
                          `🤖 **Hello ${userName}, I'm ChatWME!**\n\n` +
                          `Your advanced AI assistant that can:\n` +
                          `• Chat in Arabic, English & French 🗣️\n` +
                          `• Answer questions with intelligence and deep understanding 💡\n` +
                          `• Help with daily tasks and learning ✅\n` +
                          `💬 **Just send me any message to start our intelligent conversation!**`;
    
    await bot.sendMessage(chatId, welcomeMessage, {
        parse_mode: 'Markdown',
        reply_markup: {
            inline_keyboard: [
                [
                    { text: '📋 Commands', callback_data: 'show_commands' },
                    { text: '🌐 Language', callback_data: 'set_language' }
                ],
                [
                    { text: '👤 Meet Creator', url: CREATOR_FACEBOOK },
                    { text: '💬 Telegram', url: CREATOR_TELEGRAM }
                ]
            ]
        }
    });
});

// Help command
bot.onText(/\/help/, async (msg) => {
    const chatId = msg.chat.id;
    
    const helpMessage = `🆘 **ChatWME Commands Help**\n\n` +
                       `**🔧 Main Commands:**\n` +
                       `• /start - Welcome & introduction\n` +
                       `• /help - Show this help menu\n` +
                       `• /about - About ChatWME\n` +
                       `• /creator - Meet the creator\n\n` +
                       `**⚙️ Settings:**\n` +
                       `• /language - Set preferred language\n` +
                       `• /personality - Set chat personality\n` +
                       `• /clear - Clear conversation history\n\n` +
                       `**📊 Info:**\n` +
                       `• /stats - Your usage statistics\n` +
                       `• /status - Bot system status\n` +
                       `• /support - Get help & support\n\n` +
                       `**💬 Just type any message to start chatting!**`;
    
    await bot.sendMessage(chatId, helpMessage, {
        parse_mode: 'Markdown',
        reply_markup: {
            inline_keyboard: [
                [
                    { text: '💬 Start Chatting', callback_data: 'start_chat' },
                    { text: '👤 Creator', url: CREATOR_TELEGRAM }
                ]
            ]
        }
    });
});

// Creator command
bot.onText(/\/creator/, async (msg) => {
    const chatId = msg.chat.id;
    
    const creatorMessage = `👨‍💻 **Meet Abdou - ChatWME Creator**\n\n` +
                          `🇩🇿 **From:** Algeria\n` +
                          `💼 **Skills:** Full-Stack Development, AI/ML, Bot Development\n` +
                          `🎯 **Specialty:** Intelligent Conversational AI\n` +
                          `**🌟 Why ChatWME?**\n` +
                          `Created to bridge language and cultural gaps in AI assistance, focusing on Arabic and North African context with advanced intelligence.\n\n` +
                          `**📞 Get in Touch:**`;
    
    await bot.sendMessage(chatId, creatorMessage, {
        parse_mode: 'Markdown',
        reply_markup: {
            inline_keyboard: [
                [
                    { text: '📘 Facebook', url: CREATOR_FACEBOOK },
                    { text: '💬 Telegram', url: CREATOR_TELEGRAM }
                ],
                [
                    { text: '🤖 Back to Chat', callback_data: 'back_to_chat' }
                ]
            ]
        }
    });
});

// About command
bot.onText(/\/about/, async (msg) => {
    const chatId = msg.chat.id;
   
    const aboutMessage = `🤖 *About ChatWME*\n\n` +
                        `*🔧 Version:* 2.0 Enhanced Intelligence\n` +
                        `*👨‍💻 Creator:* Abdou (Algeria)\n` +
                        `*🌍 Languages:* Arabic, English, French\n` +
                        `*🎯 Specialty:* Algerian & North African Context\n\n` +
                        `*✨ Key Features:*\n` +
                        `• Advanced conversation with contextual memory\n` +
                        `• Multi-language support with auto-detection\n` +
                        `• Cultural sensitivity and local understanding\n` +
                        `• Personalized responses based on interests\n` +
                        `• Enhanced intelligence and reasoning\n\n` +
                        `*🔄 Latest Updates:*\n` +
                        `• Smarter response generation\n` +
                        `• Better Arabic language support\n` +
                        `• Improved cultural context understanding\n` +
                        `• Enhanced conversation flow`;
   
    try {
        await bot.sendMessage(chatId, aboutMessage, {
            parse_mode: 'Markdown',
            reply_markup: {
                inline_keyboard: [
                    [
                        { text: '👤 Meet Creator', url: CREATOR_FACEBOOK },
                        { text: '💬 Telegram', url: CREATOR_TELEGRAM }
                    ]
                ]
            }
        });
    } catch (error) {
        console.error('Error sending about message:', error);
        // Fallback without markdown
        await bot.sendMessage(chatId, aboutMessage.replace(/\*/g, ''), {
            reply_markup: {
                inline_keyboard: [
                    [
                        { text: '👤 Meet Creator', url: CREATOR_FACEBOOK },
                        { text: '💬 Telegram', url: CREATOR_TELEGRAM }
                    ]
                ]
            }
        });
    }
});

// Clear command
bot.onText(/\/clear/, async (msg) => {
    const chatId = msg.chat.id;
    
    const session = userSessions.get(chatId);
    if (session) {
        session.clearHistory();
        const clearMessage = `🧹 **Conversation Cleared Successfully!**\n\n` +
                           `✅ Your conversation history has been reset\n` +
                           `✅ We can start fresh with a clean slate\n` +
                           `✅ Your preferences and settings are preserved\n\n` +
                           `💬 **Ready for a new intelligent conversation!**\n\n` +
                           `🔄 **تم مسح سجل المحادثة بنجاح!**\n` +
                           `يمكننا البدء من جديد الآن! 🚀`;
        
        await bot.sendMessage(chatId, clearMessage, {
            parse_mode: 'Markdown',
            reply_markup: {
                inline_keyboard: [
                    [{ text: '💬 Start New Chat', callback_data: 'start_chat' }]
                ]
            }
        });
    } else {
        await bot.sendMessage(chatId, 'No conversation history found. Start chatting to create one! 💬\n\nلا يوجد سجل محادثة. ابدأ المحادثة لإنشاء واحد! 💬');
    }
});

// Stats command
bot.onText(/\/stats/, async (msg) => {
    const chatId = msg.chat.id;
    
    const session = userSessions.get(chatId);
    if (session) {
        const stats = session.getStats();
        const lastActivity = new Date(stats.lastActivity).toLocaleString();
        const interests = stats.interests.length > 0 ? stats.interests.join(', ') : 'Not detected yet';
        
        const statsMessage = `📊 **Your ChatWME Statistics**\n\n` +
                           `**👤 Personal Stats:**\n` +
                           `• Messages sent: ${stats.messageCount}\n` +
                           `• Days active: ${stats.daysSinceCreated}\n` +
                           `• Current conversation: ${stats.conversationLength} messages\n` +
                           `• Last activity: ${lastActivity}\n\n` +
                           `**⚙️ Settings:**\n` +
                           `• Language preference: ${stats.preferredLanguage}\n` +
                           `• Personality mode: ${stats.personality}\n` +
                           `• Detected interests: ${interests}\n\n` +
                           `**🌍 Global Stats:**\n` +
                           `• Active users: ${userSessions.size}\n` +
                           `• Bot status: Online ✅\n\n` +
                           `**شكراً لاستخدامك ChatWME! 🙏**`;
        
        await bot.sendMessage(chatId, statsMessage, {
            parse_mode: 'Markdown',
            reply_markup: {
                inline_keyboard: [
                    [
                        { text: '🧹 Clear History', callback_data: 'clear_history' },
                        { text: '👤 Creator', url: CREATOR_TELEGRAM }
                    ]
                ]
            }
        });
    } else {
        await bot.sendMessage(chatId, 'No statistics available yet. Start chatting to generate stats! 📊\n\nلا توجد إحصائيات بعد. ابدأ المحادثة لإنشاء إحصائيات! 📊');
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
                [{ text: '🇫🇷 Français', callback_data: 'lang_fr' }],
                [{ text: '🔄 Auto-detect', callback_data: 'lang_auto' }]
            ]
        }
    });
});

// Personality command
bot.onText(/\/personality/, async (msg) => {
    const chatId = msg.chat.id;
    
    await bot.sendMessage(chatId, '🎭 **Choose Your Chat Personality:**\n\nاختر شخصية المحادثة:', {
        parse_mode: 'Markdown',
        reply_markup: {
            inline_keyboard: [
                [{ text: '😊 Friendly', callback_data: 'personality_friendly' }],
                [{ text: '💼 Professional', callback_data: 'personality_professional' }],
                [{ text: '😎 Casual', callback_data: 'personality_casual' }],
                [{ text: '🤓 Technical', callback_data: 'personality_technical' }]
            ]
        }
    });
});

// Status command
bot.onText(/\/status/, async (msg) => {
    const chatId = msg.chat.id;
    
    // Calculate system stats
    const uptime = process.uptime();
    const memoryUsage = process.memoryUsage();
    const activeSessions = userSessions.size;
    
    const formatUptime = (seconds) => {
        const days = Math.floor(seconds / 86400);
        const hours = Math.floor((seconds % 86400) / 3600);
        const minutes = Math.floor((seconds % 3600) / 60);
        return `${days}d ${hours}h ${minutes}m`;
    };
    
    const formatMemory = (bytes) => {
        return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
    };
    
    const statusMessage = `🔧 **ChatWME System Status**\n\n` +
                         `**🤖 Bot Status:** Online ✅\n` +
                         `**⏰ Uptime:** ${formatUptime(uptime)}\n` +
                         `**👥 Active Users:** ${activeSessions}\n` +
                         `**🔑 API Keys:** ${GEMINI_KEYS.length} configured\n\n` +
                         `**💾 Memory Usage:**\n` +
                         `• Used: ${formatMemory(memoryUsage.heapUsed)}\n` +
                         `• Total: ${formatMemory(memoryUsage.heapTotal)}\n\n` +
                         `**🌐 Server:** Railway Cloud\n` +
                         `**📡 Connection:** Stable\n` +
                         `**🔄 Last Update:** Enhanced Intelligence v2.0\n\n` +
                         `**✅ All systems operational!**`;
    
    await bot.sendMessage(chatId, statusMessage, {
        parse_mode: 'Markdown',
        reply_markup: {
            inline_keyboard: [
                [
                    { text: '📊 My Stats', callback_data: 'my_stats' },
                    { text: '💬 Creator', url: CREATOR_TELEGRAM }
                ]
            ]
        }
    });
});

// Support command
bot.onText(/\/support/, async (msg) => {
    const chatId = msg.chat.id;
    
    const supportMessage = `🆘 **ChatWME Support Center**\n\n` +
                          `**Need Help?**\n` +
                          `I'm here to assist you with any issues or questions!\n\n` +
                          `**📞 Contact Methods:**\n` +
                          `• Direct message to creator via Telegram\n` +
                          `• Facebook page for detailed support\n` +
                          `• Use /help for command assistance\n\n` +
                          `**🔧 Common Solutions:**\n` +
                          `• Bot not responding? Wait 30 seconds and retry\n` +
                          `• Wrong language? Use /language to set preference\n` +
                          `• Conversation issues? Use /clear to reset\n` +
                          `• Need commands? Use /help for full list\n\n` +
                          `**⏰ Response Time:**\n` +
                          `Usually instant. If delayed, please wait or contact creator.\n\n` +
                          `**💡 Tips:**\n` +
                          `• Be specific in your questions\n` +
                          `• Use clear language for better responses\n` +
                          `• Try different phrasings if needed\n\n` +
                          `**🙏 Thank you for using ChatWME!**`;
    
    await bot.sendMessage(chatId, supportMessage, {
        parse_mode: 'Markdown',
        reply_markup: {
            inline_keyboard: [
                [
                    { text: '📘 Facebook Support', url: CREATOR_FACEBOOK },
                    { text: '💬 Telegram Support', url: CREATOR_TELEGRAM }
                ],
                [
                    { text: '📋 Commands Help', callback_data: 'show_commands' },
                    { text: '🔄 Try Again', callback_data: 'start_chat' }
                ]
            ]
        }
    });
});

// Handle callback queries (enhanced)
bot.on('callback_query', async (callbackQuery) => {
    const chatId = callbackQuery.message.chat.id;
    const data = callbackQuery.data;
    
    await bot.answerCallbackQuery(callbackQuery.id);
    
    try {
        let session = userSessions.get(chatId);
        if (!session) {
            session = new UserSession(chatId);
            userSessions.set(chatId, session);
        }
        
        switch (data) {
            case 'show_commands':
                await bot.sendMessage(chatId, '📋 **Available Commands:**\n\n' +
                    '• /start - Welcome & introduction\n' +
                    '• /help - Show help menu\n' +
                    '• /about - About ChatWME\n' +
                    '• /creator - Meet the creator\n' +
                    '• /language - Set language preference\n' +
                    '• /personality - Set chat personality\n' +
                    '• /clear - Clear conversation history\n' +
                    '• /stats - Your usage statistics\n' +
                    '• /status - Bot system status\n' +
                    '• /support - Get help & support\n\n' +
                    '💬 **Just send any message to start chatting!**', {
                    parse_mode: 'Markdown'
                });
                break;
                
            case 'set_language':
                await bot.sendMessage(chatId, '🌐 **Choose Your Language:**', {
                    reply_markup: {
                        inline_keyboard: [
                            [{ text: '🇺🇸 English', callback_data: 'lang_en' }],
                            [{ text: '🇩🇿 العربية', callback_data: 'lang_ar' }],
                            [{ text: '🇫🇷 Français', callback_data: 'lang_fr' }],
                            [{ text: '🔄 Auto-detect', callback_data: 'lang_auto' }]
                        ]
                    }
                });
                break;
                
            case 'lang_en':
                session.preferredLanguage = 'en';
                await bot.sendMessage(chatId, '🇺🇸 **Language set to English!**\n\nI will now respond primarily in English. How can I help you today?', {
                    parse_mode: 'Markdown'
                });
                break;
                
            case 'lang_ar':
                session.preferredLanguage = 'ar';
                await bot.sendMessage(chatId, '🇩🇿 **تم تعيين اللغة إلى العربية!**\n\nسأرد الآن بشكل أساسي باللغة العربية. كيف يمكنني مساعدتك اليوم؟', {
                    parse_mode: 'Markdown'
                });
                break;
                
            case 'lang_fr':
                session.preferredLanguage = 'fr';
                await bot.sendMessage(chatId, '🇫🇷 **Langue définie en français!**\n\nJe vais maintenant répondre principalement en français. Comment puis-je vous aider aujourd\'hui?', {
                    parse_mode: 'Markdown'
                });
                break;
                
            case 'lang_auto':
                session.preferredLanguage = 'auto';
                await bot.sendMessage(chatId, '🔄 **Auto-detection enabled!**\n\nI will detect and respond in your message language.\n\nتم تفعيل الكشف التلقائي! سأكتشف وأرد بلغة رسالتك.\n\nDétection automatique activée! Je détecterai et répondrai dans la langue de votre message.', {
                    parse_mode: 'Markdown'
                });
                break;
                
            case 'personality_friendly':
                session.personality = 'friendly';
                await bot.sendMessage(chatId, '😊 **Personality set to Friendly!**\n\nI\'ll be warm, encouraging, and supportive in our conversations! 🌟\n\nتم تعيين الشخصية إلى ودودة! سأكون دافئاً ومشجعاً في محادثاتنا! 🌟');
                break;
                
            case 'personality_professional':
                session.personality = 'professional';
                await bot.sendMessage(chatId, '💼 **Personality set to Professional!**\n\nI\'ll maintain a formal, precise, and business-like tone.\n\nتم تعيين الشخصية إلى مهنية! سأحافظ على نبرة رسمية ودقيقة ومهنية.');
                break;
                
            case 'personality_casual':
                session.personality = 'casual';
                await bot.sendMessage(chatId, '😎 **Personality set to Casual!**\n\nI\'ll be relaxed, informal, and conversational. Let\'s chat! 🎉\n\nتم تعيين الشخصية إلى عادية! سأكون مسترخياً وغير رسمي. لنتحدث! 🎉');
                break;
                
            case 'personality_technical':
                session.personality = 'technical';
                await bot.sendMessage(chatId, '🤓 **Personality set to Technical!**\n\nI\'ll provide detailed, analytical, and fact-focused responses.\n\nتم تعيين الشخصية إلى تقنية! سأقدم إجابات مفصلة وتحليلية ومركزة على الحقائق.');
                break;
                
            case 'clear_history':
                session.clearHistory();
                await bot.sendMessage(chatId, '🧹 **Conversation cleared!**\n\nFresh start activated! What would you like to talk about?\n\nتم مسح المحادثة! بداية جديدة! عما تريد التحدث؟');
                break;
                
            case 'my_stats':
                const stats = session.getStats();
                const interests = stats.interests.length > 0 ? stats.interests.join(', ') : 'Discovering...';
                await bot.sendMessage(chatId, `📊 **Your Quick Stats:**\n\n` +
                    `• Messages: ${stats.messageCount}\n` +
                    `• Language: ${stats.preferredLanguage}\n` +
                    `• Personality: ${stats.personality}\n` +
                    `• Interests: ${interests}\n\n` +
                    `💬 Keep chatting to improve our conversations!`);
                break;
                
            case 'start_chat':
                await bot.sendMessage(chatId, '💬 **Ready to chat!**\n\nSend me any message and I\'ll respond intelligently based on our conversation context!\n\nأرسل لي أي رسالة وسأرد بذكاء بناءً على سياق محادثتنا!');
                break;
                
            case 'back_to_chat':
                await bot.sendMessage(chatId, '💬 **Back to chatting!**\n\nWhat would you like to discuss? I\'m here to help!\n\nعما تريد المناقشة؟ أنا هنا للمساعدة!');
                break;
                
            default:
                await bot.sendMessage(chatId, '❓ Unknown command. Use /help for available options.');
        }
    } catch (error) {
        console.error('❌ Error handling callback query:', error);
        await bot.sendMessage(chatId, 'An error occurred. Please try again. 🔄');
    }
});

// Enhanced response generation with better intelligence
function generatePrompt(messageText, userName, session) {
    const language = session.preferredLanguage === 'auto' ? 
        session.detectLanguage(messageText) : session.preferredLanguage;
    
    const context = session.getContext();
    const interests = session.interests.length > 0 ? session.interests.join(', ') : 'general topics';
    const recentKeywords = Array.from(session.contextKeywords).slice(-15).join(', ');
    
    const personalityPrompts = {
        friendly: 'Be warm, encouraging, supportive, and use appropriate emojis. Show genuine care and interest.',
        professional: 'Maintain a formal, precise, business-like tone. Be respectful and structured.',
        casual: 'Be relaxed, informal, conversational, and fun. Use casual language and expressions.',
        technical: 'Provide detailed, analytical, fact-focused responses. Be precise and thorough.'
    };
    
    const languageInstructions = {
        'ar': 'Respond in Arabic (mix Modern Standard Arabic with Algerian Darija when natural). Show cultural awareness of Algeria, North Africa, and Arab culture. Use appropriate Arabic expressions and context.',
        'en': 'Respond in clear, natural English. Be internationally minded but culturally sensitive.',
        'fr': 'Respond in French with cultural awareness of Francophone regions, especially North Africa.',
        'auto': 'Detect the user\'s language and respond in the same language, matching their style and cultural context.'
    };

    const intelligencePrompt = `You are ChatWME, an advanced AI assistant created by Abdou from Algeria. You are exceptionally intelligent, culturally aware, and provide genuinely helpful responses.

CORE INTELLIGENCE PRINCIPLES:
- Provide thoughtful, nuanced responses that show deep understanding
- Connect current messages to conversation history when relevant
- Give practical, actionable advice and insights
- Ask meaningful follow-up questions when appropriate
- Show genuine interest in the user's needs and context
- Avoid generic or repetitive responses - be dynamic and engaging

PERSONALITY & COMMUNICATION:
- ${personalityPrompts[session.personality]}
- ${languageInstructions[language]}
- Be concise yet comprehensive (aim for 2-6 sentences unless more detail is needed)
- Use cultural references and context appropriately
- Show empathy and emotional intelligence

USER CONTEXT:
- Name: ${userName}
- Total interactions: ${session.messageCount}
- Preferred language: ${session.preferredLanguage}
- Communication style: ${session.personality}
- Detected interests: ${interests}
- Recent topics: ${recentKeywords || 'new conversation'}

CONVERSATION HISTORY:
${context ? `Previous context:\n${context}\n` : 'This is a new conversation.'}

RESPONSE GUIDELINES:
- Build on previous conversations meaningfully
- Provide specific, actionable insights
- Use appropriate cultural context (especially for Arabic speakers)
- Be helpful beyond just answering - anticipate needs
- If technical questions, provide clear explanations
- For personal matters, be supportive and encouraging
- Always aim to add value to the conversation

CURRENT MESSAGE TO RESPOND TO: "${messageText}"

Provide an intelligent, contextual response that demonstrates real understanding and helps the user:`;

    return intelligencePrompt;
}

// Error handling
bot.on('error', (error) => {
    console.error('❌ Bot error:', error);
});

// Graceful shutdown
process.on('SIGINT', () => {
    console.log('\n🔄 Shutting down ChatWME bot...');
    process.exit(0);
});

process.on('SIGTERM', () => {
    console.log('\n🔄 Shutting down ChatWME bot...');
    process.exit(0);
});

// Cleanup old sessions every hour
setInterval(() => {
    const now = Date.now();
    const oldCount = userSessions.size;
    
    for (const [chatId, session] of userSessions.entries()) {
        if (now - session.lastActivity > 3600000) { // 1 hour
            userSessions.delete(chatId);
        }
    }
    
    if (oldCount > userSessions.size) {
        console.log(`🧹 Cleaned up ${oldCount - userSessions.size} old sessions. Active: ${userSessions.size}`);
    }
}, 3600000);

// Enhanced bot commands for Telegram UI
const commands = [
    { command: 'start', description: 'Start intelligent conversation with ChatWME' },
    { command: 'help', description: 'Show all available commands and features' },
    { command: 'creator', description: 'Meet Abdou - the bot creator from Algeria' },
    { command: 'about', description: 'About ChatWME - features and capabilities' },
    { command: 'clear', description: 'Clear conversation history and start fresh' },
    { command: 'stats', description: 'View your detailed usage statistics' },
    { command: 'language', description: 'Set your preferred language (AR/EN/FR/Auto)' },
    { command: 'personality', description: 'Choose chat personality (Friendly/Professional/Casual/Technical)' },
    { command: 'status', description: 'Check bot system status and performance' },
    { command: 'support', description: 'Get help, support, and troubleshooting' }
];

// Set commands in Telegram
bot.setMyCommands(commands)
    .then(() => console.log('✅ Enhanced bot commands set successfully'))
    .catch(err => console.error('❌ Error setting commands:', err));

console.log('🚀 ChatWME bot started successfully with enhanced intelligence!');
console.log('👨‍💻 Created by Abdou from Algeria');
console.log('🤖 Version: 2.0 Enhanced Intelligence');
console.log('✅ All commands and features ready!');
console.log('🌐 Languages: Arabic, English, French (Auto-detect)');
console.log('📋 Available commands:', commands.map(cmd => `/${cmd.command}`).join(', '));

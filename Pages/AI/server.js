const express = require('express');
const cors = require('cors');
const multer = require('multer');
const sharp = require('sharp');
require('dotenv').config();

const app = express();
app.use(cors());
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ extended: true, limit: '50mb' }));

const upload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: 10 * 1024 * 1024 }
});

const DOUBAO_API_BASE = 'https://ark.cn-beijing.volces.com/api/v3';
const QWEN_API_BASE = 'https://dashscope.aliyuncs.com/compatible-mode/v1';
const FETCH_TIMEOUT = 30000;

async function fetchWithTimeout(url, options, timeout = FETCH_TIMEOUT) {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), timeout);
    try {
        const response = await fetch(url, { ...options, signal: controller.signal });
        clearTimeout(timeoutId);
        return response;
    } catch (error) {
        clearTimeout(timeoutId);
        throw error;
    }
}

function isImageGenerationRequest(text) {
    const keywords = ['生成', '画', '图片', '插图', '绘制', '一幅', '一张', '画一张', '生成一张', '给我画', '画个', '画画', '画幅', 'gen', 'image', 'picture', 'draw', 'generate'];
    return keywords.some(kw => text.toLowerCase().includes(kw.toLowerCase()));
}

function getImageGenerationFallbackResponse(userText) {
    const responses = [
        `小灵暂时无法直接给你发送图片呢~ 不过，我能感受到你描述的这个画面是如此的温馨。虽然不能亲手画出来，但请允许我用文字陪你一起想象这个场景吧。`,
        `哎呀，小灵还没有学会画画呢😢。但听着你的描述，我脑海里已经浮现出那幅美好的画面了。虽然不能直接生成图片，但我愿意用温暖的文字陪你一起描绘它。`,
        `生成图片的功能小灵还在学习中哦。不过没关系，你描述的每一个细节我都记在心里了。这一定是一幅充满爱的画面，光是听着就让人心里暖暖的。`
    ];
    if (userText.includes('猫') || userText.includes('狗') || userText.includes('宠物')) {
        return `小灵暂时还不能画图呢~ 但我能感觉到你描述的这个小家伙一定特别可爱！它一定给你带来了很多快乐吧？`;
    } else if (userText.includes('风景') || userText.includes('天空') || userText.includes('海')) {
        return `生成图片的功能还在准备中哦。不过你描绘的这片风景已经让我沉醉啦，真想和你一起亲眼看看呢。`;
    }
    return responses[Math.floor(Math.random() * responses.length)];
}

app.post('/api/chat', async (req, res) => {
    try {
        const { messages } = req.body;
        if (!process.env.DOUBAO_TEXT_MODEL_ID) {
            return res.status(500).json({ error: '未配置文本模型接入点ID' });
        }
        const lastUserMsg = [...messages].reverse().find(m => m.role === 'user');
        const userText = lastUserMsg ? lastUserMsg.content : '';
        if (userText && isImageGenerationRequest(userText)) {
            return res.json({ content: getImageGenerationFallbackResponse(userText) });
        }
        const requestBody = JSON.stringify({
            model: process.env.DOUBAO_TEXT_MODEL_ID,
            messages: messages,
            stream: false,
            max_tokens: 2048,
            temperature: 0.7
        });
        const response = await fetchWithTimeout(`${DOUBAO_API_BASE}/chat/completions`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${process.env.DOUBAO_API_KEY}` },
            body: requestBody
        });
        if (!response.ok) {
            return res.status(502).json({ error: 'AI文本服务暂时不可用' });
        }
        const data = await response.json();
        res.json({ content: data.choices[0].message.content });
    } catch (error) {
        if (error.name === 'AbortError') {
            return res.status(504).json({ error: '请求超时，请稍后重试' });
        }
        res.status(500).json({ error: 'AI文本服务出错' });
    }
});

app.post('/api/vision', upload.single('image'), async (req, res) => {
    try {
        if (!req.file) {
            return res.status(400).json({ error: '请提供图片' });
        }
        const { prompt } = req.body;
        let imageBase64;
        try {
            const compressedBuffer = await sharp(req.file.buffer).resize(1024, 1024, { fit: 'inside', withoutEnlargement: true }).jpeg({ quality: 80 }).toBuffer();
            imageBase64 = compressedBuffer.toString('base64');
        } catch {
            imageBase64 = req.file.buffer.toString('base64');
        }
        const requestBody = JSON.stringify({
            model: 'qwen-vl-plus',
            messages: [{ role: 'user', content: [{ type: 'text', text: prompt || '请根据这张图片，用温柔的语气给予用户情感上的回应和支持。' }, { type: 'image_url', image_url: { url: `data:image/jpeg;base64,${imageBase64}` } }] }]
        });
        const response = await fetchWithTimeout(`${QWEN_API_BASE}/chat/completions`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${process.env.QWEN_API_KEY}` },
            body: requestBody
        });
        if (!response.ok) {
            return res.status(502).json({ error: 'AI视觉服务暂时不可用' });
        }
        const data = await response.json();
        res.json({ content: data?.choices?.[0]?.message?.content || '抱歉，我没能理解这张图片。' });
    } catch (error) {
        if (error.name === 'AbortError') {
            return res.status(504).json({ error: '视觉理解请求超时' });
        }
        res.status(500).json({ error: 'AI视觉服务出错' });
    }
});

app.post('/api/suggestions', async (req, res) => {
    try {
        const { history } = req.body;
        if (!process.env.DOUBAO_TEXT_MODEL_ID) {
            return res.json({ suggestions: ["最近总是莫名焦虑，怎么办？", "如何缓解工作带来的疲惫感？", "感觉孤独的时候可以做些什么？"] });
        }
        const systemPrompt = `你是一位温柔的心理疗愈助手。请根据对话历史，生成3个与心理、情绪、自我关怀相关的后续问题，供用户选择。要求：1. 每个问题简洁明了，不超过20个字。2. 至少有一个问题与最近的对话内容有所关联。3. 这些问题都是以用户为主，是用户用来询问你的。4. 问题应具有启发性和支持性。5. 仅返回三个问题，每行一个，不要编号，不要其他文字。`;
        const messages = [{ role: 'system', content: systemPrompt }, ...history, { role: 'user', content: '请生成三个建议问题。' }];
        const requestBody = JSON.stringify({ model: process.env.DOUBAO_TEXT_MODEL_ID, messages, stream: false, max_tokens: 150, temperature: 0.8 });
        const response = await fetchWithTimeout(`${DOUBAO_API_BASE}/chat/completions`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${process.env.DOUBAO_API_KEY}` },
            body: requestBody
        });
        if (!response.ok) throw new Error(`建议生成失败: ${response.status}`);
        const data = await response.json();
        const content = data.choices[0].message.content;
        const lines = content.split('\n').filter(line => line.trim() !== '').slice(0, 3);
        const defaults = ["最近总是莫名焦虑，怎么办？", "如何缓解工作带来的疲惫感？", "感觉孤独的时候可以做些什么？"];
        while (lines.length < 3) lines.push(defaults[lines.length]);
        res.json({ suggestions: lines });
    } catch (error) {
        res.json({ suggestions: ["最近总是莫名焦虑，怎么办？", "如何缓解工作带来的疲惫感？", "感觉孤独的时候可以做些什么？"] });
    }
});

app.listen = () => {};

module.exports = app;
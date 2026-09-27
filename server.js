require('dotenv').config();
const express = require('express');
const cookieSession = require('cookie-session');
const fetch = require('node-fetch');
const path = require('path');
const bcrypt = require('bcryptjs');
const mongoose = require('mongoose');
const { Client, GatewayIntentBits, ActionRowBuilder, ButtonBuilder, ButtonStyle, ModalBuilder, TextInputBuilder, TextInputStyle, StringSelectMenuBuilder } = require('discord.js');

const app = express();
app.use(express.json());
app.use(cookieSession({
    name: 'soul_session',
    keys: [process.env.SESSION_SECRET || 'supersecret'],
    maxAge: 24 * 60 * 60 * 1000
}));
app.use(express.static(path.join(__dirname, 'public')));

// ==========================================
// 1. الاتصال بقاعدة البيانات (MongoDB)
// ==========================================
mongoose.connect(process.env.MONGO_URI)
  .then(() => console.log('✅ تم الاتصال بقاعدة البيانات (MongoDB) بنجاح!'))
  .catch((err) => console.error('❌ خطأ في الاتصال بقاعدة البيانات:', err));

const userSchema = new mongoose.Schema({ username: String, email: { type: String, unique: true }, password: String, avatar: String });
const User = mongoose.model('User', userSchema);

const productSchema = new mongoose.Schema({ name: String, price: String, category: String });
const Product = mongoose.model('Product', productSchema);

const reviewSchema = new mongoose.Schema({ name: String, text: String, date: String });
const Review = mongoose.model('Review', reviewSchema);

// ==========================================
// 2. إعداد بوت الديسكورد 
// ==========================================
const bot = new Client({
    intents: [ GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent ]
});

bot.once('clientReady', () => {
    console.log(`🤖 البوت [ ${bot.user.tag} ] متصل وجاهز للعمل كمدير للمتجر!`);
});

bot.on('messageCreate', async (message) => {
    if (message.author.bot) return;
    
    if (message.content === '!لوحة') {
        const row = new ActionRowBuilder().addComponents(
            new ButtonBuilder().setCustomId('add_product').setLabel('🟢 إضافة منتج').setStyle(ButtonStyle.Success),
            new ButtonBuilder().setCustomId('delete_product').setLabel('🔴 حذف منتج').setStyle(ButtonStyle.Danger)
        );
        await message.reply({ content: '🛠️ **لوحة تحكم متجر Soul Store**\nاستخدم الأزرار أدناه للتحكم بمنتجات الموقع مباشرة:', components: [row] });
    }
});

bot.on('interactionCreate', async interaction => {
    if (interaction.isButton()) {
        if (interaction.customId === 'add_product') {
            const modal = new ModalBuilder().setCustomId('product_modal').setTitle('إضافة منتج جديد للموقع');
            const nameInput = new TextInputBuilder().setCustomId('p_name').setLabel('اسم المنتج (مثال: 660 شدة ببجي)').setStyle(TextInputStyle.Short);
            const priceInput = new TextInputBuilder().setCustomId('p_price').setLabel('السعر (مثال: 10$)').setStyle(TextInputStyle.Short);
            modal.addComponents(new ActionRowBuilder().addComponents(nameInput), new ActionRowBuilder().addComponents(priceInput));
            await interaction.showModal(modal);
        } else if (interaction.customId === 'delete_product') {
            const products = await Product.find();
            if (products.length === 0) return interaction.reply({ content: '⚠️ **لا توجد أي منتجات مضافة حالياً لحذفها!**', ephemeral: true });
            
            const selectMenu = new StringSelectMenuBuilder()
                .setCustomId('select_delete_product')
                .setPlaceholder('اختر المنتج الذي تريد حذفه...')
                .addOptions(products.map(p => ({ label: p.name, description: `السعر: ${p.price}`, value: p._id.toString() })));
            
            const row = new ActionRowBuilder().addComponents(selectMenu);
            await interaction.reply({ content: '🗑️ **اختر المنتج الذي تريد حذفه نهائياً من الموقع:**', components: [row], ephemeral: true });
        }
    } else if (interaction.isModalSubmit()) {
        if (interaction.customId === 'product_modal') {
            const name = interaction.fields.getTextInputValue('p_name');
            const price = interaction.fields.getTextInputValue('p_price');
            const newProduct = new Product({ name, price, category: 'عام' });
            await newProduct.save();
            await interaction.reply({ content: `✅ **نجاح!** تم إضافة المنتج للموقع:\nالاسم: ${name}\nالسعر: ${price}`, ephemeral: true });
        }
    } else if (interaction.isStringSelectMenu()) {
        if (interaction.customId === 'select_delete_product') {
            const productId = interaction.values[0]; 
            await Product.findByIdAndDelete(productId);
            await interaction.update({ content: '✅ **تم حذف المنتج من المتجر بنجاح!**\n(قم بتحديث صفحة الموقع لترى التغيير)', components: [] });
        }
    }
});

if (process.env.DISCORD_BOT_TOKEN) {
    bot.login(process.env.DISCORD_BOT_TOKEN).catch(err => console.log('❌ خطأ في تشغيل البوت، تأكد من التوكن:', err));
}

// ==========================================
// 3. مسارات المصادقة (Discord & Google)
// ==========================================
app.get('/auth/discord', (req, res) => {
    const redirectUrl = `https://discord.com/api/oauth2/authorize?client_id=${process.env.DISCORD_CLIENT_ID}&redirect_uri=${encodeURIComponent(process.env.DISCORD_REDIRECT_URI)}&response_type=code&scope=identify%20email`;
    res.redirect(redirectUrl);
});

app.get('/auth/discord/callback', async (req, res) => {
    const code = req.query.code;
    if (!code) return res.redirect('/?error=access_denied');
    try {
        const tokenRes = await fetch('https://discord.com/api/oauth2/token', {
            method: 'POST',
            body: new URLSearchParams({
                client_id: process.env.DISCORD_CLIENT_ID,
                client_secret: process.env.DISCORD_CLIENT_SECRET,
                grant_type: 'authorization_code',
                code: code,
                redirect_uri: process.env.DISCORD_REDIRECT_URI,
                scope: 'identify email'
            }),
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' }
        });
        const tokenData = await tokenRes.json();
        const userRes = await fetch('https://discord.com/api/users/@me', { headers: { authorization: `Bearer ${tokenData.access_token}` } });
        const userData = await userRes.json();
        req.session.user = { id: userData.id, username: userData.username, avatar: userData.avatar ? `https://cdn.discordapp.com/avatars/${userData.id}/${userData.avatar}.png` : 'https://cdn.discordapp.com/embed/avatars/0.png', provider: 'discord' };
        res.redirect('/');
    } catch (err) { res.redirect('/?error=auth_failed'); }
});

app.get('/auth/google', (req, res) => {
    const redirectUrl = `https://accounts.google.com/o/oauth2/v2/auth?client_id=${process.env.GOOGLE_CLIENT_ID}&redirect_uri=${encodeURIComponent(process.env.GOOGLE_REDIRECT_URI)}&response_type=code&scope=email%20profile`;
    res.redirect(redirectUrl);
});

app.get('/auth/google/callback', async (req, res) => {
    const code = req.query.code;
    if (!code) return res.redirect('/?error=access_denied');
    try {
        const tokenRes = await fetch('https://oauth2.googleapis.com/token', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                client_id: process.env.GOOGLE_CLIENT_ID,
                client_secret: process.env.GOOGLE_CLIENT_SECRET,
                code: code,
                grant_type: 'authorization_code',
                redirect_uri: process.env.GOOGLE_REDIRECT_URI
            })
        });
        const tokenData = await tokenRes.json();
        const userRes = await fetch('https://www.googleapis.com/oauth2/v2/userinfo', { headers: { Authorization: `Bearer ${tokenData.access_token}` } });
        const userData = await userRes.json();
        req.session.user = { id: userData.id, username: userData.name, avatar: userData.picture, provider: 'google' };
        res.redirect('/');
    } catch (err) { res.redirect('/?error=google_auth_failed'); }
});

// ==========================================
// 4. مسارات الموقع (المنتجات، التقييمات، التسجيل اليدوي)
// ==========================================
app.get('/api/products', async (req, res) => {
    try {
        const products = await Product.find();
        res.json(products);
    } catch(err) { res.status(500).json({ error: 'خطأ في جلب المنتجات' }); }
});

app.get('/api/reviews', async (req, res) => {
    try {
        const reviews = await Review.find().sort({ _id: -1 });
        res.json(reviews);
    } catch(err) { res.status(500).json({ error: 'خطأ في جلب التقييمات' }); }
});

app.post('/api/reviews', async (req, res) => {
    const { name, text, date } = req.body;
    if (!name || !text || !date) return res.status(400).json({ error: 'بيانات التقييم ناقصة' });
    try {
        const newReview = new Review({ name, text, date });
        await newReview.save();
        res.json({ success: true });
    } catch(err) { res.status(500).json({ error: 'خطأ في حفظ التقييم' }); }
});

app.post('/api/register', async (req, res) => {
    const { username, email, password } = req.body;
    if (!username || !email || !password) return res.status(400).json({ error: 'الرجاء تعبئة جميع الحقول' });
    try {
        const existingUser = await User.findOne({ email: email });
        if (existingUser) return res.status(400).json({ error: 'البريد مستخدم بالفعل' });
        const hashedPassword = await bcrypt.hash(password, 10);
        const newUser = new User({ username, email, password: hashedPassword, avatar: 'https://cdn.discordapp.com/embed/avatars/0.png' });
        await newUser.save();
        req.session.user = { id: newUser._id.toString(), username: newUser.username, avatar: newUser.avatar, provider: 'local' };
        res.json({ success: true });
    } catch (err) { res.status(500).json({ error: 'حدث خطأ في السيرفر' }); }
});

app.post('/api/login', async (req, res) => {
    const { email, password } = req.body;
    try {
        const user = await User.findOne({ email: email });
        if (!user) return res.status(400).json({ error: 'البريد غير صحيح' });
        const isMatch = await bcrypt.compare(password, user.password);
        if (!isMatch) return res.status(400).json({ error: 'كلمة المرور غير صحيحة' });
        req.session.user = { id: user._id.toString(), username: user.username, avatar: user.avatar, provider: 'local' };
        res.json({ success: true });
    } catch (err) { res.status(500).json({ error: 'حدث خطأ في السيرفر' }); }
});

app.post('/api/logout', (req, res) => { req.session = null; res.json({ success: true }); });
app.get('/api/user', (req, res) => { if (req.session.user) res.json({ authenticated: true, user: req.session.user }); else res.json({ authenticated: false }); });

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`🌐 السيرفر يعمل على البورت ${PORT}`));
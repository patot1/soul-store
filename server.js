require('dotenv').config();
const express = require('express');
const cookieSession = require('cookie-session');
const fetch = require('node-fetch');
const path = require('path');
const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);
const paypal = require('@paypal/checkout-server-sdk');
const bcrypt = require('bcryptjs');

const app = express();

const paypalEnvironment = new paypal.core.SandboxEnvironment(
    process.env.PAYPAL_CLIENT_ID || 'sb',
    process.env.PAYPAL_CLIENT_SECRET || 'sb'
);
const paypalClient = new paypal.core.PayPalHttpClient(paypalEnvironment);

app.use(express.json());
app.use(cookieSession({
    name: 'soul_session',
    keys: [process.env.SESSION_SECRET],
    maxAge: 24 * 60 * 60 * 1000
}));

app.use(express.static(path.join(__dirname, 'public')));

const usersDB = [];

// --- 1. مصادقة ديسكورد ---
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

// --- 2. مصادقة جوجل (Gmail) ---
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

// --- 3. التسجيل اليدوي (Email & Password) ---
app.post('/api/register', async (req, res) => {
    const { username, email, password } = req.body;
    if (!username || !email || !password) return res.status(400).json({ error: 'الرجاء تعبئة جميع الحقول' });
    if (usersDB.find(u => u.email === email)) return res.status(400).json({ error: 'البريد مستخدم بالفعل' });
    const hashedPassword = await bcrypt.hash(password, 10);
    const newUser = { id: Date.now().toString(), username, email, password: hashedPassword, avatar: 'https://cdn.discordapp.com/embed/avatars/0.png' };
    usersDB.push(newUser);
    req.session.user = { id: newUser.id, username: newUser.username, avatar: newUser.avatar, provider: 'local' };
    res.json({ success: true });
});

app.post('/api/login', async (req, res) => {
    const { email, password } = req.body;
    const user = usersDB.find(u => u.email === email);
    if (!user) return res.status(400).json({ error: 'البريد غير صحيح' });
    const isMatch = await bcrypt.compare(password, user.password);
    if (!isMatch) return res.status(400).json({ error: 'كلمة المرور غير صحيحة' });
    req.session.user = { id: user.id, username: user.username, avatar: user.avatar, provider: 'local' };
    res.json({ success: true });
});

// --- إدارة الجلسة والدفع ---
app.post('/api/logout', (req, res) => { req.session = null; res.json({ success: true }); });
app.get('/api/user', (req, res) => { if (req.session.user) res.json({ authenticated: true, user: req.session.user }); else res.json({ authenticated: false }); });

// (أبقِ أكواد الدفع Stripe و PayPal كما هي في الكود السابق)

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server running on http://localhost:${PORT}`));
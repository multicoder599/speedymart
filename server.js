require('dotenv').config();
const express = require('express');
const cors = require('cors');
const axios = require('axios');
const sqlite3 = require('sqlite3').verbose();
const bcrypt = require('bcryptjs');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;
const STORE_ID = PORT.toString(); // We use the Port (3007 or 3008) as the unique Store ID

app.use(cors());
app.use(express.json());
app.use(express.static('public')); 

// --- CONNECT TO SHARED DATABASE ---
// This assumes your admin folder is named 'speedymart-admin' and is right next to this folder
const dbPath = '/home/newuser/speedymart-admin/database.sqlite';
const db = new sqlite3.Database(dbPath, (err) => {
    if (err) console.error("Database connection error. Check path:", err);
    else console.log(`✅ Connected to Central Database as Store ID: ${STORE_ID}`);
});

const pendingTransactions = new Map();
let connectedClients = [];

// --- 1. NEW CASHIER LOGIN ENDPOINT ---
app.post('/api/login', (req, res) => {
    const { username, password } = req.body;
    
    // Look up the cashier for THIS specific store
    db.get("SELECT * FROM users WHERE username = ? AND store_id = ?", [username, STORE_ID], (err, user) => {
        if (err || !user) {
            return res.status(401).json({ success: false, message: "Invalid username or you are not assigned to this branch." });
        }
        
        if (bcrypt.compareSync(password, user.password)) {
            return res.status(200).json({ success: true, message: "Authentication successful." });
        } else {
            return res.status(401).json({ success: false, message: "Invalid password." });
        }
    });
});

// --- 2. INITIATE PAYMENT ENDPOINT (Unchanged) ---
app.post('/api/initiate-payment', async (req, res) => {
    const { amount, phoneNumber } = req.body;
    if (!amount || !phoneNumber) return res.status(400).json({ success: false, message: "Amount and Phone Number are required." });

    let formattedPhone = phoneNumber.replace(/\s+/g, '');
    if (formattedPhone.startsWith('0')) formattedPhone = '254' + formattedPhone.substring(1);
    else if (formattedPhone.startsWith('+')) formattedPhone = formattedPhone.substring(1);

    const reference = `POS-${Date.now()}`;
    const payload = {
        api_key:      process.env.MEGAPAY_API_KEY,
        email:        process.env.MEGAPAY_EMAIL,
        amount:       amount,
        msisdn:       formattedPhone,
        
        // --- CHANGED: Now points to the Boss Admin Broadcaster! ---
        callback_url: `http://213.199.41.83:3009/api/megapay/unified-webhook`, 
        // ----------------------------------------------------------
        
        description:  `Supermarket ${STORE_ID} Checkout`,
        reference:    reference
    };

    try {
        const mpRes = await axios.post('https://megapay.co.ke/backend/v1/initiatestk', payload, { headers: { 'Content-Type': 'application/json' }, timeout: 15000 });
        const mpData = mpRes.data;

        if (mpData && (mpData.status === false || mpData.success === false || mpData.ResponseCode === '1')) {
            return res.status(400).json({ success: false, message: mpData.errorMessage || mpData.message || 'MegaPay rejected the request.' });
        }

        pendingTransactions.set(reference, { status: 'Pending', amount, phone: formattedPhone });
        return res.status(200).json({ success: true, message: 'STK Push sent! Waiting for customer PIN.', refId: reference });

    } catch (mpErr) {
        return res.status(502).json({ success: false, message: 'Payment gateway failed to send STK push.' });
    }
});

app.get('/api/stream-payment/:refId', (req, res) => {
    const { refId } = req.params;
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    const client = { refId, res };
    connectedClients.push(client);
    req.on('close', () => { connectedClients = connectedClients.filter(c => c !== client); });
});

// --- 3. MEGAPAY WEBHOOK (Updated to save to DB) ---
app.post('/api/megapay/webhook', async (req, res) => {
    res.status(200).send("OK");
    const data = req.body;

    try {
        if ((data.ResponseCode !== undefined ? data.ResponseCode : data.ResultCode) != 0) return;

        const amount = parseFloat(data.TransactionAmount || data.amount || data.Amount);
        const receipt = data.TransactionReceipt || data.MpesaReceiptNumber;
        const last9 = (data.Msisdn || data.phone || data.PhoneNumber || "").toString().replace(/\D/g, '').slice(-9);
        
        let matchedRefId = null;
        for (let [refId, tx] of pendingTransactions.entries()) {
            if (tx.phone.endsWith(last9) && tx.amount == amount && tx.status === 'Pending') {
                tx.status = 'Paid';
                matchedRefId = refId;
                
                // --- NEW: Insert permanently into Shared SQLite Database ---
                db.run(`INSERT INTO transactions (store_id, ref_id, receipt, phone, amount) VALUES (?, ?, ?, ?, ?)`,
                    [STORE_ID, refId, receipt, tx.phone, amount]
                );
                // ----------------------------------------------------------
                break;
            }
        }

        if (matchedRefId) {
            connectedClients.forEach(client => {
                if (client.refId === matchedRefId) {
                    client.res.write(`data: ${JSON.stringify({ success: true, receipt: receipt })}\n\n`);
                }
            });
        }
    } catch (err) {
        console.error('Webhook processing error:', err);
    }
});

// --- 4. DAILY REPORT (Updated to read from DB) ---
app.get('/api/transactions/today', (req, res) => {
    // Queries the DB for transactions matching this store ID from today (adjusted for Kenyan UTC+3 timezone)
    const sql = `
        SELECT * FROM transactions 
        WHERE store_id = ? 
        AND date(created_at, '+3 hours') = date('now', '+3 hours') 
        ORDER BY created_at DESC
    `;
    
    db.all(sql, [STORE_ID], (err, rows) => {
        if (err) return res.status(500).json({ success: false });
        const totalAmount = rows.reduce((sum, tx) => sum + tx.amount, 0);
        res.status(200).json({ success: true, total: totalAmount, count: rows.length, transactions: rows });
    });
});

app.listen(PORT, () => { console.log(`🚀 POS Backend running on port ${PORT} (Store: ${STORE_ID})`); });
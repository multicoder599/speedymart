require('dotenv').config();
const express = require('express');
const cors = require('cors');
const axios = require('axios');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());
app.use(express.static('public')); 

// Store pending transactions temporarily in memory
const pendingTransactions = new Map();

// --- NEW: Array to hold active browser connections for SSE ---
let connectedClients = [];

// --- ADMIN LOGIN ENDPOINT ---
app.post('/api/verify-pin', (req, res) => {
    const { pin } = req.body;

    if (pin === process.env.ADMIN_PIN) {
        return res.status(200).json({ success: true, message: "Authentication successful." });
    } else {
        return res.status(401).json({ success: false, message: "Invalid PIN." });
    }
});

// --- 1. INITIATE PAYMENT ENDPOINT ---
app.post('/api/initiate-payment', async (req, res) => {
    const { amount, phoneNumber } = req.body;

    if (!amount || !phoneNumber) {
        return res.status(400).json({ success: false, message: "Amount and Phone Number are required." });
    }

    let formattedPhone = phoneNumber.replace(/\s+/g, '');
    if (formattedPhone.startsWith('0')) formattedPhone = '254' + formattedPhone.substring(1);
    else if (formattedPhone.startsWith('+')) formattedPhone = formattedPhone.substring(1);

    const reference = `POS-${Date.now()}`;

    // Exact payload structure from your snippet
    const payload = {
        api_key:      process.env.MEGAPAY_API_KEY,
        email:        process.env.MEGAPAY_EMAIL,
        amount:       amount,
        msisdn:       formattedPhone,
        callback_url: `${process.env.APP_URL}/api/megapay/webhook`,
        description:  'PrimePOS Supermarket Checkout',
        reference:    reference
    };

    try {
        const mpRes = await axios.post(
            'https://megapay.co.ke/backend/v1/initiatestk',
            payload,
            {
                headers: { 'Content-Type': 'application/json' },
                timeout: 15000
            }
        );

        const mpData = mpRes.data;
        console.log('MegaPay response:', JSON.stringify(mpData));

        if (mpData && (mpData.status === false || mpData.success === false || mpData.ResponseCode === '1')) {
            return res.status(400).json({
                success: false,
                message: mpData.errorMessage || mpData.message || 'MegaPay rejected the request.'
            });
        }

        // Save reference to track it when the webhook hits
        pendingTransactions.set(reference, { status: 'Pending', amount, phone: formattedPhone });

        return res.status(200).json({
            success: true,
            message: 'STK Push sent! Waiting for customer PIN.',
            refId: reference
        });

    } catch (mpErr) {
        console.error('MegaPay STK error:', mpErr.message);
        return res.status(502).json({
            success: false,
            message: 'Payment gateway failed to send STK push.'
        });
    }
});

// --- NEW: LIVE STATUS ENDPOINT (SSE) ---
// The frontend connects here and waits for the webhook signal
app.get('/api/stream-payment/:refId', (req, res) => {
    const { refId } = req.params;

    // Headers to keep connection open
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');

    const client = { refId, res };
    connectedClients.push(client);

    // Remove client if they close the tab
    req.on('close', () => {
        connectedClients = connectedClients.filter(c => c !== client);
    });
});

// --- 2. MEGAPAY WEBHOOK ENDPOINT ---
app.post('/api/megapay/webhook', async (req, res) => {
    // Acknowledge receipt immediately so MegaPay doesn't resend
    res.status(200).send("OK");
    
    const data = req.body;
    console.log("Webhook Received:", JSON.stringify(data));

    try {
        if ((data.ResponseCode !== undefined ? data.ResponseCode : data.ResultCode) != 0) {
            console.log("Failed transaction webhook received.");
            return;
        }

        const amount = parseFloat(data.TransactionAmount || data.amount || data.Amount);
        const receipt = data.TransactionReceipt || data.MpesaReceiptNumber;
        
        // Grab the last 9 digits of the phone number to match it securely
        const last9 = (data.Msisdn || data.phone || data.PhoneNumber || "").toString().replace(/\D/g, '').slice(-9);
        
        console.log(`✅ SUCCESSFUL POS PAYMENT: KES ${amount} | Receipt: ${receipt} | Phone: ${last9}`);

        // 1. Find the matching pending transaction
        let matchedRefId = null;
        for (let [refId, tx] of pendingTransactions.entries()) {
            if (tx.phone.endsWith(last9) && tx.amount == amount && tx.status === 'Pending') {
                tx.status = 'Paid';
                matchedRefId = refId;
                break;
            }
        }

        // 2. If matched, push the success message to the specific frontend tab waiting for it
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

app.listen(PORT, () => {
    console.log(`🚀 MegaPay Backend running on port ${PORT}`);
});
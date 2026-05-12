require('dotenv').config();
const express = require('express');
const cors = require('cors');
const axios = require('axios');
const sqlite3 = require('sqlite3').verbose();
const bcrypt = require('bcryptjs');
const path = require('path');

const app = express();
const PORT = 3009;

app.use(cors());
app.use(express.json());
app.use(express.static('public'));

const dbPath = path.resolve(__dirname, 'database.sqlite');
const db = new sqlite3.Database(dbPath, (err) => {
    if (err) console.error("Database error:", err);
    else console.log("✅ Connected to Shared SQLite Database");
});

db.serialize(() => {
    db.run(`CREATE TABLE IF NOT EXISTS users (id INTEGER PRIMARY KEY AUTOINCREMENT, username TEXT UNIQUE, password TEXT, role TEXT, store_id TEXT)`);
    db.run(`CREATE TABLE IF NOT EXISTS transactions (id INTEGER PRIMARY KEY AUTOINCREMENT, store_id TEXT, ref_id TEXT UNIQUE, receipt TEXT, phone TEXT, amount REAL, created_at DATETIME DEFAULT CURRENT_TIMESTAMP)`);

    // Creates a default admin ONLY if the database is completely empty
    db.get("SELECT * FROM users WHERE role = 'boss'", (err, row) => {
        if (!row) {
            const hash = bcrypt.hashSync('boss123', 10);
            db.run(`INSERT INTO users (username, password, role, store_id) VALUES ('admin', ?, 'boss', 'ALL')`, [hash]);
        }
    });
});

// Rolling 7-Day Deletion
function deleteOldTransactions() {
    const sql = `DELETE FROM transactions WHERE created_at < datetime('now', '-7 days')`;
    db.run(sql, function(err) {
        if (!err && this.changes > 0) console.log(`🧹 Auto-Cleanup: Deleted ${this.changes} transactions older than 7 days.`);
    });
}
deleteOldTransactions();
setInterval(deleteOldTransactions, 12 * 60 * 60 * 1000); 

// --- ADMIN ENDPOINTS ---

app.post('/api/admin/login', (req, res) => {
    const { username, password } = req.body;
    db.get("SELECT * FROM users WHERE username = ? AND role = 'boss'", [username], (err, user) => {
        if (err || !user) return res.status(401).json({ success: false, message: "Invalid credentials" });
        if (bcrypt.compareSync(password, user.password)) res.json({ success: true });
        else res.status(401).json({ success: false, message: "Invalid credentials" });
    });
});

// NEW: Update Boss Username and Password
app.put('/api/admin/settings', (req, res) => {
    const { newUsername, newPassword } = req.body;
    if (!newUsername || !newPassword) return res.status(400).json({ success: false, message: "Both fields required" });
    
    const hash = bcrypt.hashSync(newPassword, 10);
    db.run("UPDATE users SET username = ?, password = ? WHERE role = 'boss'", [newUsername, hash], (err) => {
        if (err) return res.status(500).json({ success: false, message: "Error updating credentials" });
        res.json({ success: true, message: "Credentials updated! Logging out..." });
    });
});

app.get('/api/admin/transactions', (req, res) => {
    const storeFilter = req.query.store_id;
    let sql = "SELECT * FROM transactions ORDER BY created_at DESC";
    let params = [];
    if (storeFilter && storeFilter !== 'ALL') {
        sql = "SELECT * FROM transactions WHERE store_id = ? ORDER BY created_at DESC";
        params = [storeFilter];
    }
    db.all(sql, params, (err, rows) => {
        if (err) return res.status(500).json({ success: false });
        res.json({ success: true, transactions: rows });
    });
});

app.post('/api/admin/cashiers', (req, res) => {
    const { username, password, store_id } = req.body;
    if (!username || !password || !store_id) return res.status(400).json({ success: false, message: "Missing fields" });
    const hash = bcrypt.hashSync(password, 10);
    db.run(`INSERT INTO users (username, password, role, store_id) VALUES (?, ?, 'cashier', ?)`, [username, hash, store_id], function(err) {
        if (err) return res.status(400).json({ success: false, message: "Username already exists" });
        res.json({ success: true, message: "Cashier created!" });
    });
});

app.get('/api/admin/cashiers', (req, res) => {
    db.all("SELECT id, username, store_id FROM users WHERE role = 'cashier'", [], (err, rows) => {
        res.json({ success: true, cashiers: rows });
    });
});

app.put('/api/admin/cashiers/:id', (req, res) => {
    const { username, password, store_id } = req.body;
    const { id } = req.params;

    if (password && password.trim() !== "") {
        const hash = bcrypt.hashSync(password, 10);
        db.run("UPDATE users SET username = ?, password = ?, store_id = ? WHERE id = ?", [username, hash, store_id, id], (err) => {
            if (err) return res.status(400).json({ success: false, message: "Error updating cashier" });
            res.json({ success: true, message: "Cashier updated with new password" });
        });
    } else {
        db.run("UPDATE users SET username = ?, store_id = ? WHERE id = ?", [username, store_id, id], (err) => {
            if (err) return res.status(400).json({ success: false, message: "Error updating cashier" });
            res.json({ success: true, message: "Cashier details updated" });
        });
    }
});

app.delete('/api/admin/cashiers/:id', (req, res) => {
    db.run("DELETE FROM users WHERE id = ?", [req.params.id], (err) => {
        if (err) return res.status(400).json({ success: false, message: "Error deleting cashier" });
        res.json({ success: true, message: "Cashier deleted" });
    });
});

// UNIFIED WEBHOOK BROADCASTER
app.post('/api/megapay/unified-webhook', (req, res) => {
    res.status(200).send("OK");
    const payload = req.body;
    console.log("📢 Unified Webhook Received! Broadcasting to branches...");
    const branches = ['3007', '3008']; 
    branches.forEach(port => {
        axios.post(`http://localhost:${port}/api/megapay/webhook`, payload).catch(err => {});
    });
});

app.listen(PORT, () => {
    console.log(`🚀 SpeedyMart Boss Panel running on port ${PORT}`);
});
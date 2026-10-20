'use strict';

const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const path = require('path');
require('dotenv').config();

require('./config/db');

// Import route modules
const authRoutes = require('./routes/authRoutes');
const { apiRateLimit } = require('./middleware/rateLimitMiddleware');
const assetRoutes = require('./routes/assetRoutes');
const assetAssignmentRoutes = require('./routes/assetAssignmentRoutes');
const transferRoutes = require('./routes/transferRoutes');
const maintenanceRoutes = require('./routes/maintenanceRoutes');
const warrantyRoutes = require('./routes/warrantyRoutes');
const stockRoutes = require('./routes/stockRoutes');
const barcodeRoutes = require('./routes/barcodeRoutes');
const verificationRoutes = require('./routes/verificationRoutes');
const disposalRoutes = require('./routes/disposalRoutes');
const licenceRoutes = require('./routes/licenceRoutes');
const reportRoutes = require('./routes/reportRoutes');
const assetDocumentRoutes = require('./routes/assetDocumentRoutes');
const referenceDataRoutes = require('./routes/referenceDataRoutes');
const procurementRoutes = require('./routes/procurementRoutes');

// Lifecycle modules own the idempotent DDL for their own tables so the app can
// be deployed without re-running scripts/initDb.js. Failures are logged rather
// than fatal: a permissions problem on a fresh database should not stop the
// register from serving.
const warrantyModel = require('./models/warrantyModel');
warrantyModel.ensureTable().catch((err) => {
    console.error('⚠️  Could not ensure the warranties table:', err.message);
});

const stockModel = require('./models/stockModel');
stockModel.ensureTable().catch((err) => {
    console.error('⚠️  Could not ensure the stock tables:', err.message);
});

const barcodeModel = require('./models/barcodeModel');
barcodeModel.ensureTable().catch((err) => {
    console.error('⚠️  Could not ensure the barcode tables:', err.message);
});

const verificationModel = require('./models/verificationModel');
verificationModel.ensureTables().catch((err) => {
    console.error('Could not ensure verification tables:', err.message);
});

const disposalModel = require('./models/disposalModel');
disposalModel.ensureTable().catch((err) => {
    console.error('Could not ensure disposal table:', err.message);
});

const licenceModel = require('./models/licenceModel');
licenceModel.ensureTables().catch((err) => {
    console.error('Could not ensure software licence tables:', err.message);
});

const assetDocumentModel = require('./models/assetDocumentModel');
assetDocumentModel.ensureTable().catch((err) => {
    console.error('Could not ensure asset document table:', err.message);
});

const referenceDataModel = require('./models/referenceDataModel');
referenceDataModel.ensureTables().catch((err) => {
    console.error('Could not ensure department and location tables:', err.message);
});

const assignmentModel = require('./models/assetAssignmentModel');
const transferModel = require('./models/transferModel');
const maintenanceModel = require('./models/maintenanceModel');
assignmentModel.ensureTable()
    .then(() => transferModel.ensureTable())
    .then(() => maintenanceModel.ensureTable())
    .catch((err) => {
        console.error('Could not ensure reporting tables:', err.message);
    });

const app = express();
const PORT = process.env.PORT || 3000;
const proxyHops = Number(process.env.TRUST_PROXY_HOPS || 0);

if (!Number.isSafeInteger(proxyHops) || proxyHops < 0) {
    throw new Error('TRUST_PROXY_HOPS must be a non-negative integer.');
}

app.set('trust proxy', proxyHops);

const allowedCorsOrigins = (process.env.CORS_ORIGINS || '')
    .split(',')
    .map((origin) => origin.trim())
    .filter(Boolean);

app.use(helmet({
    contentSecurityPolicy: {
        directives: {
            defaultSrc: ["'self'"],
            baseUri: ["'self'"],
            connectSrc: ["'self'"],
            fontSrc: ["'self'", 'data:'],
            formAction: ["'self'"],
            frameAncestors: ["'none'"],
            imgSrc: ["'self'", 'data:', 'blob:'],
            objectSrc: ["'none'"],
            scriptSrc: ["'self'"],
            styleSrc: ["'self'", "'unsafe-inline'"]
        }
    },
    frameguard: { action: 'deny' },
    hsts: process.env.NODE_ENV === 'production'
}));
app.use(cors({
    origin(origin, callback) {
        if (!origin || allowedCorsOrigins.includes(origin)) return callback(null, true);
        return callback(null, false);
    }
}));
app.use('/api', apiRateLimit);
app.use(express.json({ limit: '1mb' }));
app.use(express.urlencoded({ extended: false, limit: '1mb', parameterLimit: 100 }));
app.use((req, res, next) => {
    const isUnsafeMethod = !['GET', 'HEAD', 'OPTIONS'].includes(req.method);
    const hasSessionCookie = String(req.headers.cookie || '').includes('nbsz_session=');
    const origin = req.get('origin');
    if (
        isUnsafeMethod &&
        hasSessionCookie &&
        origin !== `${req.protocol}://${req.get('host')}`
    ) {
        return res.status(403).json({
            status: 'error',
            message: 'Cross-origin session requests are not allowed.'
        });
    }
    return next();
});

// Serve static frontend files from the 'public' directory
app.use(express.static(path.join(__dirname, 'public')));

// --- Basic Health Check Route ---
app.get('/api/health', (req, res) => {
    res.json({
        status: 'success',
        message: 'NBSZ Asset Management System API is running smoothly.',
        timestamp: new Date().toISOString()
    });
});

// --- API Routes ---
// NOTE: every API router must be mounted BEFORE the global error handler,
// otherwise handler-level errors would fall through to Express's default
// handler instead of our JSON error envelope.
app.use('/api/auth', authRoutes);
app.use('/api/assets', assetRoutes);
app.use('/api/assignments', assetAssignmentRoutes);
app.use('/api/transfers', transferRoutes);
app.use('/api/maintenance', maintenanceRoutes);
app.use('/api/warranties', warrantyRoutes);
app.use('/api/stock', stockRoutes);
app.use('/api/barcode', barcodeRoutes);
app.use('/api/verifications', verificationRoutes);
app.use('/api/disposals', disposalRoutes);
app.use('/api/licences', licenceRoutes);
app.use('/api/reports', reportRoutes);
app.use('/api/assets', assetDocumentRoutes);
app.use('/api/reference-data', referenceDataRoutes);
app.use('/api/procurement', procurementRoutes);

// --- Root Route (Serves the frontend index.html for now) ---
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// --- 404 Handler (kept just before the error handler) ---
app.use((req, res) => {
    res.status(404).json({
        status: 'error',
        message: `Route not found: ${req.method} ${req.originalUrl}`
    });
});

// --- Global Error Handler ---
app.use((err, req, res, next) => {
    console.error(err.stack);

    // Malformed JSON bodies are reported by express.json() as a SyntaxError.
    if (err.type === 'entity.parse.failed' || err instanceof SyntaxError) {
        return res.status(400).json({
            status: 'error',
            message: 'Invalid JSON in the request body.'
        });
    }

    // MySQL duplicate-key errors (unique username / email) surface as 1062.
    if (err.code === 'ER_DUP_ENTRY') {
        return res.status(409).json({
            status: 'error',
            message: 'A record with those details already exists.'
        });
    }

    res.status(err.status || 500).json({
        status: 'error',
        message:
            process.env.NODE_ENV === 'development'
                ? err.message
                : 'Something went wrong on the server.'
    });
});

// --- Start the Server ---
app.listen(PORT, () => {
    console.log(`\n======================================================`);
    console.log(`🚀 NBSZ Asset Management System API is running!`);
    console.log(`🌐 URL: http://localhost:${PORT}`);
    console.log(`🛠️  Environment: ${process.env.NODE_ENV}`);
    console.log(`======================================================\n`);
});

module.exports = app;

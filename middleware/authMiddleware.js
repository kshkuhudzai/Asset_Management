'use strict';

// middleware/authMiddleware.js
// JWT verification middleware. Every protected route passes through `protect`
// which validates the bearer token, loads the live user record and rejects
// tokens whose account has since been deactivated or whose role has changed.

const jwt = require('jsonwebtoken');
const userModel = require('../models/userModel');
const { errorResponse } = require('../utils/helpers');

const JWT_SECRET = process.env.JWT_SECRET;
const JWT_EXPIRES_IN = process.env.JWT_EXPIRES_IN || '1d';
const AUTH_COOKIE_NAME = 'nbsz_session';

// Fail fast at startup rather than issuing tokens signed with `undefined`.
if (!JWT_SECRET) {
    throw new Error(
        'JWT_SECRET is not defined. Add it to your .env file before starting the server.'
    );
}

/**
 * Signs a JWT for an authenticated user.
 *
 * @param {object} user A users-table row (must contain id, username, role).
 * @returns {string} The signed token.
 */
function generateToken(user) {
    return jwt.sign(
        {
            id: user.id,
            username: user.username,
            role: user.role
        },
        JWT_SECRET,
        { expiresIn: JWT_EXPIRES_IN }
    );
}

/**
 * Extracts a bearer token from the Authorization header.
 *
 * @param {import('express').Request} req
 * @returns {string|null}
 */
function extractToken(req) {
    const header = req.headers.authorization || req.headers.Authorization;
    if (header && typeof header === 'string') {
        const parts = header.split(' ');
        if (parts.length === 2 && /^Bearer$/i.test(parts[0])) {
            const token = parts[1].trim();
            if (token) return token;
        }
    }

    const cookies = String(req.headers.cookie || '').split(';');
    const entry = cookies.find((cookie) =>
        cookie.trim().startsWith(`${AUTH_COOKIE_NAME}=`)
    );
    if (!entry) return null;

    return entry.trim().slice(AUTH_COOKIE_NAME.length + 1);
}

/**
 * Verifies the request token and attaches the fresh user record to `req.user`.
 * Responds 401 for missing/invalid tokens and 403 for disabled accounts.
 *
 * @type {import('express').RequestHandler}
 */
async function protect(req, res, next) {
    const token = extractToken(req);

    if (!token) {
        return res
            .status(401)
            .json(errorResponse('Authentication required. Please log in.'));
    }

    let decoded;
    try {
        decoded = jwt.verify(token, JWT_SECRET);
    } catch (err) {
        const message =
            err.name === 'TokenExpiredError'
                ? 'Your session has expired. Please log in again.'
                : 'Invalid authentication token. Please log in again.';
        return res.status(401).json(errorResponse(message));
    }

    try {
        // Always re-read the user so role changes / deactivations take effect
        // immediately instead of waiting for the token to expire.
        const user = await userModel.findById(decoded.id);

        if (!user) {
            return res
                .status(401)
                .json(errorResponse('The account linked to this session no longer exists.'));
        }

        if (!user.is_active) {
            return res
                .status(403)
                .json(errorResponse('This account has been deactivated. Contact the System Administrator.'));
        }

        if (
            user.must_change_password &&
            !(req.baseUrl === '/api/auth' &&
                ['/me', '/change-password', '/logout'].includes(req.path))
        ) {
            return res.status(403).json(
                errorResponse('Change your temporary password before using the application.')
            );
        }

        req.user = user;      // full, sanitised user row
        req.token = token;    // kept for logout bookkeeping / debugging
        return next();
    } catch (err) {
        return next(err);
    }
}

/**
 * Attaches `req.user` when a valid token is present but never blocks the
 * request. Useful for endpoints that enrich their response for logged-in users.
 *
 * @type {import('express').RequestHandler}
 */
async function optionalAuth(req, res, next) {
    const token = extractToken(req);
    if (!token) return next();

    try {
        const decoded = jwt.verify(token, JWT_SECRET);
        const user = await userModel.findById(decoded.id);
        if (user && user.is_active) req.user = user;
    } catch (err) {
        // Silently ignore - authentication is optional here.
    }

    return next();
}

module.exports = {
    protect,
    optionalAuth,
    generateToken,
    extractToken,
    JWT_SECRET,
    JWT_EXPIRES_IN,
    AUTH_COOKIE_NAME
};

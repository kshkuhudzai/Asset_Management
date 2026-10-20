'use strict';

// middleware/rbacMiddleware.js
// Role-Based Access Control. Works on top of `protect` (authMiddleware) which
// populates `req.user` with the live user record.

const { errorResponse } = require('../utils/helpers');

/**
 * The five roles defined by the `users.role` ENUM in the database schema.
 */
const ROLES = Object.freeze({
    ADMIN: 'System Administrator',
    HISO: 'HISO',
    ICT_OFFICER: 'ICT Officer',
    DEPARTMENTAL_USER: 'Departmental User',
    AUDITOR: 'Auditor'
});

const ALL_ROLES = Object.freeze(Object.values(ROLES));

/**
 * Returns middleware that allows the request only when `req.user.role` is one
 * of the supplied roles.
 *
 * Usage:
 *   router.post('/', protect, authorize(ROLES.ADMIN, ROLES.HISO), handler);
 *
 * @param {...string} allowedRoles
 * @returns {import('express').RequestHandler}
 */
function authorize(...allowedRoles) {
    // Support both authorize('A','B') and authorize(['A','B']).
    const roles = allowedRoles.flat().filter(Boolean);

    return function authorizeMiddleware(req, res, next) {
        if (!req.user) {
            return res
                .status(401)
                .json(errorResponse('Authentication required. Please log in.'));
        }

        if (!roles.includes(req.user.role)) {
            return res
                .status(403)
                .json(
                    errorResponse(
                        'Access denied. You do not have permission to perform this action.'
                    )
                );
        }

        return next();
    };
}

/**
 * Shorthand: only System Administrators may proceed.
 * @type {import('express').RequestHandler}
 */
const adminOnly = authorize(ROLES.ADMIN);

/**
 * Shorthand: System Administrators and HISO users may proceed. HISO is the
 * organisation's Information Security Officer and shares administrative
 * duties over the asset register.
 * @type {import('express').RequestHandler}
 */
const adminOrHiso = authorize(ROLES.ADMIN, ROLES.HISO);

/**
 * Shorthand: read-oriented access for every authenticated role.
 * This is effectively a no-op after `protect`, but keeping it explicit makes
 * route definitions self-documenting.
 * @type {import('express').RequestHandler}
 */
const anyAuthenticated = authorize(ALL_ROLES);

/**
 * Allows the request when the acting user is an administrator **or** the
 * request targets the acting user's own record. Used for "edit my profile".
 *
 * Reads the id from `req.params.id` or `req.params.userId`.
 *
 * @returns {import('express').RequestHandler}
 */
function selfOrAdmin() {
    return function selfOrAdminMiddleware(req, res, next) {
        if (!req.user) {
            return res
                .status(401)
                .json(errorResponse('Authentication required. Please log in.'));
        }

        const targetId = Number(req.params.id ?? req.params.userId);
        const isSelf = Number.isInteger(targetId) && targetId === Number(req.user.id);

        if (req.user.role !== ROLES.ADMIN && !isSelf) {
            return res
                .status(403)
                .json(
                    errorResponse(
                        'Access denied. You may only modify your own profile.'
                    )
                );
        }

        return next();
    };
}

/**
 * Validates that a role string is one of the enum values.
 *
 * @param {string} role
 * @returns {boolean}
 */
function isValidRole(role) {
    return ALL_ROLES.includes(role);
}

module.exports = {
    ROLES,
    ALL_ROLES,
    authorize,
    adminOnly,
    adminOrHiso,
    anyAuthenticated,
    selfOrAdmin,
    isValidRole
};

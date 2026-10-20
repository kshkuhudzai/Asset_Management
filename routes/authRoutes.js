'use strict';

// routes/authRoutes.js
// Authentication and user-management endpoints, mounted at /api/auth.
// Route order matters: literal paths such as /users must be declared before
// any parameterised path that could shadow them.

const express = require('express');
const authController = require('../controllers/authController');
const { protect } = require('../middleware/authMiddleware');
const { authorize, adminOnly, ROLES } = require('../middleware/rbacMiddleware');
const { loginRateLimit } = require('../middleware/rateLimitMiddleware');

const router = express.Router();

/* -------------------------------------------------------------------------- */
/* Public routes                                                              */
/* -------------------------------------------------------------------------- */

// POST /api/auth/login      - issue a JWT for valid credentials
router.post('/login', loginRateLimit, authController.login);

// POST /api/auth/logout     - audit-log the event (tokens are stateless)
router.post('/logout', authController.logout);

/* -------------------------------------------------------------------------- */
/* Authenticated routes                                                       */
/* -------------------------------------------------------------------------- */

// GET   /api/auth/me            - current user profile from the JWT
router.get('/me', protect, authController.getMe);

// PATCH /api/auth/me            - update own profile (name, email, username)
router.patch('/me', protect, authController.updateMe);

// POST  /api/auth/change-password - verify current password, set a new one
router.post('/change-password', protect, authController.changePassword);

/* -------------------------------------------------------------------------- */
/* Administrator user management                                              */
/* -------------------------------------------------------------------------- */

// POST   /api/auth/register   - create a new user
router.post(
    '/register',
    protect,
    authorize(ROLES.ADMIN, ROLES.HISO),
    authController.register
);

// GET    /api/auth/users      - list / search users with pagination
router.get('/users', protect, authorize(ROLES.ADMIN, ROLES.HISO), authController.getAllUsers);

// GET    /api/auth/users/:id  - fetch a single user
router.get(
    '/users/:id',
    protect,
    authorize(ROLES.ADMIN, ROLES.HISO, ROLES.AUDITOR),
    authController.getUserById
);

// PUT    /api/auth/users/:id  - update profile / role / status
router.put('/users/:id', protect, adminOnly, authController.updateUser);

// DELETE /api/auth/users/:id  - soft delete (sets is_active = 0)
router.delete('/users/:id', protect, adminOnly, authController.deleteUser);

// PATCH  /api/auth/users/:id/activate   - re-enable a soft-deleted user
router.patch('/users/:id/activate', protect, adminOnly, authController.activateUser);

// POST   /api/auth/users/:id/reset-password - admin resets another user's password
router.post(
    '/users/:id/reset-password',
    protect,
    adminOnly,
    authController.resetUserPassword
);

/* -------------------------------------------------------------------------- */
/* Audit trail (Auditor + Administrators)                                     */
/* -------------------------------------------------------------------------- */

// GET /api/auth/audit-logs - paginated audit trail with filters
router.get(
    '/audit-logs',
    protect,
    authorize(ROLES.ADMIN, ROLES.AUDITOR),
    authController.getAuditLogs
);

module.exports = router;

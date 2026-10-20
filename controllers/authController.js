'use strict';

// controllers/authController.js
// Authentication + user administration.
//
// Endpoints
//   POST   /api/auth/login
//   POST   /api/auth/logout
//   GET    /api/auth/me
//   PATCH  /api/auth/me
//   POST   /api/auth/change-password
//   POST   /api/auth/register
//   GET    /api/auth/users
//   GET    /api/auth/users/:id
//   PUT    /api/auth/users/:id
//   DELETE /api/auth/users/:id
//   PATCH  /api/auth/users/:id/activate
//   POST   /api/auth/users/:id/reset-password
//   GET    /api/auth/audit-logs
//
// Conventions:
//   * bcryptjs v3 exposes named exports: { hash, compare }.
//   * Handlers are async; Express 5 forwards rejected promises to the global
//     error handler, so no try/catch wrapper is needed for unexpected errors.
//   * Responses always use the shared { status, message, data } envelope.
//   * Users are soft-deleted (is_active = 0) and never physically removed.

const { hash, compare } = require('bcryptjs');

const userModel = require('../models/userModel');
const auditModel = require('../models/auditModel');
const {
    generateToken,
    AUTH_COOKIE_NAME,
    JWT_EXPIRES_IN
} = require('../middleware/authMiddleware');
const { auditLog } = require('../middleware/auditMiddleware');
const { ROLES, isValidRole, ALL_ROLES } = require('../middleware/rbacMiddleware');
const {
    sanitizeUser,
    normalizeString,
    isValidEmail,
    getClientIp,
    successResponse,
    errorResponse
} = require('../utils/helpers');

// bcrypt cost factor. 12 rounds is a good balance for an internal LOB system.
const SALT_ROUNDS = 12;

// Minimum password length enforced for every create / change / reset.
const MIN_PASSWORD_LENGTH = 8;
const SESSION_COOKIE_OPTIONS = Object.freeze({
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'strict',
    path: '/api'
});

function cookieMaxAge() {
    const match = /^(\d+)([smhd])?$/.exec(String(JWT_EXPIRES_IN));
    if (!match) return undefined;
    const unit = match[2] || 's';
    const multipliers = { s: 1000, m: 60000, h: 3600000, d: 86400000 };
    return Number(match[1]) * multipliers[unit];
}

/**
 * Collects field-level validation errors into a `[{field, message}]` array.
 */
function pushError(errors, field, message) {
    errors.push({ field, message });
}

/**
 * Validates password strength. Returns the list of problem descriptions
 * (empty when the password is acceptable).
 */
function validatePasswordStrength(password) {
    const problems = [];

    if (!password || password.length < MIN_PASSWORD_LENGTH) {
        problems.push(`Password must be at least ${MIN_PASSWORD_LENGTH} characters long.`);
    }
    if (password && !/[A-Z]/.test(password)) {
        problems.push('Password must contain at least one uppercase letter.');
    }
    if (password && !/[a-z]/.test(password)) {
        problems.push('Password must contain at least one lowercase letter.');
    }
    if (password && !/[0-9]/.test(password)) {
        problems.push('Password must contain at least one number.');
    }
    if (password && !/[^A-Za-z0-9\s]/.test(password)) {
        problems.push('Password must contain at least one special character.');
    }

    return problems;
}

/* ========================================================================== */
/* POST /api/auth/login                                                       */
/* ========================================================================== */

/**
 * Authenticates a user and returns a JWT plus the sanitised profile.
 *
 * Body: { username, password }
 * - `username` may also be the account email, which is convenient for users
 *   who forget which identifier they registered with.
 *
 * A generic message is returned for both "unknown user" and "wrong password"
 * so the endpoint cannot be used to enumerate valid accounts.
 */
async function login(req, res) {
    const identifier = normalizeString(req.body.username || req.body.email);
    const password = req.body.password ? String(req.body.password) : '';

    const errors = [];
    if (!identifier) pushError(errors, 'username', 'Username is required.');
    if (!password) pushError(errors, 'password', 'Password is required.');

    if (errors.length) {
        return res.status(400).json(errorResponse('Validation failed.', errors));
    }

    const ip = getClientIp(req);

    // Look the account up by username, falling back to email.
    let user = await userModel.findByUsername(identifier);
    if (!user && isValidEmail(identifier)) {
        user = await userModel.findByEmail(identifier);
    }

    // An unknown identifier still gets an audit row (record_id 0) so the trail
    // records the attack pattern even when no account matched.
    if (!user) {
        await auditLog({
            userId: null,
            action: 'FAILED_LOGIN',
            tableName: 'users',
            recordId: 0,
            newValues: { identifier, reason: 'Unknown account' },
            ipAddress: ip
        });

        return res
            .status(401)
            .json(errorResponse('Invalid username or password.'));
    }

    if (!user.is_active) {
        await auditLog({
            userId: user.id,
            action: 'FAILED_LOGIN',
            tableName: 'users',
            recordId: user.id,
            newValues: { identifier, reason: 'Account deactivated' },
            ipAddress: ip
        });

        return res
            .status(403)
            .json(
                errorResponse(
                    'This account has been deactivated. Please contact the System Administrator.'
                )
            );
    }

    const passwordMatches = await compare(password, user.password_hash);

    if (!passwordMatches) {
        await auditLog({
            userId: user.id,
            action: 'FAILED_LOGIN',
            tableName: 'users',
            recordId: user.id,
            newValues: { identifier, reason: 'Incorrect password' },
            ipAddress: ip
        });

        return res
            .status(401)
            .json(errorResponse('Invalid username or password.'));
    }

    const token = generateToken(user);
    res.cookie(AUTH_COOKIE_NAME, token, {
        ...SESSION_COOKIE_OPTIONS,
        maxAge: cookieMaxAge()
    });

    await auditLog({
        userId: user.id,
        action: 'LOGIN',
        tableName: 'users',
        recordId: user.id,
        newValues: { username: user.username, role: user.role },
        ipAddress: ip
    });

    const data = { user: sanitizeUser(user) };
    if (process.env.NODE_ENV !== 'production') data.token = token;
    return res.status(200).json(successResponse('Login successful.', data));
}


/* ========================================================================== */
/* POST /api/auth/logout                                                      */
/* ========================================================================== */

/**
 * Records the logout event. JWTs are stateless, so the client is responsible
 * for discarding the token; the audit trail is the server-side effect.
 *
 * `optionalAuth`-style behaviour: the handler works whether or not a valid
 * token accompanied the request, but identifies the user when possible.
 */
async function logout(req, res) {
    res.clearCookie(AUTH_COOKIE_NAME, SESSION_COOKIE_OPTIONS);
    const ip = getClientIp(req);

    if (req.user) {
        await auditLog({
            userId: req.user.id,
            action: 'LOGOUT',
            tableName: 'users',
            recordId: req.user.id,
            newValues: { username: req.user.username },
            ipAddress: ip
        });
    }

    return res
        .status(200)
        .json(successResponse('You have been logged out successfully.'));
}

/* ========================================================================== */
/* GET /api/auth/me                                                           */
/* ========================================================================== */

/**
 * Returns the profile of the currently authenticated user.
 * `protect` has already reloaded the record from the database.
 */
async function getMe(req, res) {
    return res
        .status(200)
        .json(successResponse('Profile retrieved successfully.', {
            user: sanitizeUser(req.user)
        }));
}

/* ========================================================================== */
/* PATCH /api/auth/me                                                         */
/* ========================================================================== */

/**
 * Lets a signed-in user update their own profile. Role and active status are
 * deliberately excluded - only a System Administrator may change those.
 *
 * Body (all optional): { full_name, email, username }
 */
async function updateMe(req, res) {
    const errors = [];

    const fullName = req.body.full_name !== undefined
        ? normalizeString(req.body.full_name)
        : undefined;
    const email = req.body.email !== undefined
        ? normalizeString(req.body.email).toLowerCase()
        : undefined;
    const username = req.body.username !== undefined
        ? normalizeString(req.body.username)
        : undefined;

    if (fullName !== undefined && !fullName) {
        pushError(errors, 'full_name', 'Full name cannot be empty.');
    }
    if (email !== undefined && !isValidEmail(email)) {
        pushError(errors, 'email', 'Please provide a valid email address.');
    }
    if (username !== undefined && username.length < 3) {
        pushError(errors, 'username', 'Username must be at least 3 characters long.');
    }

    if (errors.length) {
        return res.status(400).json(errorResponse('Validation failed.', errors));
    }

    // Uniqueness checks (excluding the user's own row).
    if (email !== undefined && email !== req.user.email) {
        const clash = await userModel.findByEmail(email);
        if (clash && Number(clash.id) !== Number(req.user.id)) {
            return res
                .status(409)
                .json(errorResponse('That email address is already in use.'));
        }
    }
    if (username !== undefined && username !== req.user.username) {
        const clash = await userModel.findByUsername(username);
        if (clash && Number(clash.id) !== Number(req.user.id)) {
            return res.status(409).json(errorResponse('That username is already taken.'));
        }
    }

    const before = sanitizeUser(req.user);
    const updated = await userModel.update(req.user.id, {
        fullName,
        email,
        username
    });

    await auditLog({
        userId: req.user.id,
        action: 'UPDATE',
        tableName: 'users',
        recordId: req.user.id,
        oldValues: before,
        newValues: sanitizeUser(updated),
        ipAddress: getClientIp(req)
    });

    return res
        .status(200)
        .json(successResponse('Your profile has been updated successfully.', {
            user: sanitizeUser(updated)
        }));
}

/* ========================================================================== */
/* POST /api/auth/change-password                                             */
/* ========================================================================== */

/**
 * Changes the signed-in user's own password.
 * The current password must be supplied and verified before the new one is
 * accepted, so a stolen token alone cannot lock the owner out.
 *
 * Body: { current_password, new_password, confirm_password? }
 */
async function changePassword(req, res) {
    const errors = [];
    const currentPassword = req.body.current_password ? String(req.body.current_password) : '';
    const newPassword = req.body.new_password ? String(req.body.new_password) : '';
    const confirmPassword = req.body.confirm_password !== undefined
        ? String(req.body.confirm_password)
        : null;

    if (!currentPassword) {
        pushError(errors, 'current_password', 'Your current password is required.');
    }
    if (!newPassword) {
        pushError(errors, 'new_password', 'A new password is required.');
    }
    if (confirmPassword !== null && newPassword !== confirmPassword) {
        pushError(errors, 'confirm_password', 'The password confirmation does not match.');
    }

    if (errors.length) {
        return res.status(400).json(errorResponse('Validation failed.', errors));
    }

    // Fetch the row WITH the hash - `req.user` is deliberately sanitised.
    const user = await userModel.findByIdWithPassword(req.user.id);
    if (!user) {
        return res.status(404).json(errorResponse('User account not found.'));
    }

    const currentMatches = await compare(currentPassword, user.password_hash);
    if (!currentMatches) {
        await auditLog({
            userId: user.id,
            action: 'FAILED_PASSWORD_CHANGE',
            tableName: 'users',
            recordId: user.id,
            newValues: { reason: 'Incorrect current password' },
            ipAddress: getClientIp(req)
        });

        return res
            .status(400)
            .json(errorResponse('Your current password is incorrect.'));
    }

    if (currentPassword === newPassword) {
        return res
            .status(400)
            .json(
                errorResponse(
                    'Validation failed.',
                    [
                        {
                            field: 'new_password',
                            message: 'The new password must be different from your current password.'
                        }
                    ]
                )
            );
    }

    const strengthProblems = validatePasswordStrength(newPassword);
    if (strengthProblems.length) {
        return res
            .status(400)
            .json(
                errorResponse(
                    'Validation failed.',
                    strengthProblems.map((message) => ({
                        field: 'new_password',
                        message
                    }))
                )
            );
    }

    const newHash = await hash(newPassword, SALT_ROUNDS);
    await userModel.updatePassword(user.id, newHash, false);

    await auditLog({
        userId: user.id,
        action: 'CHANGE_PASSWORD',
        tableName: 'users',
        recordId: user.id,
        newValues: { username: user.username },
        ipAddress: getClientIp(req)
    });

    return res
        .status(200)
        .clearCookie(AUTH_COOKIE_NAME, SESSION_COOKIE_OPTIONS)
        .json(
            successResponse(
                'Your password has been changed successfully. Please log in again.',
                // The client should discard its stored token and re-authenticate.
                { requireReLogin: true }
            )
        );
}

/* ========================================================================== */
/* POST /api/auth/register          (System Administrator / HISO)             */
/* ========================================================================== */

/**
 * Creates a new user account. Passwords are hashed with bcrypt before they
 * ever reach the database.
 *
 * Body: { username, password, email, full_name, role, is_active?, must_change_password? }
 */
async function register(req, res) {
    const errors = [];

    const username = normalizeString(req.body.username);
    const password = req.body.password ? String(req.body.password) : '';
    const email = normalizeString(req.body.email).toLowerCase();
    const fullName = normalizeString(req.body.full_name);
    const role = normalizeString(req.body.role);
    const rawMustChangePassword = req.body.must_change_password;
    let mustChangePassword = true;
    if (rawMustChangePassword !== undefined) {
        if ([true, 'true', 1, '1'].includes(rawMustChangePassword)) {
            mustChangePassword = true;
        } else if ([false, 'false', 0, '0'].includes(rawMustChangePassword)) {
            mustChangePassword = false;
        } else {
            pushError(errors, 'must_change_password', 'must_change_password must be true or false.');
        }
    }
    const isActive = req.body.is_active === undefined
        ? true
        : req.body.is_active === true ||
          req.body.is_active === 'true' ||
          req.body.is_active === 1 ||
          req.body.is_active === '1';

    if (!username) {
        pushError(errors, 'username', 'Username is required.');
    } else if (username.length < 3) {
        pushError(errors, 'username', 'Username must be at least 3 characters long.');
    } else if (!/^[A-Za-z0-9._-]+$/.test(username)) {
        pushError(
            errors,
            'username',
            'Username may only contain letters, numbers, dots, underscores and hyphens.'
        );
    }

    if (!email) {
        pushError(errors, 'email', 'Email address is required.');
    } else if (!isValidEmail(email)) {
        pushError(errors, 'email', 'Please provide a valid email address.');
    }

    if (!fullName) {
        pushError(errors, 'full_name', 'Full name is required.');
    }

    if (!role) {
        pushError(errors, 'role', 'Role is required.');
    } else if (!isValidRole(role)) {
        pushError(errors, 'role', `Role must be one of: ${ALL_ROLES.join(', ')}.`);
    }

    validatePasswordStrength(password).forEach((message) =>
        pushError(errors, 'password', message)
    );

    if (errors.length) {
        return res.status(400).json(errorResponse('Validation failed.', errors));
    }

    // HISO users may not create System Administrators - that stays with the
    // System Administrator role alone.
    if (role === ROLES.ADMIN && req.user.role !== ROLES.ADMIN) {
        return res
            .status(403)
            .json(
                errorResponse(
                    'Only a System Administrator may create another System Administrator.'
                )
            );
    }

    const usernameClash = await userModel.findByUsername(username);
    if (usernameClash) {
        return res
            .status(409)
            .json(errorResponse('That username is already taken.'));
    }

    const emailClash = await userModel.findByEmail(email);
    if (emailClash) {
        return res
            .status(409)
            .json(errorResponse('That email address is already registered.'));
    }

    const passwordHash = await hash(password, SALT_ROUNDS);

    const created = await userModel.create({
        username,
        passwordHash,
        email,
        fullName,
        role,
        isActive,
        mustChangePassword
    });

    await auditLog({
        userId: req.user.id,
        action: 'CREATE',
        tableName: 'users',
        recordId: created.id,
        newValues: sanitizeUser(created),
        ipAddress: getClientIp(req)
    });

    return res
        .status(201)
        .json(successResponse('User account created successfully.', {
            user: sanitizeUser(created)
        }));
}

/* ========================================================================== */
/* GET /api/auth/users              (System Administrator / HISO)             */
/* ========================================================================== */

/**
 * Lists users with optional filtering, searching and pagination.
 *
 * Query: ?search=&role=&is_active=&limit=&offset=
 */
async function getAllUsers(req, res) {
    const errors = [];

    const search = normalizeString(req.query.search) || undefined;
    const role = normalizeString(req.query.role) || undefined;

    let isActive;
    if (req.query.is_active !== undefined && req.query.is_active !== '') {
        const raw = String(req.query.is_active).toLowerCase();
        if (['1', 'true', 'yes', 'active'].includes(raw)) isActive = true;
        else if (['0', 'false', 'no', 'inactive'].includes(raw)) isActive = false;
        else pushError(errors, 'is_active', 'is_active must be true or false.');
    }

    if (role && !isValidRole(role)) {
        pushError(errors, 'role', `Role must be one of: ${ALL_ROLES.join(', ')}.`);
    }

    if (errors.length) {
        return res.status(400).json(errorResponse('Validation failed.', errors));
    }

    // Guard the pagination bounds so a rogue ?limit=100000 cannot hammer MySQL.
    const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 50, 1), 200);
    const offset = Math.max(parseInt(req.query.offset, 10) || 0, 0);

    const { users, total } = await userModel.findAll({
        search,
        role,
        isActive,
        limit,
        offset
    });

    return res.status(200).json(
        successResponse('Users retrieved successfully.', {
            users: users.map(sanitizeUser),
            pagination: {
                total,
                limit,
                offset,
                returned: users.length
            },
            availableRoles: ALL_ROLES
        })
    );
}

/* ========================================================================== */
/* GET /api/auth/users/:id          (Admin / HISO / Auditor)                  */
/* ========================================================================== */

/**
 * Returns a single user by id. Auditors may read any account; other roles may
 * only read their own (enforced below because this route is not admin-only).
 */
async function getUserById(req, res) {
    const id = parseInt(req.params.id, 10);

    if (!Number.isInteger(id) || id < 1) {
        return res
            .status(400)
            .json(errorResponse('A valid numeric user id is required.'));
    }

    const isPrivilegedReader = [ROLES.ADMIN, ROLES.HISO, ROLES.AUDITOR].includes(
        req.user.role
    );

    if (!isPrivilegedReader && id !== Number(req.user.id)) {
        return res
            .status(403)
            .json(errorResponse('Access denied. You may only view your own profile.'));
    }

    const user = await userModel.findById(id);

    if (!user) {
        return res.status(404).json(errorResponse('User account not found.'));
    }

    return res
        .status(200)
        .json(successResponse('User retrieved successfully.', {
            user: sanitizeUser(user)
        }));
}

/* ========================================================================== */
/* PUT /api/auth/users/:id          (System Administrator only)               */
/* ========================================================================== */

/**
 * Administrative update of another user's account: profile fields, role and
 * active status.
 *
 * Body (all optional): { username, email, full_name, role, is_active }
 */
async function updateUser(req, res) {
    const id = parseInt(req.params.id, 10);

    if (!Number.isInteger(id) || id < 1) {
        return res
            .status(400)
            .json(errorResponse('A valid numeric user id is required.'));
    }

    const target = await userModel.findById(id);
    if (!target) {
        return res.status(404).json(errorResponse('User account not found.'));
    }

    const errors = [];
    const updates = {};

    if (req.body.username !== undefined) {
        const username = normalizeString(req.body.username);
        if (username.length < 3) {
            pushError(errors, 'username', 'Username must be at least 3 characters long.');
        } else {
            updates.username = username;
        }
    }

    if (req.body.email !== undefined) {
        const email = normalizeString(req.body.email).toLowerCase();
        if (!isValidEmail(email)) {
            pushError(errors, 'email', 'Please provide a valid email address.');
        } else {
            updates.email = email;
        }
    }

    if (req.body.full_name !== undefined) {
        const fullName = normalizeString(req.body.full_name);
        if (!fullName) {
            pushError(errors, 'full_name', 'Full name cannot be empty.');
        } else {
            updates.fullName = fullName;
        }
    }

    if (req.body.role !== undefined) {
        const role = normalizeString(req.body.role);
        if (!isValidRole(role)) {
            pushError(errors, 'role', `Role must be one of: ${ALL_ROLES.join(', ')}.`);
        } else {
            updates.role = role;
        }
    }

    if (req.body.is_active !== undefined) {
        const raw = req.body.is_active;
        if (raw === true || raw === 'true' || raw === 1 || raw === '1') {
            updates.isActive = true;
        } else if (raw === false || raw === 'false' || raw === 0 || raw === '0') {
            updates.isActive = false;
        } else {
            pushError(errors, 'is_active', 'is_active must be true or false.');
        }
    }

    if (errors.length) {
        return res.status(400).json(errorResponse('Validation failed.', errors));
    }

    if (!Object.keys(updates).length) {
        return res
            .status(400)
            .json(errorResponse('No updatable fields were supplied.'));
    }

    // ---- Safety rails around self-modification -----------------------------

    const isSelf = id === Number(req.user.id);

    // An administrator must not strip their own administrator role: that would
    // immediately lock them out of user management.
    if (isSelf && updates.role && updates.role !== ROLES.ADMIN) {
        return res
            .status(400)
            .json(
                errorResponse(
                    'You cannot change your own role. Ask another System Administrator to do it.'
                )
            );
    }

    // Likewise they must not deactivate themselves.
    if (isSelf && updates.isActive === false) {
        return res
            .status(400)
            .json(errorResponse('You cannot deactivate your own account.'));
    }

    // Never allow the last active administrator to be demoted or disabled.
    const losingAdminRights =
        (updates.role !== undefined && updates.role !== ROLES.ADMIN) ||
        updates.isActive === false;

    if (target.role === ROLES.ADMIN && losingAdminRights) {
        const remainingAdmins = await userModel.countActiveAdmins(id);
        if (remainingAdmins === 0) {
            return res
                .status(409)
                .json(
                    errorResponse(
                        'This is the only active System Administrator account. ' +
                            'Create or activate another administrator before changing this one.'
                    )
                );
        }
    }

    // ---- Uniqueness checks -------------------------------------------------

    if (updates.username && updates.username !== target.username) {
        const clash = await userModel.findByUsername(updates.username);
        if (clash && Number(clash.id) !== id) {
            return res.status(409).json(errorResponse('That username is already taken.'));
        }
    }

    if (updates.email && updates.email !== target.email) {
        const clash = await userModel.findByEmail(updates.email);
        if (clash && Number(clash.id) !== id) {
            return res
                .status(409)
                .json(errorResponse('That email address is already registered.'));
        }
    }

    const before = sanitizeUser(target);
    const updated = await userModel.update(id, updates);

    await auditLog({
        userId: req.user.id,
        action: 'UPDATE',
        tableName: 'users',
        recordId: id,
        oldValues: before,
        newValues: sanitizeUser(updated),
        ipAddress: getClientIp(req)
    });

    return res
        .status(200)
        .json(successResponse('User account updated successfully.', {
            user: sanitizeUser(updated)
        }));
}


/* ========================================================================== */
/* DELETE /api/auth/users/:id       (System Administrator only)               */
/* ========================================================================== */

/**
 * Soft-deletes a user by setting `is_active = 0`.
 *
 * The row is retained so `audit_logs.user_id` and `assets.assigned_user_id`
 * foreign keys keep pointing at a real record and the audit history stays
 * meaningful. Use PATCH /users/:id/activate to reverse this.
 */
async function deleteUser(req, res) {
    const id = parseInt(req.params.id, 10);

    if (!Number.isInteger(id) || id < 1) {
        return res
            .status(400)
            .json(errorResponse('A valid numeric user id is required.'));
    }

    if (id === Number(req.user.id)) {
        return res
            .status(400)
            .json(errorResponse('You cannot delete your own account.'));
    }

    const target = await userModel.findById(id);
    if (!target) {
        return res.status(404).json(errorResponse('User account not found.'));
    }

    if (!target.is_active) {
        return res
            .status(409)
            .json(errorResponse('This account is already deactivated.'));
    }

    // Never allow the last active administrator to be removed.
    if (target.role === ROLES.ADMIN) {
        const remainingAdmins = await userModel.countActiveAdmins(id);
        if (remainingAdmins === 0) {
            return res
                .status(409)
                .json(
                    errorResponse(
                        'This is the only active System Administrator account and cannot be deleted.'
                    )
                );
        }
    }

    await userModel.deactivate(id);

    await auditLog({
        userId: req.user.id,
        action: 'DELETE',
        tableName: 'users',
        recordId: id,
        oldValues: sanitizeUser(target),
        newValues: { is_active: 0, delete_type: 'soft' },
        ipAddress: getClientIp(req)
    });

    return res.status(200).json(
        successResponse(
            `${target.full_name}'s account has been deactivated. The record is retained for audit purposes.`
        )
    );
}

/* ========================================================================== */
/* PATCH /api/auth/users/:id/activate   (System Administrator only)           */
/* ========================================================================== */

/**
 * Re-activates a previously soft-deleted user account.
 */
async function activateUser(req, res) {
    const id = parseInt(req.params.id, 10);

    if (!Number.isInteger(id) || id < 1) {
        return res
            .status(400)
            .json(errorResponse('A valid numeric user id is required.'));
    }

    const target = await userModel.findById(id);
    if (!target) {
        return res.status(404).json(errorResponse('User account not found.'));
    }

    if (target.is_active) {
        return res
            .status(409)
            .json(errorResponse('This account is already active.'));
    }

    await userModel.activate(id);
    const updated = await userModel.findById(id);

    await auditLog({
        userId: req.user.id,
        action: 'ACTIVATE',
        tableName: 'users',
        recordId: id,
        oldValues: { is_active: 0 },
        newValues: sanitizeUser(updated),
        ipAddress: getClientIp(req)
    });

    return res
        .status(200)
        .json(successResponse(`${target.full_name}'s account has been reactivated.`, {
            user: sanitizeUser(updated)
        }));
}

/* ========================================================================== */
/* POST /api/auth/users/:id/reset-password  (System Administrator only)       */
/* ========================================================================== */

/**
 * Lets an administrator set a new password for another user (e.g. after the
 * user forgot it). The old password is not required, but the action is always
 * audit-logged so the reset is attributable.
 *
 * Body: { new_password, confirm_password }
 */
async function resetUserPassword(req, res) {
    const id = parseInt(req.params.id, 10);

    if (!Number.isInteger(id) || id < 1) {
        return res
            .status(400)
            .json(errorResponse('A valid numeric user id is required.'));
    }

    const newPassword = req.body.new_password ? String(req.body.new_password) : '';
    const confirmPassword = req.body.confirm_password
        ? String(req.body.confirm_password)
        : '';

    if (!confirmPassword) {
        return res.status(400).json(
            errorResponse('Validation failed.', [
                {
                    field: 'confirm_password',
                    message: 'Password confirmation is required.'
                }
            ])
        );
    }
    if (newPassword !== confirmPassword) {
        return res.status(400).json(
            errorResponse('Validation failed.', [
                {
                    field: 'confirm_password',
                    message: 'The password confirmation does not match.'
                }
            ])
        );
    }

    const strengthProblems = validatePasswordStrength(newPassword);
    if (strengthProblems.length) {
        return res.status(400).json(
            errorResponse(
                'Validation failed.',
                strengthProblems.map((message) => ({
                    field: 'new_password',
                    message
                }))
            )
        );
    }

    const target = await userModel.findById(id);
    if (!target) {
        return res.status(404).json(errorResponse('User account not found.'));
    }

    const newHash = await hash(newPassword, SALT_ROUNDS);
    await userModel.updatePassword(id, newHash, true);
    const updated = await userModel.findById(id);

    await auditLog({
        userId: req.user.id,
        action: 'RESET_PASSWORD',
        tableName: 'users',
        recordId: id,
        oldValues: { username: target.username },
        newValues: { username: target.username, reset_by: req.user.username },
        ipAddress: getClientIp(req)
    });

    return res.status(200).json(
        successResponse(`The password for ${target.full_name} has been reset successfully.`, {
            user: sanitizeUser(updated)
        })
    );
}


/* ========================================================================== */
/* GET /api/auth/audit-logs   (System Administrator / Auditor)                */
/* ========================================================================== */

/**
 * Returns the audit trail, newest first, with optional filters.
 *
 * Query: ?user_id=&action=&table_name=&record_id=&date_from=&date_to=
 *        &limit=&offset=
 */
async function getAuditLogs(req, res) {
    const errors = [];

    const userId = req.query.user_id ? parseInt(req.query.user_id, 10) : undefined;
    if (req.query.user_id && !Number.isInteger(userId)) {
        pushError(errors, 'user_id', 'user_id must be a numeric user id.');
    }

    const recordId = req.query.record_id ? parseInt(req.query.record_id, 10) : undefined;
    if (req.query.record_id && !Number.isInteger(recordId)) {
        pushError(errors, 'record_id', 'record_id must be a numeric record id.');
    }

    const action = normalizeString(req.query.action).toUpperCase() || undefined;
    const tableName = normalizeString(req.query.table_name) || undefined;
    const dateFrom = normalizeString(req.query.date_from) || undefined;
    const dateTo = normalizeString(req.query.date_to) || undefined;

    const datePattern = /^\d{4}-\d{2}-\d{2}$/;
    if (dateFrom && !datePattern.test(dateFrom)) {
        pushError(errors, 'date_from', 'date_from must use the YYYY-MM-DD format.');
    }
    if (dateTo && !datePattern.test(dateTo)) {
        pushError(errors, 'date_to', 'date_to must use the YYYY-MM-DD format.');
    }

    if (errors.length) {
        return res.status(400).json(errorResponse('Validation failed.', errors));
    }

    const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 100, 1), 500);
    const offset = Math.max(parseInt(req.query.offset, 10) || 0, 0);

    const { logs, total } = await auditModel.findAll({
        userId,
        action,
        tableName,
        recordId,
        dateFrom,
        dateTo,
        limit,
        offset
    });

    // old_values / new_values arrive as JSON columns which mysql2 already
    // parses into objects. Guard against TEXT-typed fallbacks just in case.
    const parsedLogs = logs.map((log) => ({
        ...log,
        old_values: parseJsonColumn(log.old_values),
        new_values: parseJsonColumn(log.new_values)
    }));

    return res.status(200).json(
        successResponse('Audit logs retrieved successfully.', {
            logs: parsedLogs,
            pagination: {
                total,
                limit,
                offset,
                returned: parsedLogs.length
            }
        })
    );
}

/**
 * Safely converts a JSON column value into an object.
 * mysql2 returns JSON columns pre-parsed; this handles the string case too.
 *
 * @param {*} value
 * @returns {object|Array|null}
 */
function parseJsonColumn(value) {
    if (value === null || value === undefined) return null;
    if (typeof value === 'object') return value;
    try {
        return JSON.parse(value);
    } catch (err) {
        return { raw: String(value) };
    }
}

/* ========================================================================== */

module.exports = {
    login,
    logout,
    getMe,
    updateMe,
    changePassword,
    register,
    getAllUsers,
    getUserById,
    updateUser,
    deleteUser,
    activateUser,
    resetUserPassword,
    getAuditLogs,
    // Exported for unit testing / reuse by the seed script.
    SALT_ROUNDS,
    MIN_PASSWORD_LENGTH,
    validatePasswordStrength
};

/**
 * public/js/api.js
 * Thin fetch wrapper for the NBSZ Asset Management System API.
 *
 * Responsibilities:
 *   - Keep the base URL in one place.
 *   - Use the same-origin HttpOnly session cookie for authentication.
 *   - Normalise API responses and handle expired sessions centrally.
 *
 * Loaded as a plain script; exposes a global `Api` object plus a few helpers.
 */

(function (global) {
    'use strict';

    // Same-origin by default. Override with `Api.setBaseUrl(...)` if the API
    // is hosted elsewhere (e.g. during local frontend-only development).
    const DEFAULT_BASE_URL = '/api';

    const TOKEN_KEY = 'nbsz_token';
    const SESSION_KEY = 'nbsz_authenticated';

    let baseUrl = DEFAULT_BASE_URL;

    global.addEventListener('error', function (event) {
        console.error('Unhandled client error', {
            message: event.message,
            source: event.filename,
            line: event.lineno
        });
    });

    global.addEventListener('unhandledrejection', function (event) {
        const reason = event.reason;
        console.error('Unhandled promise rejection', {
            message: reason instanceof Error ? reason.message : String(reason)
        });
    });

    /* ---------------------------------------------------------------------- */
    /* Token / user storage                                                   */
    /* ---------------------------------------------------------------------- */

    function getToken() {
        try {
            localStorage.removeItem(TOKEN_KEY);
            return null;
        } catch (err) {
            return null;
        }
    }

    function setToken() {
        try {
            localStorage.removeItem(TOKEN_KEY);
        } catch (err) {
            /* storage unavailable - session-only auth */
        }
    }

    function getStoredUser() {
        return null;
    }

    function setStoredUser() {
        try {
            localStorage.removeItem('nbsz_user');
        } catch (err) {
            /* The live profile is fetched from the server after login. */
        }
    }

    function clearSession() {
        setToken(null);
        setStoredUser(null);
        setAuthenticated(false);
    }

    function isLoggedIn() {
        try {
            return localStorage.getItem(SESSION_KEY) === '1';
        } catch (err) {
            return false;
        }
    }

    function setAuthenticated(authenticated) {
        try {
            if (authenticated) localStorage.setItem(SESSION_KEY, '1');
            else localStorage.removeItem(SESSION_KEY);
        } catch (err) {
            /* The HttpOnly cookie remains the source of authentication. */
        }
    }

    /* ---------------------------------------------------------------------- */
    /* Error type                                                             */
    /* ---------------------------------------------------------------------- */

    /**
     * Error thrown by every failed API call.
     * `status` is the HTTP status code and `errors` holds field-level details.
     */
    function ApiError(message, status, errors) {
        const error = new Error(message);
        error.name = 'ApiError';
        error.status = status || 0;
        error.errors = errors || [];
        return error;
    }

    /* ---------------------------------------------------------------------- */
    /* Core request                                                           */
    /* ---------------------------------------------------------------------- */

    /**
     * Performs a JSON request against the API.
     *
     * @param {string} path                 e.g. '/auth/login'
     * @param {object} [options]
     * @param {string} [options.method='GET']
     * @param {object} [options.body]
     * @param {boolean} [options.auth=true] Handle authentication failures.
     * @returns {Promise<object>} The `data` payload of the response envelope.
     */
    async function request(path, options = {}) {
        const { method = 'GET', body, auth = true, rawBody, contentType, headers: extraHeaders = {} } = options;

        const headers = Object.assign({ Accept: 'application/json' }, extraHeaders);
        if (rawBody !== undefined) {
            headers['Content-Type'] = contentType || 'text/plain';
        } else if (body !== undefined && body !== null) {
            headers['Content-Type'] = 'application/json';
        }

        if (auth) {
            const token = getToken();
            if (token) headers.Authorization = `Bearer ${token}`;
        }

        let response;
        try {
            response = await fetch(`${baseUrl}${path}`, {
                method,
                headers,
                body: rawBody !== undefined
                    ? rawBody
                    : body === undefined || body === null
                        ? undefined
                        : JSON.stringify(body)
            });
        } catch (networkError) {
            throw ApiError('Unable to reach the server. Please check your connection.', 0);
        }

        // 204 No Content
        if (response.status === 204) return null;

        let payload = null;
        const text = await response.text();
        if (text) {
            try {
                payload = JSON.parse(text);
            } catch (err) {
                payload = null;
            }
        }

        if (!response.ok) {
            if (auth && response.status === 401) {
                clearSession();
                if (typeof global.onSessionExpired === 'function') {
                    global.onSessionExpired();
                }
            }

            throw ApiError(
                (payload && payload.message) || `Request failed (${response.status}).`,
                response.status,
                (payload && payload.errors) || []
            );
        }

        return payload ? payload.data : null;
    }

    async function requestBlob(path) {
        const headers = {};
        const token = getToken();
        if (token) headers.Authorization = `Bearer ${token}`;

        let response;
        try {
            response = await fetch(`${baseUrl}${path}`, { headers });
        } catch (networkError) {
            throw ApiError('Unable to reach the server. Please check your connection.', 0);
        }
        if (!response.ok) {
            let payload = null;
            try {
                payload = await response.json();
            } catch (error) {
                payload = null;
            }
            if (response.status === 401) {
                clearSession();
                if (typeof global.onSessionExpired === 'function') global.onSessionExpired();
            }
            throw ApiError(
                (payload && payload.message) || `Request failed (${response.status}).`,
                response.status,
                (payload && payload.errors) || []
            );
        }
        return response.blob();
    }

    const http = {
        get: (path, options) => request(path, { ...options, method: 'GET' }),
        post: (path, body, options) => request(path, { ...options, method: 'POST', body }),
        put: (path, body, options) => request(path, { ...options, method: 'PUT', body }),
        patch: (path, body, options) => request(path, { ...options, method: 'PATCH', body }),
        delete: (path, options) => request(path, { ...options, method: 'DELETE' })
    };

    /**
     * Serialises a filters object into a `?a=1&b=2` query string, skipping
     * empty values so callers can pass form state straight through.
     */
    function buildQuery(filters) {
        const query = new URLSearchParams();
        Object.entries(filters || {}).forEach(([key, value]) => {
            if (value !== undefined && value !== null && value !== '') {
                query.append(key, value);
            }
        });
        const qs = query.toString();
        return qs ? `?${qs}` : '';
    }

    /* ---------------------------------------------------------------------- */
    /* Public API surface                                                     */
    /* ---------------------------------------------------------------------- */

    const Api = {
        /* --- session helpers --- */
        getToken,
        setToken,
        getStoredUser,
        setStoredUser,
        clearSession,
        isLoggedIn,
        setBaseUrl(url) {
            baseUrl = String(url || DEFAULT_BASE_URL).replace(/\/$/, '');
        },
        ApiError,

        /* --- raw request access --- */
        request,
        ...http,

        /* --- authentication --- */

        /**
         * Logs in and relies on the server's HttpOnly session cookie.
         * @param {string} username Username or email address.
         * @param {string} password
         * @returns {Promise<{token?: string, user: object}>}
         */
        async login(username, password) {
            const data = await request('/auth/login', {
                method: 'POST',
                body: { username, password },
                auth: false
            });

            setToken();
            setStoredUser(data.user);
            setAuthenticated(true);
            return data;
        },

        /**
         * Records the logout server-side and clears the local session.
         * @returns {Promise<void>}
         */
        async logout() {
            try {
                await request('/auth/logout', { method: 'POST' });
            } catch (err) {
                /* even if the audit write fails, the client session must end */
            } finally {
                clearSession();
            }
        },

        /** Returns the current user's profile from the server. */
        getMe() {
            return request('/auth/me').then((data) => {
                if (data && data.user) setStoredUser(data.user);
                return data.user;
            });
        },

        /** Updates the signed-in user's own profile. */
        updateMe(updates) {
            return request('/auth/me', { method: 'PATCH', body: updates }).then((data) => {
                if (data && data.user) setStoredUser(data.user);
                return data.user;
            });
        },

        /**
         * Changes the signed-in user's password. The server requires the user
         * to log in again, so the local session is cleared on success.
         */
        async changePassword(currentPassword, newPassword, confirmPassword) {
            const data = await request('/auth/change-password', {
                method: 'POST',
                body: {
                    current_password: currentPassword,
                    new_password: newPassword,
                    confirm_password: confirmPassword
                }
            });
            clearSession();
            return data;
        },

        /* --- user management (System Administrator / HISO) --- */

        /** Creates a new user account. */
        register(user) {
            return request('/auth/register', { method: 'POST', body: user });
        },

        /** Lists users. Supports search, role, is_active, limit, offset. */
        getUsers(filters = {}) {
            return request(`/auth/users${buildQuery(filters)}`);
        },

        /** Fetches one user by id. */
        getUser(id) {
            return request(`/auth/users/${id}`);
        },

        /** Updates a user's profile / role / status. */
        updateUser(id, updates) {
            return request(`/auth/users/${id}`, { method: 'PUT', body: updates });
        },

        /** Soft-deletes (deactivates) a user. */
        deleteUser(id) {
            return request(`/auth/users/${id}`, { method: 'DELETE' });
        },

        /** Re-activates a soft-deleted user. */
        activateUser(id) {
            return request(`/auth/users/${id}/activate`, { method: 'PATCH' });
        },

        /** Administratively resets another user's password. */
        resetUserPassword(id, newPassword, confirmPassword) {
            return request(`/auth/users/${id}/reset-password`, {
                method: 'POST',
                body: { new_password: newPassword, confirm_password: confirmPassword }
            });
        },

        /* --- audit trail --- */

        /**
         * Fetches the audit trail. Supports user_id, action, table_name,
         * record_id, date_from, date_to, limit and offset.
         */
        getAuditLogs(filters = {}) {
            return request(`/auth/audit-logs${buildQuery(filters)}`);
        },

        referenceData: {
            list() {
                return request('/reference-data');
            },
            create(type, name) {
                return request(`/reference-data/${encodeURIComponent(type)}`, {
                    method: 'POST',
                    body: { name }
                });
            },
            setActive(type, id, isActive) {
                return request(`/reference-data/${encodeURIComponent(type)}/${encodeURIComponent(id)}/status`, {
                    method: 'PATCH',
                    body: { is_active: isActive }
                });
            }
        },

        /* --- asset register (§5.2) --- */

        assets: {
            /** Lists / searches assets. */
            list(filters = {}) {
                return request(`/assets${buildQuery(filters)}`);
            },
            get(id) {
                return request(`/assets/${encodeURIComponent(id)}`);
            },
            async create(payload) {
                const data = await request('/assets', { method: 'POST', body: payload });
                return data.asset;
            },
            async update(id, payload) {
                const data = await request(`/assets/${id}`, { method: 'PUT', body: payload });
                return data.asset;
            },
            getStats() {
                return request('/assets/stats');
            },
            getMeta() {
                return request('/assets/meta');
            },
            listCategories() {
                return request('/assets/categories');
            },
            getHistory(id) {
                return request(`/assets/${id}/history`);
            },
            importCsv(csv) {
                return request('/assets/import', {
                    method: 'POST',
                    rawBody: csv,
                    contentType: 'text/csv'
                });
            },
            listDocuments(id) {
                return request(`/assets/${encodeURIComponent(id)}/documents`);
            },
            uploadDocument(id, file) {
                const form = new FormData();
                form.append('document', file);
                return request(`/assets/${encodeURIComponent(id)}/documents`, {
                    method: 'POST',
                    rawBody: form
                });
            },
            downloadDocument(id, documentId) {
                return requestBlob(
                    `/assets/${encodeURIComponent(id)}/documents/${encodeURIComponent(documentId)}`
                );
            },
            deleteDocument(id, documentId) {
                return request(`/assets/${encodeURIComponent(id)}/documents/${encodeURIComponent(documentId)}`, {
                    method: 'DELETE'
                });
            }
        },

        /* --- assignment & custody (§5.3) --- */

        assignments: {
            list(filters = {}) {
                return request(`/assignments${buildQuery(filters)}`);
            },
            get(id) {
                return request(`/assignments/${id}`);
            },
            async create(payload) {
                const data = await request('/assignments', { method: 'POST', body: payload });
                return data.assignment;
            },
            getActive() {
                return request('/assignments/active');
            },
            getMeta() {
                return request('/assignments/meta');
            },
            getAssetAssignment(assetId) {
                return request(`/assignments/asset/${assetId}`);
            },
            getAssetHistory(assetId) {
                return request(`/assignments/asset/${assetId}/history`);
            },
            acknowledge(id, payload = {}) {
                return request(`/assignments/${id}/acknowledge`, { method: 'PATCH', body: payload });
            },
            returnAsset(id, payload = {}) {
                return request(`/assignments/${id}/return`, { method: 'PATCH', body: payload });
            }
        },

        /* --- transfers & movement (§5.4) --- */

        transfers: {
            list(filters = {}) {
                return request(`/transfers${buildQuery(filters)}`);
            },
            get(id) {
                return request(`/transfers/${encodeURIComponent(id)}`);
            },
            async create(payload) {
                const data = await request('/transfers', { method: 'POST', body: payload });
                return data.transfer;
            },
            getStats() {
                return request('/transfers/stats');
            },
            getRecent(limit = 10) {
                return request(`/transfers/recent${buildQuery({ limit })}`);
            },
            getMeta() {
                return request('/transfers/meta');
            },
            getAssetHistory(assetId) {
                return request(`/transfers/asset/${assetId}/history`);
            },
            acknowledge(id, payload = {}) {
                return request(`/transfers/${id}/acknowledge`, { method: 'PATCH', body: payload });
            },
            approve(id) {
                return request(`/transfers/${id}/approve`, { method: 'PATCH', body: {} });
            },
            cancel(id, payload = {}) {
                return request(`/transfers/${id}/cancel`, { method: 'PATCH', body: payload });
            },
            reverse(id, payload = {}) {
                return request(`/transfers/${id}/reverse`, { method: 'PATCH', body: payload });
            }
        },

        /* --- maintenance & repairs (§5.5) --- */

        maintenance: {
            list(filters = {}) {
                return request(`/maintenance${buildQuery(filters)}`);
            },
            get(id) {
                return request(`/maintenance/${encodeURIComponent(id)}`);
            },
            async create(payload) {
                const data = await request('/maintenance', { method: 'POST', body: payload });
                return data.maintenance;
            },
            async update(id, payload) {
                const data = await request(`/maintenance/${id}`, { method: 'PUT', body: payload });
                return data.maintenance;
            },
            getStats() {
                return request('/maintenance/stats');
            },
            getMeta() {
                return request('/maintenance/meta');
            },
            getRecent(limit = 10) {
                return request(`/maintenance/recent${buildQuery({ limit })}`);
            },
            getOpen(filters = {}) {
                return request(`/maintenance/open${buildQuery(filters)}`);
            },
            getOverdue() {
                return request('/maintenance/overdue');
            },
            getAssetHistory(assetId) {
                return request(`/maintenance/asset/${assetId}/history`);
            },
            start(id, payload = {}) {
                return request(`/maintenance/${id}/start`, { method: 'PATCH', body: payload });
            },
            complete(id, payload = {}) {
                return request(`/maintenance/${id}/complete`, { method: 'PATCH', body: payload });
            },
            setStatus(id, status, payload = {}) {
                return request(`/maintenance/${id}/status`, {
                    method: 'PATCH',
                    body: { ...payload, status }
                });
            },
            cancel(id, payload = {}) {
                return request(`/maintenance/${id}/cancel`, { method: 'PATCH', body: payload });
            }
        },

        /* --- warranty & contract monitoring (§5.6) --- */

        warranties: {
            list(filters = {}) {
                return request(`/warranties${buildQuery(filters)}`);
            },
            get(id) {
                return request(`/warranties/${encodeURIComponent(id)}`);
            },
            async create(payload) {
                const data = await request('/warranties', { method: 'POST', body: payload });
                return data.warranty;
            },
            async update(id, payload) {
                const data = await request(`/warranties/${id}`, { method: 'PUT', body: payload });
                return data.warranty;
            },
            getStats(days) {
                return request(`/warranties/stats${buildQuery({ days })}`);
            },
            getMeta() {
                return request('/warranties/meta');
            },
            getExpiring(filters = {}) {
                return request(`/warranties/expiring${buildQuery(filters)}`);
            },
            getExpired(filters = {}) {
                return request(`/warranties/expired${buildQuery(filters)}`);
            },
            getRecent(limit = 10) {
                return request(`/warranties/recent${buildQuery({ limit })}`);
            },
            getContracts(filters = {}) {
                return request(`/warranties/contracts${buildQuery(filters)}`);
            },
            getAssetCoverage(assetId) {
                return request(`/warranties/asset/${encodeURIComponent(assetId)}`);
            },
            setStatus(id, status, payload = {}) {
                return request(`/warranties/${id}/status`, {
                    method: 'PATCH',
                    body: { ...payload, status }
                });
            },
            renew(id, payload = {}) {
                return request(`/warranties/${id}/renew`, { method: 'PATCH', body: payload });
            },
            cancel(id, payload = {}) {
                return request(`/warranties/${id}/cancel`, { method: 'PATCH', body: payload });
            }
        },

        /* --- ICT stock / store (§5.7) --- */

        stock: {
            list(filters = {}) {
                return request(`/stock${buildQuery(filters)}`);
            },
            get(id) {
                return request(`/stock/${encodeURIComponent(id)}`);
            },
            async create(payload) {
                const data = await request('/stock', { method: 'POST', body: payload });
                return data.stock_item;
            },
            async update(id, payload) {
                const data = await request(`/stock/${id}`, { method: 'PUT', body: payload });
                return data.stock_item;
            },
            getStats() {
                return request('/stock/stats');
            },
            getMeta() {
                return request('/stock/meta');
            },
            getBalances() {
                return request('/stock/balances');
            },
            getLowStock(limit = 100) {
                return request(`/stock/low-stock${buildQuery({ limit })}`);
            },
            getMovements(filters = {}) {
                return request(`/stock/movements${buildQuery(filters)}`);
            },
            getRecentMovements(limit = 10) {
                return request(`/stock/movements/recent${buildQuery({ limit })}`);
            },
            getMovement(id) {
                return request(`/stock/movements/${encodeURIComponent(id)}`);
            },
            getAssetStock(assetId) {
                return request(`/stock/asset/${encodeURIComponent(assetId)}`);
            },
            receipt(id, payload = {}) {
                return request(`/stock/${id}/receipt`, { method: 'POST', body: payload });
            },
            issue(id, payload = {}) {
                return request(`/stock/${id}/issue`, { method: 'POST', body: payload });
            },
            returnStock(id, payload = {}) {
                return request(`/stock/${id}/return`, { method: 'POST', body: payload });
            },
            adjust(id, payload = {}) {
                return request(`/stock/${id}/adjust`, { method: 'POST', body: payload });
            },
            reverseMovement(id, payload = {}) {
                return request(`/stock/movements/${id}/reverse`, { method: 'POST', body: payload });
            }
        },

        verification: {
            list(filters = {}) {
                return request(`/verifications${buildQuery(filters)}`);
            },
            getMeta() {
                return request('/verifications/meta');
            },
            get(id) {
                return request(`/verifications/${encodeURIComponent(id)}`);
            },
            getExceptions(id) {
                return request(`/verifications/${encodeURIComponent(id)}/exceptions`);
            },
            create(payload = {}) {
                return request('/verifications', { method: 'POST', body: payload });
            },
            updateItem(id, itemId, payload = {}) {
                return request(`/verifications/${encodeURIComponent(id)}/items/${encodeURIComponent(itemId)}`, {
                    method: 'PATCH',
                    body: payload
                });
            },
            complete(id) {
                return request(`/verifications/${encodeURIComponent(id)}/complete`, { method: 'PATCH', body: {} });
            }
        },

        disposal: {
            getStats() {
                return request('/disposals/stats');
            },
            list(filters = {}) {
                return request(`/disposals${buildQuery(filters)}`);
            },
            getMeta() {
                return request('/disposals/meta');
            },
            get(id) {
                return request(`/disposals/${encodeURIComponent(id)}`);
            },
            create(payload = {}) {
                return request('/disposals', { method: 'POST', body: payload });
            },
            approve(id) {
                return request(`/disposals/${encodeURIComponent(id)}/approve`, { method: 'POST', body: {} });
            },
            reject(id, payload = {}) {
                return request(`/disposals/${encodeURIComponent(id)}/reject`, { method: 'POST', body: payload });
            },
            complete(id) {
                return request(`/disposals/${encodeURIComponent(id)}/complete`, { method: 'POST', body: {} });
            }
        },

        procurement: {
            list(filters = {}) {
                return request(`/procurement${buildQuery(filters)}`);
            },
            get(id) {
                return request(`/procurement/${encodeURIComponent(id)}`);
            },
            receive(payload, idempotencyKey) {
                return request('/procurement/receive', {
                    method: 'POST',
                    body: payload,
                    headers: idempotencyKey ? { 'Idempotency-Key': idempotencyKey } : {}
                });
            }
        },

        licences: {
            list(filters = {}) {
                return request(`/licences${buildQuery(filters)}`);
            },
            getMeta() {
                return request('/licences/meta');
            },
            getStats() {
                return request('/licences/stats');
            },
            getExpiring(days = 90) {
                return request(`/licences/expiring${buildQuery({ days })}`);
            },
            get(id) {
                return request(`/licences/${encodeURIComponent(id)}`);
            },
            create(payload = {}) {
                return request('/licences', { method: 'POST', body: payload });
            },
            update(id, payload = {}) {
                return request(`/licences/${encodeURIComponent(id)}`, { method: 'PUT', body: payload });
            },
            setStatus(id, status) {
                return request(`/licences/${encodeURIComponent(id)}/status`, { method: 'PATCH', body: { status } });
            },
            allocate(id, payload = {}) {
                return request(`/licences/${encodeURIComponent(id)}/allocations`, { method: 'POST', body: payload });
            },
            release(id, allocationId) {
                return request(`/licences/${encodeURIComponent(id)}/allocations/${encodeURIComponent(allocationId)}/release`, {
                    method: 'POST',
                    body: {}
                });
            }
        },

        reports: {
            getTypes() {
                return request('/reports/types');
            },
            getSummary() {
                return request('/reports/summary');
            },
            run(type, filters = {}) {
                return request(`/reports/${encodeURIComponent(type)}${buildQuery(filters)}`);
            },
            export(type, format, filters = {}) {
                return requestBlob(
                    `/reports/${encodeURIComponent(type)}/export${buildQuery({ ...filters, format })}`
                );
            }
        },

        /* --- QR code / barcode management (§5.8) --- */

        barcode: {
            list(filters = {}) {
                return request(`/barcode${buildQuery(filters)}`);
            },
            get(id) {
                return request(`/barcode/${encodeURIComponent(id)}`);
            },
            getStats() {
                return request('/barcode/stats');
            },
            getMeta() {
                return request('/barcode/meta');
            },
            getCoverage(filters = {}) {
                return request(`/barcode/coverage${buildQuery(filters)}`);
            },
            getAssetLabel(assetId) {
                return request(`/barcode/asset/${encodeURIComponent(assetId)}`);
            },
            generateAssetCode(assetId, payload = {}) {
                return request(`/barcode/asset/${encodeURIComponent(assetId)}/generate`, {
                    method: 'POST',
                    body: payload
                });
            },
            generateBulk(payload = {}) {
                return request('/barcode/generate', {
                    method: 'POST',
                    body: payload
                });
            },
            printLabel(assetId) {
                return request(`/barcode/asset/${encodeURIComponent(assetId)}/print`, {
                    method: 'POST'
                });
            },
            replaceLabel(id, payload = {}) {
                return request(`/barcode/label/${encodeURIComponent(id)}/replace`, {
                    method: 'POST',
                    body: payload
                });
            },
            lookup(code) {
                return request(`/barcode/lookup/${encodeURIComponent(code)}`);
            },
            scan(payload = {}) {
                return request('/barcode/scan', {
                    method: 'POST',
                    body: payload
                });
            },
            getScans(filters = {}) {
                return request(`/barcode/scans${buildQuery(filters)}`);
            },
            getScan(id) {
                return request(`/barcode/scans/${encodeURIComponent(id)}`);
            },
            update(id, payload = {}) {
                return request(`/barcode/${encodeURIComponent(id)}`, {
                    method: 'PUT',
                    body: payload
                });
            }
        },

        /* --- misc --- */

        /** Health check - does not require authentication. */
        health() {
            return request('/health', { auth: false });
        }
    };

    /* ---------------------------------------------------------------------- */
    /* Exports                                                                */
    /* ---------------------------------------------------------------------- */

    global.Api = Api;

    // Convenience aliases matching the helper names used across the frontend.
    global.apiFetch = request;
    global.apiGet = http.get;
    global.apiPost = http.post;
    global.apiPut = http.put;
    global.apiPatch = http.patch;
    global.apiDelete = http.delete;

})(window);

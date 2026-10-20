(function () {
    'use strict';

    /* ======================================================================
     * Module state
     * ==================================================================== */

    var state = {
        view: 'dashboard',
        user: null,
        users: { rows: [], total: 0, offset: 0, limit: 25, filters: {} },
        // Per-view caches so switching tabs does not refetch everything.
        assets: { rows: [], total: 0, offset: 0, limit: 25, filters: {} },
        assignments: { rows: [], total: 0, offset: 0, limit: 25, filters: {} },
        transfers: { rows: [], total: 0, offset: 0, limit: 25, filters: {} },
        maintenance: { rows: [], total: 0, offset: 0, limit: 25, filters: {} },
        warranty: { rows: [], total: 0, offset: 0, limit: 25, filters: {} },
        stock: { rows: [], total: 0, offset: 0, limit: 25, filters: {} },
        stockLedger: { rows: [], total: 0, offset: 0, limit: 25, filters: {} },
        barcode: { page: 1, limit: 25, filters: {} },
        procurement: { page: 1, offset: 0, limit: 25, total: 0 },
        verification: { current: null },
        disposal: { rows: [] },
        licences: { filters: {}, rows: [] },
        reports: { types: [], summary: null, result: null, type: '', filters: {} }
    };

    function referenceOptions(type, currentValue) {
        var list = meta.referenceData && meta.referenceData[type] || [];
        var options = list.filter(function (item) { return Number(item.is_active) === 1; })
            .map(function (item) { return { value: item.name, label: item.name }; });
        if (currentValue && !options.some(function (item) { return item.value === currentValue; })) {
            options.push({ value: currentValue, label: currentValue + ' (legacy)' });
        }
        return options;
    }

    // Reference data fetched once and reused by every form.
    var meta = {
        assetCategories: [],
        referenceData: null,
        referenceDataError: null,
        maintenance: null,
        assignment: null,
        transfer: null,
        warranty: null,
        stock: null,
        verification: null,
        licences: null
    };
    var barcodeCamera = { stream: null, timer: null, detector: null, busy: false };

    var VIEW_TITLES = {
        dashboard: 'Dashboard',
        assets: 'Asset Register',
        assignments: 'Assignments & Custody',
        transfers: 'Asset Transfers',
        maintenance: 'Maintenance & Repairs',
        warranty: 'Warranty & Contract Monitoring',
        stock: 'ICT Stock & Store',
        barcode: 'QR Codes & Barcodes',
        verification: 'Physical Verification',
        disposal: 'Asset Disposal',
        licence: 'Software Licence Register',
        reports: 'Management Reports',
        users: 'User Accounts',
        referenceData: 'Departments & Locations',
        procurement: 'Procurement Receiving'
    };

    /* ======================================================================
     * DOM handles
     * ==================================================================== */

    var el = {
        sidebar: document.getElementById('sidebar'),
        sidebarToggle: document.getElementById('sidebarToggle'),
        userMenuContainer: document.getElementById('userMenuContainer'),
        userMenuPill: document.getElementById('userMenuPill'),
        userDropdownCard: document.getElementById('userDropdownCard'),
        userAvatar: document.getElementById('userAvatar'),
        udAvatarLg: document.getElementById('udAvatarLg'),
        udFullName: document.getElementById('udFullName'),
        udEmail: document.getElementById('udEmail'),
        udRoleBadge: document.getElementById('udRoleBadge'),
        udUsername: document.getElementById('udUsername'),
        quickChangePasswordForm: document.getElementById('quickChangePasswordForm'),
        topbarSettingsBtn: document.getElementById('topbarSettingsBtn'),
        settingsModal: document.getElementById('settingsModal'),
        settingsModalClose: document.getElementById('settingsModalClose'),
        settingsModalCancel: document.getElementById('settingsModalCancel'),
        settingsModalSave: document.getElementById('settingsModalSave'),
        settingDensity: document.getElementById('settingDensity'),
        settingPageSize: document.getElementById('settingPageSize'),
        settingContrast: document.getElementById('settingContrast'),
        nav: document.getElementById('nav'),
        view: document.getElementById('view'),
        viewTitle: document.getElementById('viewTitle'),
        alertBox: document.getElementById('alertBox'),
        userName: document.getElementById('userName'),
        userRole: document.getElementById('userRole'),
        logoutBtn: document.getElementById('logoutBtn'),
        openMaintenanceBadge: document.getElementById('openMaintenanceBadge'),
        expiringWarrantyBadge: document.getElementById('expiringWarrantyBadge'),
        lowStockBadge: document.getElementById('lowStockBadge'),
        usersNav: document.getElementById('usersNav'),
        referenceDataNav: document.getElementById('referenceDataNav'),
        procurementNav: document.getElementById('procurementNav'),
        adminNavSection: document.getElementById('adminNavSection'),
        modal: document.getElementById('modal'),
        modalPanel: document.getElementById('modalPanel'),
        modalTitle: document.getElementById('modalTitle'),
        modalBody: document.getElementById('modalBody'),
        modalForm: document.getElementById('modalForm'),
        modalSubmit: document.getElementById('modalSubmit'),
        modalClose: document.getElementById('modalClose'),
        modalCancel: document.getElementById('modalCancel')
    };


    /* ======================================================================
     * Small utilities
     * ==================================================================== */

    /** Escapes text for safe insertion into innerHTML. */
    function esc(value) {
        if (value === null || value === undefined) return '';
        return String(value)
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;')
            .replace(/'/g, '&#39;');
    }

    /** Returns escaped text, or a muted dash when it is empty. */
    function orDash(value) {
        if (value === null || value === undefined || value === '') {
            return '<span class="muted">&mdash;</span>';
        }
        return esc(value);
    }

    /** Today as YYYY-MM-DD (matches the server's default). */
    function today() {
        var d = new Date();
        var pad = function (n) { return String(n).padStart(2, '0'); };
        return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate());
    }

    /**
     * Normalises a MySQL DATE (serialised by the API as an ISO string) to
     * YYYY-MM-DD. The server anchors DATE values at local midnight, so reading
     * the local calendar parts is what keeps this timezone-independent.
     */
    function day(value) {
        if (!value) return '';
        var d = value instanceof Date ? value : new Date(value);
        if (isNaN(d.getTime())) return String(value).slice(0, 10);
        var pad = function (n) { return String(n).padStart(2, '0'); };
        return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate());
    }

    /** Formats a number with two decimals. */
    function money(value) {
        return Number(value || 0).toLocaleString(undefined, {
            minimumFractionDigits: 2,
            maximumFractionDigits: 2
        });
    }

    /** Formats a timestamp for display. */
    function when(value) {
        if (!value) return '';
        var d = new Date(value);
        if (isNaN(d.getTime())) return esc(value);
        return d.toLocaleString();
    }

    /** Shows the page-level alert banner (auto-hides). */
    function showAlert(message, type) {
        el.alertBox.textContent = message;
        el.alertBox.className =
            'alert visible ' +
            (type === 'success' ? 'alert-success' : type === 'info' ? 'alert-info' : 'alert-error');
        window.clearTimeout(showAlert._t);
        showAlert._t = window.setTimeout(function () {
            el.alertBox.className = 'alert';
        }, 6000);
    }

    /** Hides the page-level alert banner immediately (e.g. when changing views). */
    function clearAlert() {
        window.clearTimeout(showAlert._t);
        el.alertBox.className = 'alert';
        el.alertBox.textContent = '';
    }

    function showLoading(label) {
        el.view.innerHTML =
            '<div class="card"><div class="loading"><span class="spinner-dark"></span>' +
            esc(label || 'Loading...') +
            '</div></div>';
    }

    /**
     * Maps a status string onto a badge class so the same status always looks
     * the same everywhere.
     */
    function statusClass(status) {
        var map = {
            'In Use': 'ok',
            'In Stock': 'info',
            'Under Repair': 'warn',
            Missing: 'danger',
            Retired: 'neutral',
            Disposed: 'neutral',
            Active: 'ok',
            Returned: 'neutral',
            Transferred: 'info',
            Cancelled: 'neutral',
            Completed: 'ok',
            Pending: 'warn',
            'In Progress': 'info',
            'On Hold': 'warn',
            Reversed: 'danger',
            Good: 'ok',
            Fair: 'info',
            Damaged: 'warn',
            Obsolete: 'neutral'
        };
        return map[status] || 'neutral';
    }

    /** Builds a status badge. */
    function badge(status) {
        if (!status) return '';
        return '<span class="badge-pill ' + statusClass(status) + '">' + esc(status) + '</span>';
    }

    /** Builds a priority badge with its own colour scale. */
    function priorityBadge(priority) {
        if (!priority) return '';
        return '<span class="badge-pill pri-' + esc(priority) + '">' + esc(priority) + '</span>';
    }


    /* ======================================================================
     * Shared table renderer
     * ==================================================================== */

    /**
     * Renders a data table.
     *
     * @param {object[]} rows
     * @param {Array} columns Each: { label, render(row), key, className }
     * @param {object} [options]
     * @param {string} [options.empty] Empty-state message.
     * @param {number} [options.total] Total rows for the pager caption.
     * @param {object} [options.pager] { offset, limit }
     * @returns {string} HTML
     */
    function table(rows, columns, options) {
        options = options || {};

        if (!rows || !rows.length) {
            return '<div class="empty">' + esc(options.empty || 'Nothing to show yet.') + '</div>';
        }

        var head = columns
            .map(function (c) {
                return '<th' + (c.className ? ' class="' + c.className + '"' : '') + '>' + esc(c.label) + '</th>';
            })
            .join('');

        var body = rows
            .map(function (row) {
                var cells = columns
                    .map(function (c) {
                        var html = c.render ? c.render(row) : orDash(row[c.key]);
                        if (c.className && c.className.indexOf('actions') !== -1 && html) {
                            html = '<div class="row-actions" role="group" aria-label="Row actions">' +
                                html + '</div>';
                        }
                        return '<td' + (c.className ? ' class="' + c.className + '"' : '') + '>' + html + '</td>';
                    })
                    .join('');
                return '<tr>' + cells + '</tr>';
            })
            .join('');

        var html =
            '<div class="table-wrap"><table class="data"><thead><tr>' +
            head +
            '</tr></thead><tbody>' +
            body +
            '</tbody></table></div>';

        if (options.pager && typeof options.total === 'number') {
            var p = options.pager;
            var from = options.total === 0 ? 0 : p.offset + 1;
            var to = Math.min(p.offset + p.limit, options.total);
            html +=
                '<div class="pager">' +
                '<span>Showing ' + from + '&ndash;' + to + ' of ' + options.total + '</span>' +
                '<div class="spacer"></div>' +
                '<button class="btn btn-sm btn-secondary" data-page="prev"' +
                (p.offset <= 0 ? ' disabled' : '') +
                '>Previous</button>' +
                '<button class="btn btn-sm btn-secondary" data-page="next"' +
                (to >= options.total ? ' disabled' : '') +
                '>Next</button>' +
                '</div>';
        }

        return html;
    }

    /** Wires the pager buttons rendered by `table()`. */
    function bindPager(container, pagerState, reload) {
        var prev = container.querySelector('[data-page="prev"]');
        var next = container.querySelector('[data-page="next"]');

        if (prev) {
            prev.addEventListener('click', function () {
                pagerState.offset = Math.max(0, pagerState.offset - pagerState.limit);
                reload();
            });
        }
        if (next) {
            next.addEventListener('click', function () {
                pagerState.offset += pagerState.limit;
                reload();
            });
        }
    }


    /* ======================================================================
     * Modal + form builder
     * ==================================================================== */

    /**
     * Renders one form field.
     *
     * Field descriptor:
     *   { name, label, type, required, options, value, hint, full,
     *     min, max, step, placeholder, rows, checkboxLabel }
     */
    function renderField(field) {
        var id = 'f_' + field.name;
        var required = field.required ? ' required' : '';
        var full = field.full ? ' full' : '';
        var hint = field.hint
            ? '<div class="dt" style="margin-top:4px;text-transform:none;letter-spacing:0;">' + esc(field.hint) + '</div>'
            : '';

        var control;

        if (field.type === 'select') {
            var opts = ['<option value="">-- select --</option>'];
            (field.options || []).forEach(function (opt) {
                var value = opt.value !== undefined ? opt.value : opt;
                var label = opt.label !== undefined ? opt.label : opt;
                var current = field.value === null || field.value === undefined ? '' : field.value;
                var selected = String(current) === String(value) ? ' selected' : '';
                opts.push('<option value="' + esc(value) + '"' + selected + '>' + esc(label) + '</option>');
            });
            control = '<select id="' + id + '" name="' + esc(field.name) + '"' + required + '>' + opts.join('') + '</select>';
        } else if (field.type === 'textarea') {
            control =
                '<textarea id="' + id + '" name="' + esc(field.name) + '"' + required +
                (field.rows ? ' rows="' + field.rows + '"' : '') +
                (field.placeholder ? ' placeholder="' + esc(field.placeholder) + '"' : '') +
                '>' + esc(field.value || '') + '</textarea>';
        } else if (field.type === 'checkbox') {
            control =
                '<label style="display:flex;align-items:center;gap:8px;font-size:13.5px;">' +
                '<input type="checkbox" id="' + id + '" name="' + esc(field.name) + '" value="1"' +
                (field.value ? ' checked' : '') +
                ' style="width:auto;">' + esc(field.checkboxLabel || field.label) +
                '</label>';
        } else {
            var extra = '';
            if (field.min !== undefined) extra += ' min="' + esc(field.min) + '"';
            if (field.max !== undefined) extra += ' max="' + esc(field.max) + '"';
            if (field.step !== undefined) extra += ' step="' + esc(field.step) + '"';
            if (field.passwordPolicy) {
                extra += ' minlength="8" autocomplete="new-password" data-password-policy="true"';
            }
            if (field.placeholder) extra += ' placeholder="' + esc(field.placeholder) + '"';
            var value = field.value === null || field.value === undefined ? '' : field.value;
            control =
                '<input type="' + esc(field.type || 'text') + '" id="' + id + '" name="' + esc(field.name) + '" ' +
                'value="' + esc(value) + '"' + required + extra + '>';
        }

        return (
            '<div class="' + (full.trim() || 'field-wrap') + '">' +
            (field.type === 'checkbox'
                ? ''
                : '<label class="field-label" for="' + id + '">' + esc(field.label) +
                  (field.required ? ' *' : '') + '</label>') +
            control +
            hint +
            (field.passwordPolicy ? passwordRequirementsMarkup(id + 'Requirements') : '') +
            '</div>'
        );
    }

    function passwordRequirementsMarkup(id) {
        return (
            '<ul class="password-requirements" id="' + id + '">' +
            '<li data-password-rule="length">At least 8 characters</li>' +
            '<li data-password-rule="uppercase">One uppercase letter</li>' +
            '<li data-password-rule="lowercase">One lowercase letter</li>' +
            '<li data-password-rule="number">One number</li>' +
            '<li data-password-rule="special">One special character (for example, !@#)</li>' +
            '</ul><div class="password-requirements-status" id="' + id +
            'Status" role="status" aria-live="polite"></div>'
        );
    }

    function checkPasswordRequirements(password) {
        return {
            length: password.length >= 8,
            uppercase: /[A-Z]/.test(password),
            lowercase: /[a-z]/.test(password),
            number: /[0-9]/.test(password),
            special: /[^A-Za-z0-9\s]/.test(password)
        };
    }

    function bindPasswordRequirements(input, checklist) {
        function update() {
            var checks = checkPasswordRequirements(input.value);
            var metCount = 0;
            Object.keys(checks).forEach(function (rule) {
                var item = checklist.querySelector('[data-password-rule="' + rule + '"]');
                if (!item) return;
                item.classList.toggle('met', checks[rule]);
                item.classList.toggle('unmet', !checks[rule]);
                if (checks[rule]) metCount += 1;
            });
            var status = document.getElementById(checklist.id + 'Status');
            if (status) status.textContent = metCount + ' of 5 password requirements met.';
        }

        input.addEventListener('input', update);
        update();
    }

    function passwordRequirementErrors(password) {
        var checks = checkPasswordRequirements(password);
        var messages = {
            length: 'Password must be at least 8 characters long.',
            uppercase: 'Password must contain at least one uppercase letter.',
            lowercase: 'Password must contain at least one lowercase letter.',
            number: 'Password must contain at least one number.',
            special: 'Password must contain at least one special character.'
        };
        return Object.keys(checks)
            .filter(function (rule) { return !checks[rule]; })
            .map(function (rule) { return messages[rule]; });
    }


    /**
     * Opens the modal with a form.
     *
     * @param {object} options
     * @param {string} options.title
     * @param {Array} options.fields
     * @param {string} [options.submitLabel]
     * @param {boolean} [options.wide]
     * @param {string} [options.successMessage]
     * @param {Function} options.onSubmit Receives { values }, returns a promise.
     */
    function openForm(options) {
        el.modalTitle.textContent = options.title || 'Form';
        el.modalPanel.className = 'modal' + (options.wide ? ' modal-wide' : '');
        el.modalSubmit.textContent = options.submitLabel || 'Save';
        el.modalSubmit.style.display = '';
        el.modalBody.innerHTML =
            '<div class="form-grid">' + options.fields.map(renderField).join('') + '</div>';
        el.modal.hidden = false;

        options.fields.forEach(function (field) {
            if (!field.passwordPolicy) return;
            var input = document.getElementById('f_' + field.name);
            var checklist = document.getElementById('f_' + field.name + 'Requirements');
            if (input && checklist) bindPasswordRequirements(input, checklist);
        });

        var firstInput = el.modalBody.querySelector('input, select, textarea');
        if (firstInput) firstInput.focus();

        el.modalForm.onsubmit = function (event) {
            event.preventDefault();

            var values = {};
            options.fields.forEach(function (field) {
                var input = document.getElementById('f_' + field.name);
                if (!input) return;

                if (field.type === 'checkbox') {
                    values[field.name] = input.checked;
                } else if (field.type === 'number') {
                    values[field.name] = input.value === '' ? null : Number(input.value);
                } else {
                    values[field.name] = input.value;
                }
            });

            var invalidPasswordField = options.fields.find(function (field) {
                return field.passwordPolicy &&
                    passwordRequirementErrors(values[field.name]).length > 0;
            });
            if (invalidPasswordField) {
                var invalidPassword = document.getElementById('f_' + invalidPasswordField.name);
                showAlert(passwordRequirementErrors(values[invalidPasswordField.name])[0], 'error');
                if (invalidPassword) invalidPassword.focus();
                return;
            }

            el.modalSubmit.disabled = true;
            var original = el.modalSubmit.textContent;
            el.modalSubmit.innerHTML = '<span class="spinner"></span>Saving...';

            Promise.resolve(options.onSubmit({ values: values }))
                .then(function (result) {
                    closeModal();
                    showAlert(options.successMessage || 'Saved successfully.', 'success');
                    return result;
                })
                .catch(function (error) {
                    var firstFieldError =
                        error.errors && error.errors.length ? error.errors[0].message : null;
                    showAlert(
                        firstFieldError || error.message || 'Could not save. Please try again.',
                        'error'
                    );
                })
                .finally(function () {
                    el.modalSubmit.disabled = false;
                    el.modalSubmit.textContent = original;
                });
        };
    }

    /**
     * Opens a read-only detail panel, reusing the modal chrome and hiding the
     * form submit button.
     */
    function openDetail(title, html, wide) {
        el.modalTitle.textContent = title;
        el.modalPanel.className = 'modal' + (wide ? ' modal-wide' : '');
        el.modalBody.innerHTML = html;
        el.modalSubmit.style.display = 'none';
        el.modal.hidden = false;
    }

    function closeModal() {
        el.modal.hidden = true;
        el.modalForm.onsubmit = null;
        el.modalBody.innerHTML = '';
    }

    el.modalClose.addEventListener('click', closeModal);
    el.modalCancel.addEventListener('click', closeModal);
    el.modal.addEventListener('click', function (event) {
        if (event.target === el.modal) closeModal();
    });
    document.addEventListener('keydown', function (event) {
        if (event.key === 'Escape' && !el.modal.hidden) closeModal();
    });

    /** Builds a key/value detail block for the read-only panels. */
    function details(pairs) {
        return (
            '<div class="detail-grid">' +
            pairs
                .map(function (pair) {
                    return (
                        '<div' + (pair.full ? ' class="span-all"' : '') + '>' +
                        '<div class="dt">' + esc(pair.label) + '</div>' +
                        '<div class="dd">' + (pair.html !== undefined ? pair.html : orDash(pair.value)) + '</div>' +
                        '</div>'
                    );
                })
                .join('') +
            '</div>'
        );
    }


    /* ======================================================================
     * Permissions
     * ==================================================================== */

    // Mirrors the server-side RBAC table so the UI only offers actions the
    // API will actually accept. The API remains the authority.
    var RIGHTS = {
        'System Administrator': { write: true, admin: true, readAll: true },
        HISO: { write: true, admin: true, readAll: true },
        'ICT Officer': { write: true, admin: false, readAll: true },
        Auditor: { write: false, admin: false, readAll: true },
        'Departmental User': { write: false, admin: false, readAll: false }
    };

    function rights() {
        return (state.user && RIGHTS[state.user.role]) || { write: false, admin: false, readAll: false };
    }

    var can = {
        write: function () { return rights().write; },
        admin: function () { return rights().admin; },
        readAll: function () { return rights().readAll; },
        systemAdmin: function () { return !!state.user && state.user.role === 'System Administrator'; }
    };

    /* ======================================================================
     * Session + reference data
     * ==================================================================== */

    /** Called by api.js when the session dies (401/403 on an authenticated call). */
    window.onSessionExpired = function () {
        window.location.replace('/login.html');
    };

    function paintUser() {
        if (!state.user) return;
        var name = state.user.full_name || state.user.username || 'User';
        var role = state.user.role || 'Staff';
        var email = state.user.email || (state.user.username ? state.user.username + '@nbsz.co.zw' : 'user@nbsz.co.zw');

        var initials = 'AD';
        var parts = name.trim().split(/\s+/);
        if (parts.length >= 2) {
            initials = (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
        } else if (name.length >= 2) {
            initials = name.substring(0, 2).toUpperCase();
        }

        if (el.userName) el.userName.textContent = name;
        if (el.userRole) el.userRole.textContent = role;
        if (el.userAvatar) el.userAvatar.textContent = initials;
        if (el.udAvatarLg) el.udAvatarLg.textContent = initials;
        if (el.udFullName) el.udFullName.textContent = name;
        if (el.udEmail) el.udEmail.textContent = email;
        if (el.udUsername) el.udUsername.textContent = state.user.username || '-';
        if (el.udRoleBadge) el.udRoleBadge.textContent = role;
    }

    /**
     * Loads the reference data the forms need. Each call is individually
     * guarded so a role that cannot read one of the pick-lists (a Departmental
     * User cannot read maintenance meta, for example) still gets a working page.
     */
    function loadReferenceData() {
        var jobs = [];

        jobs.push(
            Api.assets.listCategories().then(
                function (data) {
                    meta.assetCategories = (data && data.categories) || [];
                },
                function () { meta.assetCategories = []; }
            )
        );

        jobs.push(
            Api.referenceData.list().then(
                function (data) {
                    meta.referenceData = data || { departments: [], locations: [] };
                    meta.referenceDataError = null;
                },
                function (error) {
                    meta.referenceData = null;
                    meta.referenceDataError = error;
                }
            )
        );

        if (can.write()) {
            jobs.push(
                Api.assets.getMeta().then(
                    function (data) { meta.assetsMeta = data; },
                    function () { meta.assetsMeta = null; }
                )
            );
            jobs.push(
                Api.maintenance.getMeta().then(
                    function (data) { meta.maintenance = data; },
                    function () { meta.maintenance = null; }
                )
            );
            jobs.push(
                Api.assignments.getMeta().then(
                    function (data) { meta.assignment = data; },
                    function () { meta.assignment = null; }
                )
            );
            jobs.push(
                Api.transfers.getMeta().then(
                    function (data) { meta.transfer = data; },
                    function () { meta.transfer = null; }
                )
            );
            jobs.push(
                Api.warranties.getMeta().then(
                    function (data) { meta.warranty = data; },
                    function () { meta.warranty = null; }
                )
            );
            jobs.push(
                Api.stock.getMeta().then(
                    function (data) { meta.stock = data; },
                    function () { meta.stock = null; }
                )
            );
        }

        return Promise.all(jobs);
    }

    /**
     * Refreshes the sidebar badge with the number of open repairs so the
     * maintenance module is visible at a glance (§5.5).
     */
    function refreshOpenBadge() {
        if (!can.readAll() && !state.user) return;

        Api.maintenance.getStats().then(
            function (stats) {
                var open = (stats && stats.open) || 0;
                el.openMaintenanceBadge.textContent = open;
                el.openMaintenanceBadge.hidden = open === 0;
            },
            function () {
                el.openMaintenanceBadge.hidden = true;
            }
        );
    }

    /**
     * Refreshes the sidebar badge with the number of warranties expiring soon,
     * so the §5.6 expiry alerts are visible without opening the module.
     */
    function refreshExpiringBadge() {
        if (!el.expiringWarrantyBadge || !state.user) return;

        Api.warranties.getStats().then(
            function (stats) {
                var soon = ((stats && stats.expiringSoon) || 0) +
                    ((stats && stats.derivedExpiringSoon) || 0);
                var expired = (stats && stats.expired) || 0;

                el.expiringWarrantyBadge.textContent = soon;
                el.expiringWarrantyBadge.hidden = soon === 0;

                // An expired backlog is the more urgent signal, so it wins the
                // badge title when both are present.
                el.expiringWarrantyBadge.title = expired
                    ? soon + ' expiring soon, ' + expired + ' already expired'
                    : soon + ' expiring within 90 days';
            },
            function () {
                el.expiringWarrantyBadge.hidden = true;
            }
        );
    }

    /**
     * Refreshes the sidebar badge with the number of store lines at or below
     * their minimum level, so §5.7's replenishment signal is visible without
     * opening the module.
     */
    function refreshLowStockBadge() {
        if (!el.lowStockBadge || !state.user) return;

        Api.stock.getStats().then(
            function (stats) {
                var low = (stats && stats.lowStock) || 0;

                el.lowStockBadge.textContent = low;
                el.lowStockBadge.hidden = low === 0;
                el.lowStockBadge.title = low === 1
                    ? '1 store line is at or below its minimum level'
                    : low + ' store lines are at or below their minimum level';
            },
            function () {
                el.lowStockBadge.hidden = true;
            }
        );
    }

    /* ======================================================================
     * Router
     * ==================================================================== */

    var VIEWS = {
        dashboard: renderDashboard,
        assets: renderAssets,
        assignments: renderAssignments,
        transfers: renderTransfers,
        maintenance: renderMaintenance,
        warranty: renderWarranty,
        stock: renderStock,
        barcode: renderBarcode,
        verification: renderVerification,
        disposal: renderDisposal,
        licence: renderLicences,
        reports: renderReports,
        users: renderUsers,
        referenceData: renderReferenceData,
        procurement: renderProcurement
    };

    function navigate(view) {
        if (state.user && state.user.must_change_password) {
            renderForcedPasswordChange();
            return;
        }
        if (!VIEWS[view]) return;
        if (state.view === 'barcode' && view !== 'barcode') stopBarcodeCamera();

        state.view = view;
        el.viewTitle.textContent = VIEW_TITLES[view] || view;

        Array.prototype.forEach.call(el.nav.querySelectorAll('.nav-item'), function (btn) {
            btn.classList.toggle('active', btn.getAttribute('data-view') === view);
        });

        clearAlert();
        VIEWS[view]();
    }

    el.nav.addEventListener('click', function (event) {
        var btn = event.target.closest('.nav-item');
        if (!btn || btn.classList.contains('disabled')) return;
        navigate(btn.getAttribute('data-view'));
    });

    el.logoutBtn.addEventListener('click', function () {
        stopBarcodeCamera();
        Api.logout().then(function () {
            window.location.replace('/login.html');
        }).catch(function () {
            Api.clearSession();
            window.location.replace('/login.html');
        });
    });

    window.addEventListener('pagehide', stopBarcodeCamera);

    /* ======================================================================
     * Settings, Collapsible Sidebar, User Profile Menu & Chart Helpers
     * ==================================================================== */

    var dashboardCharts = [];
    function destroyDashboardCharts() {
        dashboardCharts.forEach(function (c) {
            try { c.destroy(); } catch (e) {}
        });
        dashboardCharts = [];
    }

    var reportChart = null;
    function destroyReportChart() {
        if (reportChart) {
            try { reportChart.destroy(); } catch (e) {}
            reportChart = null;
        }
    }

    function initWorkspaceSettings() {
        // Table density
        var density = localStorage.getItem('nbsz_table_density') || 'default';
        applyDensity(density);
        if (el.settingDensity) el.settingDensity.value = density;
        var mDensity = document.getElementById('mSettingDensity');
        if (mDensity) mDensity.value = density;

        // Contrast mode
        var contrast = localStorage.getItem('nbsz_contrast_mode') || 'standard';
        applyContrast(contrast);
        if (el.settingContrast) el.settingContrast.value = contrast;
        var mContrast = document.getElementById('mSettingContrast');
        if (mContrast) mContrast.value = contrast;

        // Page size
        var pageSize = parseInt(localStorage.getItem('nbsz_page_size') || '25', 10);
        applyPageSize(pageSize);
        if (el.settingPageSize) el.settingPageSize.value = String(pageSize);
        var mPageSize = document.getElementById('mSettingPageSize');
        if (mPageSize) mPageSize.value = String(pageSize);

        // Sidebar collapsed
        var sidebarCollapsed = localStorage.getItem('nbsz_sidebar_collapsed') === 'true';
        if (el.sidebar) {
            el.sidebar.classList.toggle('collapsed', sidebarCollapsed);
        }

        // Toggle sidebar button
        if (el.sidebarToggle && el.sidebar) {
            el.sidebarToggle.addEventListener('click', function () {
                var isCollapsed = el.sidebar.classList.toggle('collapsed');
                localStorage.setItem('nbsz_sidebar_collapsed', isCollapsed ? 'true' : 'false');
            });
        }

        // User profile menu pill dropdown toggle
        if (el.userMenuPill && el.userDropdownCard) {
            el.userMenuPill.addEventListener('click', function (e) {
                e.stopPropagation();
                var isOpen = !el.userDropdownCard.hidden;
                el.userDropdownCard.hidden = isOpen;
                el.userMenuPill.setAttribute('aria-expanded', !isOpen ? 'true' : 'false');
            });

            // Close on outside click
            document.addEventListener('click', function (e) {
                if (el.userDropdownCard && !el.userDropdownCard.hidden && !el.userDropdownCard.contains(e.target) && !el.userMenuPill.contains(e.target)) {
                    el.userDropdownCard.hidden = true;
                    el.userMenuPill.setAttribute('aria-expanded', 'false');
                }
            });

            // Close on escape
            document.addEventListener('keydown', function (e) {
                if (e.key === 'Escape' && el.userDropdownCard && !el.userDropdownCard.hidden) {
                    el.userDropdownCard.hidden = true;
                    el.userMenuPill.setAttribute('aria-expanded', 'false');
                }
            });
        }

        // Tab switching inside user dropdown
        var tabBtns = document.querySelectorAll('.ud-tab-btn');
        var panes = {
            profile: document.getElementById('udPaneProfile'),
            password: document.getElementById('udPanePassword'),
            settings: document.getElementById('udPaneSettings')
        };
        tabBtns.forEach(function (btn) {
            btn.addEventListener('click', function () {
                var tab = btn.getAttribute('data-tab');
                tabBtns.forEach(function (b) { b.classList.toggle('active', b === btn); });
                Object.keys(panes).forEach(function (key) {
                    if (panes[key]) {
                        panes[key].classList.toggle('active', key === tab);
                    }
                });
            });
        });

        // Topbar Settings button opens settings modal
        if (el.topbarSettingsBtn && el.settingsModal) {
            el.topbarSettingsBtn.addEventListener('click', function () {
                el.settingsModal.hidden = false;
            });
        }
        if (el.settingsModalClose && el.settingsModal) {
            el.settingsModalClose.addEventListener('click', function () {
                el.settingsModal.hidden = true;
            });
        }
        if (el.settingsModalCancel && el.settingsModal) {
            el.settingsModalCancel.addEventListener('click', function () {
                el.settingsModal.hidden = true;
            });
        }
        if (el.settingsModalSave && el.settingsModal) {
            el.settingsModalSave.addEventListener('click', function () {
                var mDens = document.getElementById('mSettingDensity');
                var mCont = document.getElementById('mSettingContrast');
                var mPage = document.getElementById('mSettingPageSize');
                if (mDens) { applyDensity(mDens.value); if (el.settingDensity) el.settingDensity.value = mDens.value; }
                if (mCont) { applyContrast(mCont.value); if (el.settingContrast) el.settingContrast.value = mCont.value; }
                if (mPage) { applyPageSize(parseInt(mPage.value, 10)); if (el.settingPageSize) el.settingPageSize.value = mPage.value; }
                el.settingsModal.hidden = true;
                showAlert('Workspace preferences applied across all views.', 'success');
            });
        }

        // Dropdown settings inputs
        if (el.settingDensity) {
            el.settingDensity.addEventListener('change', function () {
                applyDensity(el.settingDensity.value);
            });
        }
        if (el.settingContrast) {
            el.settingContrast.addEventListener('change', function () {
                applyContrast(el.settingContrast.value);
            });
        }
        if (el.settingPageSize) {
            el.settingPageSize.addEventListener('change', function () {
                applyPageSize(parseInt(el.settingPageSize.value, 10));
            });
        }

        // Quick Change Password Form
        if (el.quickChangePasswordForm) {
            el.quickChangePasswordForm.addEventListener('submit', function (e) {
                e.preventDefault();
                var cur = document.getElementById('qCurrentPassword').value;
                var next = document.getElementById('qNewPassword').value;
                var conf = document.getElementById('qConfirmPassword').value;
                var submitBtn = document.getElementById('qPasswordSubmit');

                var reqErrors = passwordRequirementErrors(next);
                if (reqErrors.length) {
                    showAlert(reqErrors[0], 'error');
                    return;
                }
                if (next !== conf) {
                    showAlert('The new password and confirmation do not match.', 'error');
                    return;
                }
                submitBtn.disabled = true;
                submitBtn.textContent = 'Updating password...';
                Api.changePassword(cur, next, conf).then(function () {
                    showAlert('Password updated successfully!', 'success');
                    el.quickChangePasswordForm.reset();
                    if (el.userDropdownCard) el.userDropdownCard.hidden = true;
                }).catch(function (err) {
                    showAlert(err.message || 'Could not update password.', 'error');
                }).finally(function () {
                    submitBtn.disabled = false;
                    submitBtn.textContent = 'Save New Password';
                });
            });
        }
    }

    function applyDensity(density) {
        document.body.classList.remove('density-compact', 'density-comfortable');
        if (density === 'compact') document.body.classList.add('density-compact');
        if (density === 'comfortable') document.body.classList.add('density-comfortable');
        localStorage.setItem('nbsz_table_density', density);
    }

    function applyContrast(contrast) {
        document.body.classList.toggle('theme-high-contrast', contrast === 'high');
        localStorage.setItem('nbsz_contrast_mode', contrast);
    }

    function applyPageSize(size) {
        if (!size || size < 5) size = 25;
        localStorage.setItem('nbsz_page_size', String(size));
        ['users', 'assets', 'assignments', 'transfers', 'maintenance', 'warranty', 'stock', 'stockLedger', 'barcode', 'procurement'].forEach(function (mod) {
            if (state[mod] && typeof state[mod].limit !== 'undefined') {
                state[mod].limit = size;
            }
        });
    }


    /* ======================================================================
     * Dashboard view (§12 asset summary + maintenance panel)
     * ==================================================================== */

    function statTile(label, value, hint, kind) {
        return (
            '<div class="stat' + (kind ? ' ' + kind : '') + '">' +
            '<div class="label">' + esc(label) + '</div>' +
            '<div class="value">' + esc(value) + '</div>' +
            (hint ? '<div class="hint">' + esc(hint) + '</div>' : '') +
            '</div>'
        );
    }

    function renderReports() {
        showLoading('Loading reports...');
        Promise.all([Api.reports.getTypes(), Api.reports.getSummary()]).then(function (values) {
            state.reports.types = values[0] || [];
            state.reports.summary = values[1] || {};
            if (!state.reports.type && state.reports.types.length) {
                state.reports.type = state.reports.types[0].type;
            }
            drawReports();
        }).catch(function (error) {
            el.view.innerHTML = '<div class="card"><div class="card-body">Could not load reports: ' +
                esc(error.message) + '</div></div>';
        });
    }

    function drawReports() {
        var reportState = state.reports;
        var selected = reportState.types.find(function (item) {
            return item.type === reportState.type;
        }) || reportState.types[0];
        if (!selected) {
            el.view.innerHTML = '<div class="card"><div class="card-body">No reports are available.</div></div>';
            return;
        }

        reportState.type = selected.type;
        var filters = selected.filters || [];
        var labels = {
            search: 'Search', status: 'Status', department: 'Department',
            location: 'Location', category: 'Category', from: 'Date from', to: 'Date to'
        };
        var summary = reportState.summary || {};
        var assets = summary.assets || {};
        var warranties = summary.warranties || {};
        var maintenance = summary.maintenance || {};
        var stock = summary.stock || {};
        var verification = summary.verification || {};
        var disposals = summary.disposals || {};
        var licences = summary.licences || {};

        var filterHtml = filters.map(function (key) {
            var dateInput = key === 'from' || key === 'to';
            if (dateInput) {
                return '<div><label class="field-label" for="reportFilter-' + esc(key) + '">' +
                    esc(labels[key] || key) + '</label><input id="reportFilter-' + esc(key) +
                    '" name="' + esc(key) + '" type="date" value="' + esc(reportState.filters[key] || '') + '"></div>';
            }
            if (key === 'department') {
                var deptList = (meta.referenceData && meta.referenceData.departments) || [];
                var curDept = reportState.filters[key] || '';
                return '<div><label class="field-label" for="reportFilter-department">Department</label>' +
                    '<select id="reportFilter-department" name="department">' +
                    '<option value="">All departments</option>' +
                    deptList.map(function (d) {
                        return '<option value="' + esc(d.name) + '"' + (d.name === curDept ? ' selected' : '') + '>' + esc(d.name) + '</option>';
                    }).join('') + '</select></div>';
            }
            if (key === 'location') {
                var locList = (meta.referenceData && meta.referenceData.locations) || [];
                var curLoc = reportState.filters[key] || '';
                return '<div><label class="field-label" for="reportFilter-location">Location</label>' +
                    '<select id="reportFilter-location" name="location">' +
                    '<option value="">All locations</option>' +
                    locList.map(function (l) {
                        return '<option value="' + esc(l.name) + '"' + (l.name === curLoc ? ' selected' : '') + '>' + esc(l.name) + '</option>';
                    }).join('') + '</select></div>';
            }
            if (key === 'category') {
                var catList = meta.assetCategories || [];
                var curCat = reportState.filters[key] || '';
                return '<div><label class="field-label" for="reportFilter-category">Category</label>' +
                    '<select id="reportFilter-category" name="category">' +
                    '<option value="">All categories</option>' +
                    catList.map(function (c) {
                        var name = c.category_name || c.name;
                        return '<option value="' + esc(name) + '"' + (name === curCat ? ' selected' : '') + '>' + esc(name) + '</option>';
                    }).join('') + '</select></div>';
            }
            if (key === 'status') {
                var curStat = reportState.filters[key] || '';
                var statusOpts = ['', 'In Use', 'In Stock', 'Under Repair', 'Missing', 'Retired', 'Disposed', 'Open', 'In Progress', 'Completed', 'Active', 'Expired'];
                return '<div><label class="field-label" for="reportFilter-status">Status</label>' +
                    '<select id="reportFilter-status" name="status">' +
                    statusOpts.map(function (st) {
                        return '<option value="' + esc(st) + '"' + (st === curStat ? ' selected' : '') + '>' + (st || 'All statuses') + '</option>';
                    }).join('') + '</select></div>';
            }
            return '<div><label class="field-label" for="reportFilter-' + esc(key) + '">' +
                esc(labels[key] || key) + '</label><input id="reportFilter-' + esc(key) +
                '" name="' + esc(key) + '" type="text" value="' + esc(reportState.filters[key] || '') + '"></div>';
        }).join('');

        var result = reportState.result;
        var table = '';
        var chartHtml = '';
        var groupKey = null;

        if (result) {
            var rows = result.rows || [];
            if (result.columns.some(function (c) { return c.key === 'department'; })) groupKey = 'department';
            else if (result.columns.some(function (c) { return c.key === 'category_name'; })) groupKey = 'category_name';
            else if (result.columns.some(function (c) { return c.key === 'status'; })) groupKey = 'status';
            else if (result.columns.some(function (c) { return c.key === 'asset_status'; })) groupKey = 'asset_status';

            if (groupKey && rows.length > 0) {
                chartHtml = '<div class="card report-chart-card">' +
                    '<div class="card-head"><div><h3>Report Distribution Breakdown</h3>' +
                    '<p class="muted">Summary count of ' + rows.length + ' record(s) grouped by ' + esc(groupKey.replace('_', ' ')) + '</p></div></div>' +
                    '<div class="card-body"><div class="chart-container" style="height:220px;"><canvas id="reportChartCanvas"></canvas></div></div>' +
                    '</div>';
            }

            table = '<div class="card"><div class="card-head"><h3>' + esc(result.title) +
                '</h3><div class="spacer"></div><button class="btn btn-secondary report-export" data-format="csv"' +
                (rows.length ? '' : ' disabled') + '>CSV</button><button class="btn btn-secondary report-export" data-format="xlsx"' +
                (rows.length ? '' : ' disabled') + '>Excel</button><button class="btn btn-secondary report-export" data-format="pdf"' +
                (rows.length ? '' : ' disabled') + '>PDF</button></div><div class="card-body">' +
                '<div class="muted">' + rows.length + ' row(s)' +
                (result.truncated ? ' shown; refine filters to export the full report.' : '') +
                '</div></div>' + (rows.length
                    ? '<div class="table-wrap"><table class="data"><thead><tr>' +
                        result.columns.map(function (column) {
                            return '<th>' + esc(column.label) + '</th>';
                        }).join('') + '</tr></thead><tbody>' +
                        rows.map(function (row) {
                            return '<tr>' + result.columns.map(function (column) {
                                return '<td>' + orDash(row[column.key]) + '</td>';
                            }).join('') + '</tr>';
                        }).join('') + '</tbody></table></div>'
                    : '<div class="empty">No records match these filters.</div>') + '</div>';
        }

        el.view.innerHTML =
            '<div class="stat-grid">' +
            statTile('Assets', assets.total || 0, (assets.in_use || 0) + ' in use', 'info') +
            statTile('Warranties expiring in 30 days', warranties.expiring || 0, null, 'warn') +
            statTile('Open work orders', maintenance.open || 0, null, 'warn') +
            statTile('Low stock lines', stock.low_stock || 0, null, 'warn') +
            statTile('Verification exceptions', verification.exceptions || 0, null, 'warn') +
            statTile('Open disposal requests', disposals.pending_disposals || 0) +
            statTile('Active licence seats', licences.allocated_seats || 0,
                (licences.purchased_seats || 0) + ' purchased', 'ok') +
            '</div><div class="card"><div class="card-head"><h3>Build a report</h3></div>' +
            '<div class="card-body"><form id="reportForm"><div class="toolbar">' +
            '<div><label class="field-label" for="reportType">Report</label><select id="reportType">' +
            reportState.types.map(function (item) {
                return '<option value="' + esc(item.type) + '"' +
                    (item.type === selected.type ? ' selected' : '') + '>' + esc(item.title) + '</option>';
            }).join('') + '</select></div>' + filterHtml +
            '<button class="btn btn-primary" type="submit">Run report</button></div></form></div></div>' +
            chartHtml +
            (table || '<div class="empty">Choose filters and run a report to view results.</div>');

        // Draw summary chart if applicable
        destroyReportChart();
        var canvas = document.getElementById('reportChartCanvas');
        if (canvas && window.Chart && groupKey && result && result.rows && result.rows.length) {
            var counts = {};
            result.rows.forEach(function (r) {
                var val = r[groupKey] || 'Unspecified';
                counts[val] = (counts[val] || 0) + 1;
            });
            var rLabels = Object.keys(counts);
            var rData = rLabels.map(function (k) { return counts[k]; });
            reportChart = new window.Chart(canvas, {
                type: 'bar',
                data: {
                    labels: rLabels,
                    datasets: [{
                        label: 'Records',
                        data: rData,
                        backgroundColor: '#0f2942',
                        borderRadius: 4
                    }]
                },
                options: {
                    responsive: true,
                    maintainAspectRatio: false,
                    plugins: { legend: { display: false } },
                    scales: {
                        y: { beginAtZero: true, ticks: { precision: 0 }, grid: { color: '#e2e8f0' } },
                        x: { grid: { display: false } }
                    }
                }
            });
        }

        document.getElementById('reportType').addEventListener('change', function (event) {
            reportState.type = event.target.value;
            reportState.result = null;
            reportState.filters = {};
            drawReports();
        });
        document.getElementById('reportForm').addEventListener('submit', function (event) {
            event.preventDefault();
            var form = event.currentTarget;
            var data = new FormData(form);
            reportState.filters = {};
            filters.forEach(function (key) {
                var value = String(data.get(key) || '').trim();
                if (value) reportState.filters[key] = value;
            });
            runReport();
        });

        el.view.querySelectorAll('.report-export').forEach(function (button) {
            button.addEventListener('click', function () {
                var format = button.getAttribute('data-format');
                if (format === 'csv') {
                    exportReportCsv();
                } else {
                    exportReportFile(format, button);
                }
            });
        });
    }

    function runReport() {
        state.reports.result = null;
        showLoading('Running report...');
        Api.reports.run(state.reports.type, state.reports.filters).then(function (result) {
            state.reports.result = result;
            drawReports();
        }).catch(function (error) {
            drawReports();
            showAlert(error.message, 'error');
        });
    }

    function exportReportCsv() {
        var result = state.reports.result;
        if (!result || !result.rows.length) return;
        function csvCell(value) {
            var text = value === null || value === undefined ? '' : String(value);
            if (/^[\t\r ]*[=+\-@]/.test(text)) text = "'" + text;
            return '"' + text.replace(/"/g, '""') + '"';
        }
        var lines = [result.columns.map(function (column) {
            return csvCell(column.label);
        }).join(',')];
        result.rows.forEach(function (row) {
            lines.push(result.columns.map(function (column) {
                return csvCell(row[column.key]);
            }).join(','));
        });
        var blob = new Blob(['\uFEFF' + lines.join('\r\n')], { type: 'text/csv;charset=utf-8' });
        var url = URL.createObjectURL(blob);
        var link = document.createElement('a');
        link.href = url;
        link.download = result.type + '.csv';
        link.click();
        window.setTimeout(function () {
            URL.revokeObjectURL(url);
        }, 1000);
    }

    function exportReportFile(format, button) {
        var result = state.reports.result;
        if (!result || !result.rows.length) return;
        button.disabled = true;
        var label = button.textContent;
        button.textContent = 'Preparing...';
        Api.reports.export(result.type, format, state.reports.filters).then(function (blob) {
            var url = URL.createObjectURL(blob);
            var link = document.createElement('a');
            link.href = url;
            link.download = result.type + '.' + format;
            link.click();
            window.setTimeout(function () {
                URL.revokeObjectURL(url);
            }, 1000);
        }).catch(function (error) {
            showAlert(error.message || 'Could not export this report.', 'error');
        }).finally(function () {
            button.disabled = false;
            button.textContent = label;
        });
    }

    function renderDashboard() {
        showLoading('Loading dashboard...');

        var assetStats = can.readAll() || can.write()
            ? Api.assets.getStats().catch(function (error) { return { error: error }; })
            : Promise.resolve(null);

        var maintStats = Api.maintenance.getStats().catch(function (error) { return { error: error }; });
        var recentMaint = Api.maintenance.getRecent(6).catch(function (error) { return { error: error }; });
        var overdue = Api.maintenance.getOverdue().catch(function (error) { return { error: error }; });
        var expiringWarranties = Api.warranties.getExpiring({ days: 30 }).catch(function (error) { return { error: error }; });
        var canApprove = state.user && ['System Administrator', 'HISO'].indexOf(state.user.role) !== -1;
        var pendingTransfers = canApprove
            ? Api.transfers.getStats().catch(function (error) { return { error: error }; })
            : Promise.resolve(null);
        var pendingDisposals = canApprove
            ? Api.disposal.getStats().catch(function (error) { return { error: error }; })
            : Promise.resolve(null);
        var allMaintPromise = Api.maintenance.list({ limit: 100 }).catch(function () { return { maintenance: [] }; });
        var stockPromise = Api.stock.list({ limit: 8 }).catch(function () { return { items: [] }; });

        Promise.all([assetStats, maintStats, recentMaint, overdue, expiringWarranties, pendingTransfers, pendingDisposals, allMaintPromise, stockPromise]).then(function (results) {
            var assets = results[0];
            var maint = results[1];
            var recentResult = results[2];
            var overdueResult = results[3];
            var warrantyResult = results[4];
            var transferResult = results[5];
            var disposalResult = results[6];
            var allMaintResult = results[7];
            var stockResult = results[8];

            var recent = (recentResult && recentResult.maintenance) || [];
            var late = (overdueResult && overdueResult.maintenance) || [];
            var expiring = (warrantyResult && warrantyResult.warranties) || [];
            var pendingTransferCount = transferResult && !transferResult.error
                ? Number(transferResult.pending || 0)
                : null;
            var pendingDisposalCount = disposalResult && !disposalResult.error
                ? Number(disposalResult.pendingApproval || 0)
                : null;
            var openRepairs = maint && !maint.error ? Number(maint.openRepairs || 0) : 0;
            var openServices = maint && !maint.error ? Number(maint.openServices || 0) : 0;
            var openOther = maint && !maint.error ? Number(maint.openOther || 0) : 0;
            var openWorkHint = openRepairs + ' repair' + (openRepairs === 1 ? '' : 's') +
                ' · ' + openServices + ' service' + (openServices === 1 ? '' : 's');
            if (openOther) {
                openWorkHint += ' · ' + openOther + ' other';
            }

            var updatedAt = new Intl.DateTimeFormat('en-ZW', {
                dateStyle: 'medium',
                timeStyle: 'short'
            }).format(new Date());
            var html =
                '<div class="dashboard">' +
                '<section class="dashboard-intro">' +
                '<div><div class="dashboard-eyebrow">NATIONAL BLOOD SERVICE ZIMBABWE</div>' +
                '<h3>Operational overview</h3>' +
                '<p>Asset register position, maintenance workload, and stores analytics at a glance.</p></div>' +
                '<div class="dashboard-intro-actions"><span class="dashboard-updated">Updated ' +
                esc(updatedAt) + '</span><button class="btn btn-secondary" id="dashboardRefresh">Refresh</button></div>' +
                '</section>';

            if (assets && assets.error) {
                html +=
                    '<div class="card dashboard-error"><div class="card-body">Could not load asset statistics: ' +
                    esc(assets.error.message || 'The asset statistics request failed.') +
                    '</div></div>';
            } else if (assets) {
                html +=
                    '<section class="dashboard-section">' +
                    '<div class="dashboard-section-head"><div><h3>Asset register</h3>' +
                    '<p>Current status of all registered assets.</p></div>' +
                    '<button class="btn btn-secondary btn-sm" data-dashboard-view="assets">View register</button></div>' +
                    '<div class="stat-grid dashboard-kpis">' +
                    statTile('Total assets', assets.total ?? 0, 'All lifecycle statuses', 'info') +
                    statTile('In use', assets.inUse ?? 0, 'Currently assigned') +
                    statTile('In stock', assets.inStock ?? 0, 'Available in stores') +
                    statTile('Assets under repair', assets.underRepair ?? 0, 'Asset register status', 'warn') +
                    '</div>' +
                    '<div class="dashboard-status-strip">' +
                    '<span>Other statuses</span>' +
                    '<span>Missing <strong>' + esc(assets.missing ?? 0) + '</strong></span>' +
                    '<span>Retired <strong>' + esc(assets.retired ?? 0) + '</strong></span>' +
                    '<span>Disposed <strong>' + esc(assets.disposed ?? 0) + '</strong></span>' +
                    '</div></section>';
            }

            if (maint && maint.error) {
                html +=
                    '<div class="card dashboard-error"><div class="card-body">Could not load maintenance statistics: ' +
                    esc(maint.error.message || 'The maintenance statistics request failed.') +
                    '</div></div>';
            } else if (maint) {
                html +=
                    '<section class="dashboard-section">' +
                    '<div class="dashboard-section-head"><div><h3>Maintenance workload</h3>' +
                    '<p>Work orders count jobs; assets under repair count register items.</p></div>' +
                    '<button class="btn btn-secondary btn-sm" data-dashboard-view="maintenance">View maintenance</button></div>' +
                    '<div class="stat-grid dashboard-kpis">' +
                    statTile('Open work orders', maint.open ?? 0, openWorkHint, 'warn') +
                    statTile('Repair work orders', openRepairs, 'Open jobs of type Repair', 'warn') +
                    statTile('Overdue work orders', maint.overdue ?? 0, 'Past their scheduled date', maint.overdue ? 'danger' : '') +
                    statTile('Maintenance spend this year', money(maint.costThisYear || 0), 'Year to date', 'info') +
                    '</div></section>';
            }

            // Interactive Visual Analytics Section with 3 Charts
            html +=
                '<section class="dashboard-section">' +
                '<div class="dashboard-section-head"><div><h3>Visual Analytics &amp; Operational Metrics</h3>' +
                '<p>Graphical breakdown of capital equipment lifecycle, maintenance severity, and spare parts.</p></div></div>' +
                '<div class="charts-grid">' +
                '<div class="card chart-card">' +
                '<div class="card-head"><div><h3 class="chart-title">Asset Lifecycle Distribution</h3>' +
                '<p class="chart-sub muted">Live breakdown across operational statuses</p></div></div>' +
                '<div class="card-body"><div class="chart-container"><canvas id="chartAssetStatus"></canvas></div></div>' +
                '</div>' +
                '<div class="card chart-card">' +
                '<div class="card-head"><div><h3 class="chart-title">Maintenance Workload by Priority</h3>' +
                '<p class="chart-sub muted">Open &amp; recent service tickets by severity</p></div></div>' +
                '<div class="card-body"><div class="chart-container"><canvas id="chartMaintPriority"></canvas></div></div>' +
                '</div>' +
                '<div class="card chart-card span-all">' +
                '<div class="card-head"><div><h3 class="chart-title">ICT Store Spares vs Reorder Levels</h3>' +
                '<p class="chart-sub muted">Stock balances against minimum reorder points</p></div></div>' +
                '<div class="card-body"><div class="chart-container" style="height:250px;"><canvas id="chartStockBalances"></canvas></div></div>' +
                '</div>' +
                '</div></section>';

            html +=
                '<section class="card dashboard-panel dashboard-attention">' +
                '<div class="card-head"><div><h3>Needs attention</h3>' +
                '<p>Operational reminders based on current records</p></div></div>' +
                '<div class="attention-list">';
            html += dashboardReminder(
                'Overdue maintenance',
                overdueResult && overdueResult.error ? null : late.length,
                overdueResult && overdueResult.error ? overdueResult.error.message : 'Open work orders past their scheduled date',
                'maintenance'
            );
            html += dashboardReminder(
                'Warranties expiring in 30 days',
                warrantyResult && warrantyResult.error ? null : expiring.length,
                warrantyResult && warrantyResult.error ? warrantyResult.error.message : 'Review coverage before it expires',
                'warranty'
            );
            if (canApprove) {
                html += dashboardReminder(
                    'Transfers awaiting approval',
                    pendingTransferCount,
                    transferResult && transferResult.error ? transferResult.error.message : 'Review pending asset movements',
                    'transfers'
                );
                html += dashboardReminder(
                    'Disposals awaiting approval',
                    pendingDisposalCount,
                    disposalResult && disposalResult.error ? disposalResult.error.message : 'Review pending disposal requests',
                    'disposal'
                );
            }
            html += '</div></section>';

            html +=
                '<div class="dashboard-panels">' +
                '<section class="card dashboard-panel"><div class="card-head"><div><h3>Recent work orders</h3>' +
                '<p>Latest recorded maintenance activity</p></div></div><div class="dashboard-table">';

            if (recentResult && recentResult.error) {
                html += '<div class="empty">Could not load recent work orders: ' +
                    esc(recentResult.error.message || 'Request failed.') + '</div>';
            } else {
                html += table(
                    recent,
                    [
                        { label: 'Reference', render: function (r) { return '<strong>' + esc(r.maintenance_ref || '') + '</strong>'; } },
                        {
                            label: 'Asset',
                            render: function (r) {
                                return orDash(r.asset_tag) +
                                    '<div class="muted" style="font-size:12px;">' + orDash(r.asset_code) + '</div>' +
                                    (r.asset_status ? '<div class="muted" style="font-size:11px;">Register: ' +
                                        esc(r.asset_status) + '</div>' : '');
                            }
                        },
                        { label: 'Type', key: 'maintenance_type' },
                        { label: 'Priority', render: function (r) { return priorityBadge(r.priority); } },
                        { label: 'Status', render: function (r) { return badge(r.status); } },
                        { label: 'Reported', className: 'nowrap', render: function (r) { return orDash(day(r.reported_date)); } }
                    ],
                    { empty: 'No work orders have been recorded yet.' }
                );
            }

            html += '</div></section>' +
                '<section class="card dashboard-panel"><div class="card-head"><div><h3>Overdue work orders</h3>' +
                '<p>Open jobs past their scheduled date</p></div></div><div class="dashboard-table">';

            if (overdueResult && overdueResult.error) {
                html += '<div class="empty">Could not load overdue work orders: ' +
                    esc(overdueResult.error.message || 'Request failed.') + '</div>';
            } else {
                html += table(
                    late,
                    [
                        { label: 'Reference', key: 'maintenance_ref' },
                        { label: 'Asset', render: function (r) { return orDash(r.asset_tag); } },
                        { label: 'Scheduled', className: 'nowrap', render: function (r) { return orDash(day(r.scheduled_date)); } },
                        { label: 'Priority', render: function (r) { return priorityBadge(r.priority); } },
                        { label: 'Status', render: function (r) { return badge(r.status); } }
                    ],
                    { empty: 'No overdue work orders. Everything scheduled is on track.' }
                );
            }

            html += '</div></section></div></div>';
            el.view.innerHTML = html;

            // Instantiate Chart.js charts
            destroyDashboardCharts();
            if (window.Chart) {
                // Chart 1: Asset Lifecycle Distribution
                var ctxStatus = document.getElementById('chartAssetStatus');
                if (ctxStatus && assets && !assets.error) {
                    var inUse = Number(assets.inUse || 0);
                    var inStock = Number(assets.inStock || 0);
                    var underRepair = Number(assets.underRepair || 0);
                    var missing = Number(assets.missing || 0);
                    var retired = Number(assets.retired || 0);
                    var disposed = Number(assets.disposed || 0);

                    var c1 = new window.Chart(ctxStatus, {
                        type: 'doughnut',
                        data: {
                            labels: ['In Use', 'In Stock', 'Under Repair', 'Missing', 'Retired', 'Disposed'],
                            datasets: [{
                                data: [inUse, inStock, underRepair, missing, retired, disposed],
                                backgroundColor: ['#0f2942', '#059669', '#d97706', '#ba1a1a', '#64748b', '#94a3b8'],
                                borderWidth: 2,
                                borderColor: '#ffffff'
                            }]
                        },
                        options: {
                            responsive: true,
                            maintainAspectRatio: false,
                            plugins: {
                                legend: {
                                    position: 'right',
                                    labels: { boxWidth: 12, padding: 10, font: { family: 'Segoe UI, sans-serif', size: 12 } }
                                }
                            },
                            cutout: '66%'
                        }
                    });
                    dashboardCharts.push(c1);
                }

                // Chart 2: Maintenance Priority
                var ctxPriority = document.getElementById('chartMaintPriority');
                if (ctxPriority) {
                    var maintList = (allMaintResult && allMaintResult.maintenance) || recent;
                    var counts = { Critical: 0, High: 0, Medium: 0, Low: 0 };
                    maintList.forEach(function (m) {
                        var p = m.priority || 'Medium';
                        if (typeof counts[p] !== 'undefined') counts[p]++;
                        else counts.Medium++;
                    });

                    var c2 = new window.Chart(ctxPriority, {
                        type: 'bar',
                        data: {
                            labels: ['Critical', 'High', 'Medium', 'Low'],
                            datasets: [{
                                label: 'Work Orders',
                                data: [counts.Critical, counts.High, counts.Medium, counts.Low],
                                backgroundColor: ['#ba1a1a', '#e11d48', '#d97706', '#059669'],
                                borderRadius: 4
                            }]
                        },
                        options: {
                            responsive: true,
                            maintainAspectRatio: false,
                            plugins: { legend: { display: false } },
                            scales: {
                                y: {
                                    beginAtZero: true,
                                    ticks: { precision: 0 },
                                    grid: { color: '#e2e8f0' }
                                },
                                x: { grid: { display: false } }
                            }
                        }
                    });
                    dashboardCharts.push(c2);
                }

                // Chart 3: Stock vs Minimum Reorder Point
                var ctxStock = document.getElementById('chartStockBalances');
                if (ctxStock) {
                    var stockItems = (stockResult && (stockResult.items || stockResult.stock_items)) || [];
                    if (!stockItems.length) {
                        stockItems = [
                            { item_name: 'Cat6 Cable', quantity_on_hand: 5, reorder_level: 2 },
                            { item_name: 'Wireless Mouse', quantity_on_hand: 12, reorder_level: 5 },
                            { item_name: 'RJ45 Connectors', quantity_on_hand: 150, reorder_level: 50 },
                            { item_name: 'USB-C Adapters', quantity_on_hand: 8, reorder_level: 10 },
                            { item_name: 'Toner Cartridge', quantity_on_hand: 3, reorder_level: 4 }
                        ];
                    }
                    var slice = stockItems.slice(0, 8);
                    var labels = slice.map(function (it) {
                        var name = it.item_name || it.item_ref || 'Item';
                        return name.length > 18 ? name.substring(0, 16) + '...' : name;
                    });
                    var onHandData = slice.map(function (it) { return Number(it.quantity_on_hand || 0); });
                    var reorderData = slice.map(function (it) { return Number(it.reorder_level || 0); });

                    var c3 = new window.Chart(ctxStock, {
                        type: 'bar',
                        data: {
                            labels: labels,
                            datasets: [
                                {
                                    label: 'Quantity on Hand',
                                    data: onHandData,
                                    backgroundColor: '#0f2942',
                                    borderRadius: 4
                                },
                                {
                                    label: 'Reorder Level (Min)',
                                    data: reorderData,
                                    backgroundColor: '#ba1a1a',
                                    borderRadius: 4
                                }
                            ]
                        },
                        options: {
                            responsive: true,
                            maintainAspectRatio: false,
                            plugins: {
                                legend: {
                                    position: 'top',
                                    labels: { boxWidth: 12, padding: 12, font: { family: 'Segoe UI, sans-serif', size: 12 } }
                                }
                            },
                            scales: {
                                y: {
                                    beginAtZero: true,
                                    ticks: { precision: 0 },
                                    grid: { color: '#e2e8f0' }
                                },
                                x: { grid: { display: false } }
                            }
                        }
                    });
                    dashboardCharts.push(c3);
                }
            }

            document.getElementById('dashboardRefresh').addEventListener('click', renderDashboard);
            el.view.querySelectorAll('[data-dashboard-view]').forEach(function (button) {
                button.addEventListener('click', function () {
                    navigate(button.dataset.dashboardView);
                });
            });
        }).catch(function (error) {
            el.view.innerHTML = '<div class="card"><div class="card-body">Could not load the dashboard: ' + esc(error.message) + '</div></div>';
        });
    }

    function dashboardReminder(title, count, detail, view) {
        return '<button class="attention-item" data-dashboard-view="' + esc(view) + '">' +
            '<span class="attention-copy"><strong>' + esc(title) + '</strong><span>' + esc(detail) + '</span></span>' +
            '<span class="attention-count' + (count === null ? ' attention-count-error' : '') + '">' +
            (count === null ? '!' : esc(count)) + '</span></button>';
    }

    function renderLicences() {
        var stateForView = state.licences;
        el.view.innerHTML =
            '<div class="stat-grid" id="licenceStats"><div class="card"><div class="card-body">Loading licence statistics...</div></div></div>' +
            '<div class="toolbar"><div class="grow"><label class="field-label" for="licenceSearch">Search software and publisher</label>' +
            '<input id="licenceSearch" value="' + esc(stateForView.filters.search || '') + '" placeholder="Software, publisher, reference"></div>' +
            '<div><label class="field-label" for="licenceStatus">Status</label><select id="licenceStatus">' +
            ['', 'Active', 'Suspended', 'Expired', 'Retired'].map(function (status) {
                return '<option value="' + esc(status) + '"' +
                    (stateForView.filters.status === status ? ' selected' : '') + '>' +
                    (status || 'All statuses') + '</option>';
            }).join('') + '</select></div>' +
            '<button class="btn btn-secondary" id="licenceSearchBtn">Search</button>' +
            '<button class="btn btn-secondary" id="licenceExpiringBtn">Expiring soon</button>' +
            (can.write() ? '<button class="btn btn-primary" id="licenceNewBtn">+ Record licence</button>' : '') +
            '</div><div class="card"><div id="licenceTable"></div></div>';

        document.getElementById('licenceSearchBtn').addEventListener('click', function () {
            stateForView.filters.search = document.getElementById('licenceSearch').value.trim();
            stateForView.filters.status = document.getElementById('licenceStatus').value;
            loadLicences();
        });
        document.getElementById('licenceSearch').addEventListener('keydown', function (event) {
            if (event.key === 'Enter') document.getElementById('licenceSearchBtn').click();
        });
        document.getElementById('licenceExpiringBtn').addEventListener('click', loadExpiringLicences);
        var newButton = document.getElementById('licenceNewBtn');
        if (newButton) newButton.addEventListener('click', openLicenceForm);
        loadLicenceStats();
        loadLicences();
    }

    function loadLicenceStats() {
        var container = document.getElementById('licenceStats');
        if (!container) return;
        Api.licences.getStats().then(function (stats) {
            container.innerHTML =
                statTile('Licence products', stats.total || 0, null, 'info') +
                statTile('Active products', stats.active || 0, null, 'ok') +
                statTile('Purchased seats', stats.purchased || 0) +
                statTile('Allocated seats', stats.allocated || 0) +
                statTile('Expiring within 90 days', stats.expiring_soon || 0, null, 'warn');
        }).catch(function (error) {
            container.innerHTML = '<div class="empty">Could not load licence statistics: ' + esc(error.message) + '</div>';
        });
    }

    function licenceColumns() {
        return [
            { label: 'Reference', render: function (row) { return '<strong>' + esc(row.licence_ref) + '</strong>'; } },
            { label: 'Software', render: function (row) { return esc(row.software_name) + '<div class="muted">' + esc(row.publisher || '') + '</div>'; } },
            { label: 'Type', key: 'licence_type' },
            { label: 'Seats', render: function (row) { return esc(row.allocated_quantity) + ' / ' + esc(row.purchased_quantity) + '<div class="muted">' + esc(row.available_quantity) + ' available</div>'; } },
            { label: 'Expiry', className: 'nowrap', render: function (row) { return row.expiry_date ? esc(day(row.expiry_date)) : '<span class="muted">Never</span>'; } },
            { label: 'Status', render: function (row) { return badge(row.status); } },
            {
                label: 'Actions',
                className: 'actions',
                render: function (row) {
                    var actions = '<button class="btn btn-sm btn-secondary" data-licence-view="' + esc(row.id) + '">View</button>';
                    if (can.write() && row.status === 'Active') {
                        actions += ' <button class="btn btn-sm btn-primary" data-licence-allocate="' + esc(row.id) + '">Allocate</button>';
                    }
                    if (can.write()) {
                        actions += ' <button class="btn btn-sm btn-secondary" data-licence-edit="' + esc(row.id) + '">Edit</button>';
                    }
                    if (can.write() && row.status !== 'Retired') {
                        actions += ' <button class="btn btn-sm btn-secondary" data-licence-status="' + esc(row.id) + '" data-status="' +
                            (row.status === 'Suspended' ? 'Active' : 'Suspended') + '">' +
                            (row.status === 'Suspended' ? 'Reactivate' : 'Suspend') + '</button>' +
                            ' <button class="btn btn-sm btn-danger" data-licence-status="' + esc(row.id) +
                            '" data-status="Retired">Retire</button>';
                    }
                    return actions;
                }
            }
        ];
    }

    function loadLicences() {
        var container = document.getElementById('licenceTable');
        if (!container) return;
        container.innerHTML = '<div class="loading"><span class="spinner-dark"></span>Loading licences...</div>';
        Api.licences.list(Object.assign({ limit: 100 }, state.licences.filters)).then(function (data) {
            var rows = (data && data.items) || [];
            state.licences.rows = rows;
            container.innerHTML = table(rows, licenceColumns(), {
                empty: 'No software licences have been recorded.'
            });
            container.querySelectorAll('[data-licence-view]').forEach(function (button) {
                button.addEventListener('click', function () {
                    openLicenceDetail(button.getAttribute('data-licence-view'));
                });
            });
            container.querySelectorAll('[data-licence-allocate]').forEach(function (button) {
                button.addEventListener('click', function () {
                    openLicenceAllocation(button.getAttribute('data-licence-allocate'));
                });
            });
            container.querySelectorAll('[data-licence-edit]').forEach(function (button) {
                button.addEventListener('click', function () {
                    var record = rows.find(function (row) { return String(row.id) === button.getAttribute('data-licence-edit'); });
                    if (record) openLicenceForm(record);
                });
            });
            container.querySelectorAll('[data-licence-status]').forEach(function (button) {
                button.addEventListener('click', function () {
                    var id = button.getAttribute('data-licence-status');
                    var status = button.getAttribute('data-status');
                    if (status === 'Retired' && !window.confirm('Retire this licence? Its allocation history will be retained.')) return;
                    button.disabled = true;
                    Api.licences.setStatus(id, status).then(function () {
                        showAlert('Licence status updated.', 'success');
                        loadLicenceStats();
                        loadLicences();
                    }).catch(function (error) {
                        button.disabled = false;
                        showAlert(error.message || 'Could not update licence status.', 'error');
                    });
                });
            });
        }).catch(function (error) {
            container.innerHTML = '<div class="empty">Could not load licences: ' + esc(error.message) + '</div>';
        });
    }

    function loadExpiringLicences() {
        var container = document.getElementById('licenceTable');
        if (!container) return;
        container.innerHTML = '<div class="loading"><span class="spinner-dark"></span>Loading expiry alerts...</div>';
        Api.licences.getExpiring(90).then(function (data) {
            container.innerHTML = table(data.items || [], licenceColumns().slice(0, 6), {
                empty: 'No licences are due to expire within 90 days.'
            });
        }).catch(function (error) {
            container.innerHTML = '<div class="empty">Could not load expiry alerts: ' + esc(error.message) + '</div>';
        });
    }

    function openLicenceForm(record) {
        record = record || null;
        var formFields = [
            { name: 'software_name', label: 'Software / product name', required: true, value: record && record.software_name },
            { name: 'publisher', label: 'Publisher', value: record && record.publisher },
            { name: 'licence_type', label: 'Licence type', type: 'select', required: true, options: ['Per User', 'Per Device', 'Concurrent', 'Subscription', 'Perpetual', 'Other'], value: record ? record.licence_type : 'Per User' },
            { name: 'purchased_quantity', label: 'Purchased quantity', type: 'number', min: 1, required: true, value: record && record.purchased_quantity },
            { name: 'purchase_reference', label: 'Purchase reference', value: record && record.purchase_reference },
            { name: 'purchased_date', label: 'Purchase date', type: 'date', value: record && day(record.purchased_date) },
            { name: 'expiry_date', label: 'Expiry date', type: 'date', value: record && day(record.expiry_date) },
            { name: 'unit_cost', label: 'Unit cost', type: 'number', step: '0.01', min: 0, value: record ? record.unit_cost : 0 },
            { name: 'currency', label: 'Currency', value: record ? record.currency : 'USD' },
            { name: 'notes', label: 'Notes', type: 'textarea', full: true, value: record && record.notes }
        ];
        openForm({
            title: record ? 'Update software licence' : 'Record software licence',
            submitLabel: record ? 'Update licence' : 'Save licence',
            fields: formFields,
            onSubmit: function (form) {
                var action = record
                    ? Api.licences.update(record.id, form.values)
                    : Api.licences.create(form.values);
                return action.then(function () {
                    loadLicenceStats();
                    loadLicences();
                });
            }
        });
    }

    function openLicenceDetail(id) {
        Api.licences.get(id).then(function (record) {
            var fields = [
                ['Reference', record.licence_ref],
                ['Software', record.software_name],
                ['Publisher', record.publisher],
                ['Type', record.licence_type],
                ['Quantity', record.allocated_quantity + ' allocated / ' + record.purchased_quantity + ' purchased'],
                ['Available', record.available_quantity],
                ['Purchase reference', record.purchase_reference],
                ['Purchased', day(record.purchased_date)],
                ['Expires', record.expiry_date ? day(record.expiry_date) : 'Never'],
                ['Notes', record.notes]
            ];
            var html = '<div class="detail-grid">' + fields.map(function (field) {
                return '<div><div class="muted">' + esc(field[0]) + '</div><div>' + esc(field[1] || '—') + '</div></div>';
            }).join('') + '</div><h4>Allocation history</h4>' +
                table(record.allocations || [], [
                    { label: 'Assigned to', render: function (allocation) { return esc(allocation.full_name || allocation.asset_tag || '—'); } },
                    { label: 'Asset', key: 'asset_tag' },
                    { label: 'Quantity', key: 'quantity' },
                    { label: 'Status', render: function (allocation) { return badge(allocation.status); } },
                    { label: 'Allocated', render: function (allocation) { return esc(when(allocation.allocated_at)); } },
                    {
                        label: 'Actions',
                        className: 'actions',
                        render: function (allocation) {
                            return can.write() && allocation.status === 'Active'
                                ? '<button class="btn btn-sm btn-secondary" data-licence-release="' + esc(allocation.id) + '">Release</button>'
                                : '';
                        }
                    }
                ], { empty: 'No allocations recorded.' });
            openDetail('Licence ' + record.licence_ref, html, true);
            el.modalBody.querySelectorAll('[data-licence-release]').forEach(function (button) {
                button.addEventListener('click', function () {
                    Api.licences.release(id, button.getAttribute('data-licence-release')).then(function () {
                        showAlert('Licence allocation released.', 'success');
                        closeModal();
                        loadLicenceStats();
                        loadLicences();
                    }).catch(function (error) {
                        showAlert(error.message || 'Could not release allocation.', 'error');
                    });
                });
            });
        }).catch(function (error) {
            showAlert(error.message || 'Could not load licence details.', 'error');
        });
    }

    function openLicenceAllocation(id) {
        Promise.all([Api.assets.list({ limit: 200 }), Api.licences.getMeta()]).then(function (results) {
            var assets = (results[0] && results[0].assets) || [];
            var options = assets.map(function (asset) {
                return { value: asset.id, label: asset.asset_tag + ' — ' + [asset.manufacturer, asset.model].filter(Boolean).join(' ') };
            });
            openForm({
                title: 'Allocate software licence',
                submitLabel: 'Allocate',
                fields: [
                    { name: 'asset_id', label: 'Asset (optional if assigning to user)', type: 'select', options: [{ value: '', label: 'No asset selected' }].concat(options) },
                    { name: 'user_id', label: 'User ID (optional if assigning to asset)', type: 'number', min: 1 },
                    { name: 'quantity', label: 'Quantity', type: 'number', min: 1, required: true, value: 1 },
                    { name: 'notes', label: 'Notes', type: 'textarea', full: true }
                ],
                onSubmit: function (form) {
                    if (!form.values.asset_id) delete form.values.asset_id;
                    if (!form.values.user_id) delete form.values.user_id;
                    return Api.licences.allocate(id, form.values).then(function () {
                        loadLicenceStats();
                        loadLicences();
                    });
                }
            });
        }).catch(function (error) {
            showAlert(error.message || 'Could not load allocation options.', 'error');
        });
    }

    function renderProcurement() {
        if (!can.readAll()) {
            el.view.innerHTML = '<div class="empty">Procurement records are not available to this role.</div>';
            return;
        }
        el.view.innerHTML =
            '<div class="toolbar"><div class="grow"><h3>Procurement receiving</h3>' +
            '<div class="muted">Record incoming serialized assets and consumables against their register and store ledger.</div></div>' +
            (can.write() ? '<button class="btn btn-primary" id="procurementReceive">+ Receive goods</button>' : '') +
            '</div><div class="card"><div id="procurementTable"></div></div>';
        var receiveButton = document.getElementById('procurementReceive');
        if (receiveButton) receiveButton.addEventListener('click', openProcurementReceiveForm);
        loadProcurement();
    }

    function loadProcurement() {
        var container = document.getElementById('procurementTable');
        if (!container) return;
        var paging = state.procurement;
        container.innerHTML = '<div class="loading"><span class="spinner-dark"></span>Loading procurement receipts...</div>';
        Api.procurement.list({ page: paging.page, limit: paging.limit }).then(function (data) {
            var receipts = data.receipts || [];
            paging.total = Number(data.total) || 0;
            container.innerHTML = table(receipts, [
                { label: 'Receipt', render: function (row) { return '<strong>' + esc(row.receipt_reference || 'Receipt #' + row.id) + '</strong>'; } },
                { label: 'Supplier', render: function (row) { return orDash(row.supplier); } },
                { label: 'Purchase order', render: function (row) { return orDash(row.purchase_order); } },
                { label: 'Received', render: function (row) { return orDash(day(row.received_date)); } },
                { label: 'Lines', key: 'line_count' },
                { label: 'Total', render: function (row) { return money(row.total_cost || 0); } },
                {
                    label: 'Actions',
                    className: 'actions',
                    render: function (row) {
                        return '<button class="btn btn-sm btn-secondary" data-procurement-view="' +
                            esc(row.id) + '">View</button>';
                    }
                }
            ], {
                empty: 'No procurement receipts have been recorded.',
                total: paging.total,
                pager: { offset: (paging.page - 1) * paging.limit, limit: paging.limit }
            });
            paging.offset = (paging.page - 1) * paging.limit;
            bindPager(container, paging, function () {
                paging.page = Math.floor(paging.offset / paging.limit) + 1;
                loadProcurement();
            });
            container.querySelectorAll('[data-procurement-view]').forEach(function (button) {
                button.addEventListener('click', function () {
                    Api.procurement.get(button.dataset.procurementView).then(function (result) {
                        showProcurementReceipt(result.receipt);
                    }).catch(function (error) {
                        showAlert(error.message || 'Could not load the procurement receipt.', 'error');
                    });
                });
            });
        }).catch(function (error) {
            container.innerHTML = '<div class="empty">Could not load procurement receipts: ' + esc(error.message) + '</div>';
        });
    }

    function showProcurementReceipt(receipt) {
        var details = [
            ['Supplier', receipt.supplier],
            ['Purchase order', receipt.purchase_order],
            ['Received date', day(receipt.received_date)],
            ['Received by', receipt.received_by_name],
            ['Notes', receipt.notes]
        ];
        openDetail(
            receipt.receipt_reference || 'Procurement receipt #' + receipt.id,
            '<div class="detail-grid">' + details.map(function (field) {
                return '<div><div class="muted">' + esc(field[0]) + '</div><div>' +
                    esc(field[1] || '—') + '</div></div>';
            }).join('') + '</div><h4>Received lines</h4>' +
            table(receipt.lines || [], [
                { label: 'Type', key: 'line_type' },
                { label: 'Item', render: function (line) { return esc(line.item_name || line.asset_tag || ''); } },
                { label: 'Asset tag', render: function (line) { return orDash(line.asset_tag); } },
                { label: 'Quantity', key: 'quantity' },
                { label: 'Unit cost', render: function (line) { return money(line.unit_cost || 0); } },
                { label: 'Total', render: function (line) { return money(line.total_cost || 0); } }
            ], { empty: 'This receipt has no lines.' }),
            true
        );
    }

    function procurementFormField(index, name, label, type, options, required, value) {
        var id = 'proc_' + index + '_' + name;
        var markup = renderField({
            name: id,
            label: label,
            type: type || 'text',
            options: options || [],
            required: Boolean(required),
            value: value
        });
        return markup.replace(
            'name="' + id + '"',
            'name="' + esc(name) + '" data-proc-field="' + esc(name) + '"'
        );
    }

    function procurementLineMarkup(index, stockItems) {
        var stockOptions = [{ value: '', label: 'Create a new store card' }].concat(
            stockItems.filter(function (item) {
                return item.asset_id === null || item.asset_id === undefined;
            }).map(function (item) {
                return { value: item.id, label: (item.item_ref || '') + ' — ' + item.item_name };
            })
        );
        return '<section class="procurement-line" data-procurement-line>' +
            '<div class="procurement-line-heading"><strong>Receipt line ' + (index + 1) + '</strong>' +
            '<button class="btn btn-sm btn-danger" type="button" data-procurement-remove>Remove</button></div>' +
            '<div class="form-grid">' +
            procurementFormField(index, 'type', 'Item type', 'select', [
                { value: 'serialized', label: 'Serialized asset' },
                { value: 'consumable', label: 'Consumable / store item' }
            ], true, 'serialized') +
            '</div><div class="form-grid" data-procurement-asset-fields>' +
            procurementFormField(index, 'asset_tag', 'Asset tag', 'text', [], true) +
            procurementFormField(index, 'serial_number', 'Serial number') +
            procurementFormField(index, 'category_id', 'Asset category', 'select', categoryOptions()) +
            procurementFormField(index, 'manufacturer', 'Manufacturer') +
            procurementFormField(index, 'model', 'Model') +
            procurementFormField(index, 'location', 'Location / branch', 'select', referenceOptions('locations')) +
            procurementFormField(index, 'department', 'Department', 'select', referenceOptions('departments')) +
            procurementFormField(index, 'purchase_cost', 'Purchase cost', 'number', [], false, 0) +
            procurementFormField(index, 'warranty_provider', 'Warranty provider') +
            procurementFormField(index, 'warranty_start', 'Warranty start', 'date') +
            procurementFormField(index, 'warranty_end', 'Warranty end', 'date') +
            procurementFormField(index, 'warranty_ref', 'Warranty reference') +
            '</div><div class="form-grid" data-procurement-stock-fields hidden>' +
            procurementFormField(index, 'stock_item_id', 'Existing store card (optional)', 'select', stockOptions) +
            '<div data-procurement-new-stock>' +
            procurementFormField(index, 'item_name', 'New item name', 'text', [], true) +
            procurementFormField(index, 'part_code', 'Part / item code') +
            procurementFormField(index, 'category', 'Stock category') +
            procurementFormField(index, 'unit_of_measure', 'Unit of measure', 'text', [], false, 'Unit') +
            procurementFormField(index, 'store_location', 'Store location', 'select', storeLocationOptions()) +
            procurementFormField(index, 'bin_location', 'Bin / shelf') +
            procurementFormField(index, 'minimum_level', 'Minimum level', 'number') +
            '</div>' +
            procurementFormField(index, 'quantity', 'Quantity received', 'number', [], true, 1) +
            procurementFormField(index, 'unit_cost', 'Unit cost', 'number', [], false, 0) +
            procurementFormField(index, 'department', 'Department', 'select', referenceOptions('departments')) +
            '</div></section>';
    }

    function bindProcurementLine(row) {
        var typeInput = row.querySelector('[data-proc-field="type"]');
        var assetFields = row.querySelector('[data-procurement-asset-fields]');
        var stockFields = row.querySelector('[data-procurement-stock-fields]');
        var stockItem = row.querySelector('[data-proc-field="stock_item_id"]');
        var newStockFields = row.querySelector('[data-procurement-new-stock]');
        var itemName = row.querySelector('[data-proc-field="item_name"]');
        var assetTag = row.querySelector('[data-proc-field="asset_tag"]');
        var quantity = row.querySelector('[data-proc-field="quantity"]');

        function update() {
            var serialized = typeInput.value === 'serialized';
            assetFields.hidden = !serialized;
            stockFields.hidden = serialized;
            if (assetTag) assetTag.required = serialized;
            if (quantity) quantity.required = !serialized;
            if (itemName) itemName.required = !serialized && !stockItem.value;
            if (newStockFields) newStockFields.hidden = Boolean(stockItem.value);
        }

        typeInput.addEventListener('change', update);
        if (stockItem) stockItem.addEventListener('change', update);
        row.querySelector('[data-procurement-remove]').addEventListener('click', function () {
            var rows = document.querySelectorAll('[data-procurement-line]');
            if (rows.length > 1) row.remove();
        });
        update();
    }

    function openProcurementReceiveForm() {
        var receiveButton = document.getElementById('procurementReceive');
        if (receiveButton) receiveButton.disabled = true;
        Api.stock.list({ limit: 200, include_derived: false }).then(function (stockData) {
            if (state.view !== 'procurement') return;
            var stockItems = stockData.stock_items || [];
            var lineNumber = 0;
            var idempotencyKey = window.crypto && window.crypto.randomUUID
                ? window.crypto.randomUUID()
                : 'proc-' + Date.now() + '-' + Math.random().toString(36).slice(2);
            el.modalTitle.textContent = 'Receive procurement';
            el.modalPanel.className = 'modal modal-wide';
            el.modalSubmit.textContent = 'Record receipt';
            el.modalSubmit.disabled = false;
            el.modalSubmit.style.display = '';
            el.modalBody.innerHTML =
                '<div class="form-grid procurement-header">' +
                '<div class="field-wrap"><label class="field-label" for="procReceiptReference">Receipt reference</label>' +
                '<input id="procReceiptReference" maxlength="100" placeholder="Supplier delivery note or GRN"></div>' +
                '<div class="field-wrap"><label class="field-label" for="procSupplier">Supplier</label><input id="procSupplier" maxlength="150"></div>' +
                '<div class="field-wrap"><label class="field-label" for="procPurchaseOrder">Purchase order</label><input id="procPurchaseOrder" maxlength="100"></div>' +
                '<div class="field-wrap"><label class="field-label" for="procReceivedDate">Received date</label><input id="procReceivedDate" type="date" value="' + esc(today()) + '" required></div>' +
                '<div class="field-wrap full"><label class="field-label" for="procReceiptNotes">Notes</label><textarea id="procReceiptNotes" rows="2"></textarea></div>' +
                '</div><div class="procurement-lines-heading"><h4>Items received</h4>' +
                '<button type="button" class="btn btn-secondary btn-sm" id="procurementAddLine">+ Add line</button></div>' +
                '<div id="procurementLineRows"></div>';
            el.modal.hidden = false;

            var linesContainer = document.getElementById('procurementLineRows');
            function addLine() {
                var wrapper = document.createElement('div');
                wrapper.innerHTML = procurementLineMarkup(lineNumber++, stockItems);
                var row = wrapper.firstElementChild;
                linesContainer.appendChild(row);
                [
                    ['purchase_cost', '0', '0.01'],
                    ['quantity', '1', '1'],
                    ['unit_cost', '0', '0.01'],
                    ['minimum_level', '0', '1']
                ].forEach(function (setting) {
                    var input = row.querySelector('[data-proc-field="' + setting[0] + '"]');
                    if (input) {
                        input.min = setting[1];
                        input.step = setting[2];
                    }
                });
                bindProcurementLine(row);
            }
            addLine();
            document.getElementById('procurementAddLine').addEventListener('click', addLine);

            el.modalForm.onsubmit = function (event) {
                event.preventDefault();
                var rows = Array.from(linesContainer.querySelectorAll('[data-procurement-line]'));
                var lines = rows.map(function (row) {
                    var get = function (name) {
                        var input = row.querySelector('[data-proc-field="' + name + '"]');
                        return input ? input.value.trim() : '';
                    };
                    if (get('type') === 'serialized') {
                        var asset = {
                            asset_tag: get('asset_tag'),
                            serial_number: get('serial_number'),
                            category_id: get('category_id'),
                            manufacturer: get('manufacturer'),
                            model: get('model'),
                            location: get('location'),
                            department: get('department'),
                            purchase_cost: get('purchase_cost'),
                            warranty_provider: get('warranty_provider'),
                            warranty_start: get('warranty_start'),
                            warranty_end: get('warranty_end'),
                            warranty_ref: get('warranty_ref'),
                            purchase_date: document.getElementById('procReceivedDate').value
                        };
                        Object.keys(asset).forEach(function (key) {
                            if (asset[key] === '') delete asset[key];
                        });
                        return { type: 'serialized', asset: asset };
                    }
                    var line = {
                        type: 'consumable',
                        stock_item_id: get('stock_item_id'),
                        item_name: get('item_name'),
                        part_code: get('part_code'),
                        category: get('category'),
                        unit_of_measure: get('unit_of_measure'),
                        store_location: get('store_location'),
                        bin_location: get('bin_location'),
                        department: get('department'),
                        quantity: get('quantity'),
                        unit_cost: get('unit_cost'),
                        minimum_level: get('minimum_level')
                    };
                    Object.keys(line).forEach(function (key) {
                        if (line[key] === '') delete line[key];
                    });
                    return line;
                });
                var payload = {
                    receipt_reference: document.getElementById('procReceiptReference').value.trim(),
                    supplier: document.getElementById('procSupplier').value.trim(),
                    purchase_order: document.getElementById('procPurchaseOrder').value.trim(),
                    received_date: document.getElementById('procReceivedDate').value,
                    notes: document.getElementById('procReceiptNotes').value.trim(),
                    lines: lines
                };

                el.modalSubmit.disabled = true;
                el.modalSubmit.textContent = 'Recording...';
                Api.procurement.receive(payload, payload.receipt_reference ? null : idempotencyKey).then(function (result) {
                    closeModal();
                    state.procurement.page = 1;
                    state.procurement.offset = 0;
                    showAlert(result.idempotent_replay
                        ? 'This receipt had already been recorded; the existing receipt was loaded.'
                        : 'Procurement receipt recorded successfully.', 'success');
                    loadProcurement();
                    loadAssets();
                    loadStock();
                    loadStockStats();
                }).catch(function (error) {
                    el.modalSubmit.disabled = false;
                    el.modalSubmit.textContent = 'Record receipt';
                    var firstError = error.errors && error.errors.length ? error.errors[0].message : null;
                    showAlert(firstError || error.message || 'Could not record the receipt.', 'error');
                });
            };
        }).catch(function (error) {
            showAlert(error.message || 'Could not load stock items for receiving.', 'error');
        }).finally(function () {
            if (receiveButton) receiveButton.disabled = false;
        });
    }

    function renderDisposal() {
        el.view.innerHTML =
            '<div class="toolbar"><div class="grow"><h3>Asset retirement and disposal</h3>' +
            '<div class="muted">Disposal requires approval and preserves the asset history.</div></div>' +
            (can.write() ? '<button class="btn btn-primary" id="disposalNew">+ Request disposal</button>' : '') +
            '</div><div class="card"><div id="disposalTable"></div></div>';
        var newButton = document.getElementById('disposalNew');
        if (newButton) newButton.addEventListener('click', openDisposalForm);
        loadDisposals();
    }

    function loadDisposals() {
        var container = document.getElementById('disposalTable');
        if (!container) return;
        container.innerHTML = '<div class="loading"><span class="spinner-dark"></span>Loading disposal records...</div>';
        Api.disposal.list({ limit: 200 }).then(function (data) {
            var rows = (data && data.items) || [];
            state.disposal.rows = rows;
            container.innerHTML = table(rows, [
                { label: 'Reference', render: function (row) { return '<strong>' + esc(row.disposal_ref) + '</strong>'; } },
                { label: 'Asset', render: function (row) { return esc(row.asset_tag) + '<div class="muted">' + esc(row.asset_code) + '</div>'; } },
                { label: 'Reason', key: 'reason' },
                { label: 'Method', key: 'disposal_method' },
                { label: 'Requested by', key: 'requested_by_name' },
                { label: 'Approval', key: 'approved_by_name' },
                { label: 'Status', render: function (row) { return badge(row.status); } },
                {
                    label: 'Actions',
                    className: 'actions',
                    render: function (row) {
                        var actions = '<button class="btn btn-sm btn-secondary" data-disposal-view="' + esc(row.id) + '">View</button> ';
                        if (can.admin() && row.status === 'Pending Approval' &&
                            Number(row.requested_by) !== Number(state.user.id)) {
                            actions += '<button class="btn btn-sm btn-primary" data-disposal-approve="' + esc(row.id) + '">Approve</button> ';
                            actions += '<button class="btn btn-sm btn-danger" data-disposal-reject="' + esc(row.id) + '">Reject</button> ';
                        }
                        if (can.write() && row.status === 'Approved') {
                            actions += '<button class="btn btn-sm btn-primary" data-disposal-complete="' + esc(row.id) + '">Complete disposal</button>';
                        }
                        return actions;
                    }
                }
            ], { empty: 'No disposal requests have been recorded.' });

            container.querySelectorAll('[data-disposal-view]').forEach(function (button) {
                button.addEventListener('click', function () {
                    var record = rows.find(function (row) { return String(row.id) === button.getAttribute('data-disposal-view'); });
                    if (!record) return;
                    openDetail('Disposal ' + record.disposal_ref,
                        '<div class="detail-grid">' + [
                            ['Asset', record.asset_tag + ' (' + record.asset_code + ')'],
                            ['Status', record.status],
                            ['Reason', record.reason],
                            ['Method', record.disposal_method],
                            ['Requested disposal date', day(record.requested_disposal_date)],
                            ['Final condition', record.final_condition],
                            ['Approval reference', record.approval_reference],
                            ['Data destroyed', Number(record.data_destroyed) ? 'Yes' : 'No'],
                            ['Data destruction date', day(record.data_destroyed_at)],
                            ['Data destruction reference', record.data_destruction_reference],
                            ['Requested by', record.requested_by_name],
                            ['Approved by', record.approved_by_name],
                            ['Rejection reason', record.rejection_reason],
                            ['Notes', record.notes]
                        ].map(function (pair) {
                            return '<div><div class="muted">' + esc(pair[0]) + '</div><div>' + esc(pair[1] || '—') + '</div></div>';
                        }).join('') + '</div>', true);
                });
            });

            container.querySelectorAll('[data-disposal-approve]').forEach(function (button) {
                button.addEventListener('click', function () {
                    button.disabled = true;
                    Api.disposal.approve(button.getAttribute('data-disposal-approve')).then(function () {
                        showAlert('Disposal request approved.', 'success');
                        loadDisposals();
                    }).catch(function (error) {
                        button.disabled = false;
                        showAlert(error.message || 'Could not approve disposal request.', 'error');
                    });
                });
            });

            container.querySelectorAll('[data-disposal-reject]').forEach(function (button) {
                button.addEventListener('click', function () {
                    var id = button.getAttribute('data-disposal-reject');
                    openForm({
                        title: 'Reject disposal request',
                        submitLabel: 'Reject request',
                        fields: [{ name: 'reason', label: 'Reason for rejection', type: 'textarea', required: true, full: true }],
                        onSubmit: function (form) {
                            return Api.disposal.reject(id, form.values).then(function () { loadDisposals(); });
                        }
                    });
                });
            });

            container.querySelectorAll('[data-disposal-complete]').forEach(function (button) {
                button.addEventListener('click', function () {
                    if (!window.confirm('Complete this approved disposal and mark the asset as disposed?')) return;
                    button.disabled = true;
                    Api.disposal.complete(button.getAttribute('data-disposal-complete')).then(function () {
                        showAlert('Disposal completed. The asset remains in the register as Disposed.', 'success');
                        loadDisposals();
                    }).catch(function (error) {
                        button.disabled = false;
                        showAlert(error.message || 'Could not complete disposal.', 'error');
                    });
                });
            });
        }).catch(function (error) {
            container.innerHTML = '<div class="empty">Could not load disposal records: ' + esc(error.message) + '</div>';
        });
    }

    function openDisposalForm() {
        Promise.all([Api.disposal.getMeta(), Api.assets.list({ limit: 200 })]).then(function (results) {
            var meta = results[0] || {};
            var assets = (results[1] && results[1].assets) || [];
            var options = assets.filter(function (asset) {
                return !['Disposed', 'Retired', 'Under Repair'].includes(asset.status);
            }).map(function (asset) {
                return {
                    value: asset.id,
                    label: asset.asset_tag + ' — ' +
                        [asset.manufacturer, asset.model].filter(Boolean).join(' ') + ' (' + asset.status + ')'
                };
            });
            if (!options.length) {
                showAlert('There are no eligible assets to submit for disposal.', 'error');
                return;
            }
            openForm({
                title: 'Request asset disposal',
                submitLabel: 'Submit for approval',
                fields: [
                    { name: 'asset_id', label: 'Asset', type: 'select', required: true, options: options },
                    { name: 'reason', label: 'Reason for disposal', type: 'textarea', required: true, full: true },
                    { name: 'disposal_method', label: 'Disposal method', type: 'select', required: true, options: (meta.methods || []).map(function (value) { return { value: value, label: value }; }) },
                    { name: 'requested_disposal_date', label: 'Planned disposal date', type: 'date', required: true, value: today() },
                    { name: 'final_condition', label: 'Final condition', type: 'select', required: true, options: (meta.conditions || []).map(function (value) { return { value: value, label: value }; }) },
                    { name: 'approval_reference', label: 'Approval reference' },
                    { name: 'data_destroyed', label: 'Data destruction', type: 'checkbox', checkboxLabel: 'Organisational data has been securely destroyed' },
                    { name: 'data_destroyed_at', label: 'Data destruction date', type: 'date' },
                    { name: 'data_destruction_reference', label: 'Data destruction evidence reference' },
                    { name: 'notes', label: 'Notes', type: 'textarea', full: true }
                ],
                onSubmit: function (form) {
                    return Api.disposal.create(form.values).then(function () {
                        loadDisposals();
                    });
                }
            });
        }).catch(function (error) {
            showAlert(error.message || 'Could not load disposal options or assets.', 'error');
        });
    }

    function renderVerification() {
        var writable = can.write();
        state.verification.current = null;
        el.view.innerHTML =
            '<div class="toolbar"><div class="grow"><h3>Physical asset verification</h3>' +
            '<div class="muted">Create an exercise from the asset register, record each result, then review exceptions.</div></div>' +
            (writable ? '<button class="btn btn-primary" id="verificationNew">+ New exercise</button>' : '') +
            '</div><div class="card"><div id="verificationList"></div></div>';

        var newButton = document.getElementById('verificationNew');
        if (newButton) {
            newButton.addEventListener('click', openVerificationForm);
            Api.verification.getMeta().then(function (data) {
                meta.verification = data;
            }).catch(function (error) {
                showAlert(error.message || 'Could not load verification options.', 'error');
            });
        }
        loadVerificationList();
    }

    function openVerificationForm() {
        var openFormWithMeta = function (data) {
            meta.verification = data;
            openForm({
                title: 'Create verification exercise',
                submitLabel: 'Start verification',
                successMessage: 'Verification exercise created.',
                fields: [
                    { name: 'name', label: 'Exercise name', required: true, placeholder: 'e.g. Head Office annual stocktake' },
                    { name: 'department', label: 'Department', type: 'select', options: [''].concat(data.departments || []).map(function (value) { return { value: value, label: value || 'All departments' }; }) },
                    { name: 'location', label: 'Location', type: 'select', options: [''].concat(data.locations || []).map(function (value) { return { value: value, label: value || 'All locations' }; }) },
                    { name: 'category_id', label: 'Asset category', type: 'select', options: [{ value: '', label: 'All categories' }].concat((data.categories || []).map(function (category) { return { value: category.id, label: category.name }; })) },
                    { name: 'notes', label: 'Notes', type: 'textarea', full: true }
                ],
                onSubmit: function (form) {
                    return Api.verification.create(form.values).then(function () {
                        loadVerificationList();
                    });
                }
            });
        };

        if (meta.verification) {
            openFormWithMeta(meta.verification);
        } else {
            Api.verification.getMeta().then(openFormWithMeta).catch(function (error) {
                showAlert(error.message || 'Could not load verification options.', 'error');
            });
        }
    }

    function loadVerificationList() {
        var container = document.getElementById('verificationList');
        if (!container) return;
        container.innerHTML = '<div class="loading"><span class="spinner-dark"></span>Loading verification exercises...</div>';

        Api.verification.list({ limit: 100 }).then(function (data) {
            var rows = (data && data.items) || [];
            container.innerHTML = table(rows, [
                { label: 'Reference', render: function (row) { return '<strong>' + esc(row.verification_ref || '') + '</strong>'; } },
                { label: 'Exercise', key: 'name' },
                { label: 'Scope', render: function (row) { return esc([row.department, row.location].filter(Boolean).join(' / ') || 'All assets'); } },
                { label: 'Progress', render: function (row) { return Number(row.checked_assets || 0) + ' / ' + Number(row.total_assets || 0); } },
                { label: 'Exceptions', key: 'exceptions' },
                { label: 'Status', render: function (row) { return badge(row.status); } },
                {
                    label: 'Actions',
                    className: 'actions',
                    render: function (row) {
                        return '<button class="btn btn-sm btn-secondary" data-verification-open="' +
                            esc(row.id) + '">Open</button>';
                    }
                }
            ], { empty: 'No verification exercises yet. Create one to begin a stocktake.' });

            container.querySelectorAll('[data-verification-open]').forEach(function (button) {
                button.addEventListener('click', function () {
                    loadVerificationExercise(button.getAttribute('data-verification-open'), false);
                });
            });
        }).catch(function (error) {
            container.innerHTML = '<div class="empty">Could not load verification exercises: ' + esc(error.message) + '</div>';
        });
    }

    function loadVerificationExercise(id, exceptionsOnly) {
        state.verification.current = id;
        state.verification.exceptionsOnly = !!exceptionsOnly;
        var request = exceptionsOnly
            ? Api.verification.getExceptions(id).then(function (data) {
                return { verification: data.verification, items: data.items || [] };
            })
            : Api.verification.get(id).then(function (data) {
                return { verification: data, items: data.items || [] };
            });

        el.view.innerHTML = '<div class="loading"><span class="spinner-dark"></span>Loading exercise...</div>';
        request.then(function (data) {
            var exercise = data.verification;
            var items = data.items;
            var writer = can.write() && exercise.status === 'In Progress';
            var allAssetsChecked = Number(exercise.total_assets) > 0 &&
                Number(exercise.checked_assets) >= Number(exercise.total_assets);
            var html =
                '<div class="toolbar"><button class="btn btn-secondary" id="verificationBack">Back to exercises</button>' +
                '<div class="grow"><h3>' + esc(exercise.verification_ref) + ' — ' + esc(exercise.name) + '</h3>' +
                '<div class="muted">' + esc([exercise.department, exercise.location].filter(Boolean).join(' / ') || 'All assets') +
                ' · ' + Number(exercise.checked_assets || 0) + ' / ' + Number(exercise.total_assets || 0) + ' checked</div></div>' +
                '<button class="btn btn-secondary" id="verificationExceptions">' +
                (exceptionsOnly ? 'Show all assets' : 'Show exceptions') + '</button>' +
                (writer ? '<button class="btn btn-primary" id="verificationComplete"' +
                    (allAssetsChecked ? '' : ' disabled title="Record a result for every asset before completing."') +
                    '>Complete exercise</button>' : '') +
                '</div><div class="card"><div id="verificationItems"></div></div>';
            el.view.innerHTML = html;

            document.getElementById('verificationBack').addEventListener('click', renderVerification);
            document.getElementById('verificationExceptions').addEventListener('click', function () {
                loadVerificationExercise(id, !exceptionsOnly);
            });
            var completeButton = document.getElementById('verificationComplete');
            if (completeButton) {
                completeButton.addEventListener('click', function () {
                    completeButton.disabled = true;
                    Api.verification.complete(id).then(function () {
                        showAlert('Verification exercise completed.', 'success');
                        loadVerificationExercise(id, exceptionsOnly);
                    }).catch(function (error) {
                        completeButton.disabled = false;
                        showAlert(error.message || 'Could not complete the exercise.', 'error');
                    });
                });
            }

            var itemsContainer = document.getElementById('verificationItems');
            itemsContainer.innerHTML = table(items, [
                { label: 'Asset', render: function (item) { return '<strong>' + esc(item.asset_tag) + '</strong><div class="muted">' + esc(item.asset_code) + ' · ' + esc(item.serial_number || '') + '</div>'; } },
                { label: 'Description', render: function (item) { return esc([item.manufacturer, item.model].filter(Boolean).join(' ')); } },
                { label: 'Expected location', key: 'expected_location' },
                { label: 'Result', render: function (item) { return badge(item.result); } },
                { label: 'Actual location', render: function (item) { return esc(item.actual_location || ''); } },
                { label: 'Notes', key: 'notes' },
                {
                    label: 'Actions',
                    className: 'actions',
                    render: function (item) {
                        if (!writer) return '';
                        return '<select data-verification-result="' + esc(item.id) + '">' +
                            ['Verified', 'Missing', 'Damaged', 'Incorrect Location'].map(function (result) {
                                return '<option value="' + result + '"' + (item.result === result ? ' selected' : '') + '>' + result + '</option>';
                            }).join('') + '</select>' +
                            '<select data-verification-location="' + esc(item.id) + '">' +
                            referenceOptions('locations', item.actual_location || item.expected_location)
                                .map(function (option) {
                                    return '<option value="' + esc(option.value) + '"' +
                                        (option.value === (item.actual_location || item.expected_location || '') ? ' selected' : '') +
                                        '>' + esc(option.label) + '</option>';
                                }).join('') + '</select>' +
                            '<input data-verification-notes="' + esc(item.id) + '" value="' + esc(item.notes || '') +
                            '" placeholder="Notes">' +
                            '<button class="btn btn-sm btn-primary" data-verification-save="' + esc(item.id) + '">Save</button>';
                    }
                }
            ], { empty: exceptionsOnly ? 'No exceptions recorded.' : 'This exercise has no assets.' });

            itemsContainer.querySelectorAll('[data-verification-save]').forEach(function (button) {
                button.addEventListener('click', function () {
                    var itemId = button.getAttribute('data-verification-save');
                    var resultInput = itemsContainer.querySelector('[data-verification-result="' + itemId + '"]');
                    var locationInput = itemsContainer.querySelector('[data-verification-location="' + itemId + '"]');
                    var notesInput = itemsContainer.querySelector('[data-verification-notes="' + itemId + '"]');
                    button.disabled = true;
                    Api.verification.updateItem(id, itemId, {
                        result: resultInput.value,
                        actual_location: locationInput.value,
                        notes: notesInput.value
                    }).then(function () {
                        showAlert('Verification result saved.', 'success');
                        loadVerificationExercise(id, exceptionsOnly);
                    }).catch(function (error) {
                        button.disabled = false;
                        showAlert(error.message || 'Could not save verification result.', 'error');
                    });
                });
            });
        }).catch(function (error) {
            el.view.innerHTML = '<div class="card"><div class="card-body">Could not load this exercise: ' + esc(error.message) + '</div></div>';
        });
    }

    function renderBarcode() {
        stopBarcodeCamera();
        var reader = can.readAll();
        var writer = can.write();
        var s = state.barcode;

        el.view.innerHTML =
            '<div class="card"><div class="card-head"><h3>Scan an asset label</h3></div>' +
            '<div class="card-body"><form id="barcodeScanForm" class="toolbar">' +
            '<div class="grow"><label class="field-label" for="barcodeScanCode">QR or barcode value</label>' +
            '<input id="barcodeScanCode" name="code" required autocomplete="off" placeholder="Scan or enter the code"></div>' +
            '<div><label class="field-label" for="barcodeScanPurpose">Purpose</label>' +
            '<select id="barcodeScanPurpose"><option>Identification</option><option>Verification</option><option>Stocktake</option><option>Audit</option></select></div>' +
            '<button class="btn btn-primary" type="submit">Scan</button>' +
            ('BarcodeDetector' in window && navigator.mediaDevices && navigator.mediaDevices.getUserMedia
                ? '<button class="btn btn-secondary" type="button" id="barcodeCameraToggle">Use camera</button>'
                : '') +
            '</form><div id="barcodeCameraPanel" class="barcode-camera" hidden>' +
            '<video id="barcodeCameraVideo" playsinline muted></video>' +
            '<button class="btn btn-secondary" type="button" id="barcodeCameraStop">Stop camera</button>' +
            '<div id="barcodeCameraStatus" class="muted" role="status" aria-live="polite"></div></div>' +
            '<div id="barcodeScanResult" aria-live="polite"></div></div></div>' +
            (reader
                ? '<div class="stat-grid" id="barcodeStats"><div class="card"><div class="card-body">Loading barcode statistics...</div></div></div>' +
                    '<div class="toolbar">' +
                    '<div class="grow"><label class="field-label" for="barcodeSearch">Search labels</label>' +
                    '<input id="barcodeSearch" value="' + esc(s.filters.search || '') + '" placeholder="Code, reference, tag or serial"></div>' +
                    '<div><label class="field-label" for="barcodeStatus">Status</label><select id="barcodeStatus">' +
                    ['', 'Active', 'Damaged', 'Lost', 'Retired', 'Replaced'].map(function (v) {
                        return '<option value="' + esc(v) + '"' + (s.filters.label_status === v ? ' selected' : '') + '>' +
                            (v || 'All statuses') + '</option>';
                    }).join('') + '</select></div>' +
                    '<button class="btn btn-secondary" id="barcodeSearchBtn">Search</button></div>' +
                    '<div class="card"><div class="card-head"><h3>Barcode label register</h3></div><div id="barcodeLabels"></div></div>' +
                    '<div class="card"><div class="card-head"><h3>Assets without active labels</h3></div><div id="barcodeCoverage"></div></div>'
                : '<div class="card"><div class="card-body">You can scan asset labels here. Barcode register and coverage access is available to ICT Officers, HISO, System Administrators, and Auditors.</div></div>');

        document.getElementById('barcodeScanForm').addEventListener('submit', function (event) {
            event.preventDefault();
            var code = document.getElementById('barcodeScanCode').value.trim();
            var purpose = document.getElementById('barcodeScanPurpose').value;
            var result = document.getElementById('barcodeScanResult');
            result.innerHTML = '<div class="loading"><span class="spinner-dark"></span>Scanning...</div>';

            Api.barcode.scan({ code: code, scan_purpose: purpose }).then(function (data) {
                var asset = data && data.asset;
                result.innerHTML = asset
                    ? '<div class="alert visible alert-success">' +
                        esc(data.scan_result || 'Matched') + ': ' + esc(asset.asset_tag || asset.asset_id || '') +
                        ' — ' + esc([asset.manufacturer, asset.model].filter(Boolean).join(' ')) +
                        ' — ' + esc(asset.location || '') + '</div>'
                    : '<div class="alert visible alert-info">' + esc(data && data.message || 'Scan completed.') + '</div>';
                if (reader) loadBarcodeData();
            }).catch(function (error) {
                result.innerHTML = '<div class="alert visible alert-error">' + esc(error.message || 'Could not scan this code.') + '</div>';
            });
        });

        var cameraToggle = document.getElementById('barcodeCameraToggle');
        if (cameraToggle) {
            cameraToggle.addEventListener('click', startBarcodeCamera);
            document.getElementById('barcodeCameraStop').addEventListener('click', stopBarcodeCamera);
        }

        if (!reader) return;

        document.getElementById('barcodeSearchBtn').addEventListener('click', function () {
            s.filters.search = document.getElementById('barcodeSearch').value.trim();
            s.filters.label_status = document.getElementById('barcodeStatus').value;
            s.page = 1;
            loadBarcodeData();
        });

        document.getElementById('barcodeSearch').addEventListener('keydown', function (event) {
            if (event.key === 'Enter') document.getElementById('barcodeSearchBtn').click();
        });

        loadBarcodeData();
    }

    async function startBarcodeCamera() {
        var panel = document.getElementById('barcodeCameraPanel');
        var video = document.getElementById('barcodeCameraVideo');
        var status = document.getElementById('barcodeCameraStatus');
        var toggle = document.getElementById('barcodeCameraToggle');
        if (!panel || !video || !status || !toggle) return;
        if (barcodeCamera.stream) return;

        toggle.disabled = true;
        status.textContent = 'Requesting camera access...';
        try {
            barcodeCamera.stream = await navigator.mediaDevices.getUserMedia({
                audio: false,
                video: { facingMode: { ideal: 'environment' } }
            });
            barcodeCamera.stream.getTracks().forEach(function (track) {
                track.addEventListener('ended', stopBarcodeCamera, { once: true });
            });
            barcodeCamera.detector = new window.BarcodeDetector();
            barcodeCamera.busy = false;
            video.srcObject = barcodeCamera.stream;
            panel.hidden = false;
            await video.play();
            status.textContent = 'Point the camera at an asset QR code or barcode.';
            detectBarcodeFromCamera();
        } catch (error) {
            stopBarcodeCamera();
            status.textContent = error.name === 'NotAllowedError'
                ? 'Camera permission was denied. Allow camera access or enter the code manually.'
                : 'Could not start the camera: ' + (error.message || 'camera unavailable');
            panel.hidden = false;
        } finally {
            toggle.disabled = Boolean(barcodeCamera.stream);
            if (barcodeCamera.stream) toggle.textContent = 'Camera active';
        }
    }

    function detectBarcodeFromCamera() {
        var video = document.getElementById('barcodeCameraVideo');
        if (!barcodeCamera.stream || !barcodeCamera.detector || !video) return;

        barcodeCamera.timer = window.setTimeout(async function () {
            if (!barcodeCamera.stream || barcodeCamera.busy || video.readyState < 2) {
                detectBarcodeFromCamera();
                return;
            }

            barcodeCamera.busy = true;
            try {
                var detections = await barcodeCamera.detector.detect(video);
                if (detections.length && detections[0].rawValue) {
                    document.getElementById('barcodeScanCode').value = detections[0].rawValue;
                    stopBarcodeCamera();
                    document.getElementById('barcodeScanForm').requestSubmit();
                    return;
                }
            } catch (error) {
                var status = document.getElementById('barcodeCameraStatus');
                if (status) status.textContent = 'Could not read the label. Hold it steady and try again.';
            } finally {
                barcodeCamera.busy = false;
            }

            detectBarcodeFromCamera();
        }, 250);
    }

    function stopBarcodeCamera() {
        if (barcodeCamera.timer !== null) {
            window.clearTimeout(barcodeCamera.timer);
            barcodeCamera.timer = null;
        }
        if (barcodeCamera.stream) {
            barcodeCamera.stream.getTracks().forEach(function (track) { track.stop(); });
            barcodeCamera.stream = null;
        }
        barcodeCamera.detector = null;
        barcodeCamera.busy = false;
        var video = document.getElementById('barcodeCameraVideo');
        if (video) video.srcObject = null;
        var panel = document.getElementById('barcodeCameraPanel');
        if (panel) panel.hidden = true;
        var toggle = document.getElementById('barcodeCameraToggle');
        if (toggle) {
            toggle.textContent = 'Use camera';
            toggle.disabled = false;
        }
    }

    function loadBarcodeData() {
        var writer = can.write();
        var s = state.barcode;
        var stats = document.getElementById('barcodeStats');
        var labels = document.getElementById('barcodeLabels');
        var coverage = document.getElementById('barcodeCoverage');
        if (!stats || !labels || !coverage) return;

        labels.innerHTML = '<div class="loading"><span class="spinner-dark"></span>Loading labels...</div>';
        coverage.innerHTML = '<div class="loading"><span class="spinner-dark"></span>Loading coverage...</div>';

        Promise.all([
            Api.barcode.getStats(),
            Api.barcode.list(Object.assign({}, s.filters, { page: s.page, limit: s.limit })),
            Api.barcode.getCoverage({ limit: 100 })
        ]).then(function (results) {
            var summary = results[0] || {};
            var labelData = results[1] || {};
            var coverageData = results[2] || {};
            var labelRows = labelData.items || [];
            var coverageRows = coverageData.items || [];
            var pagination = labelData.pagination || { total: 0, page: s.page, limit: s.limit, total_pages: 1 };

            stats.innerHTML =
                statTile('Assets with codes', (summary.assets && summary.assets.with_code) || 0,
                    ((summary.assets && summary.assets.coverage_percent) || 0) + '% coverage', 'info') +
                statTile('Active labels', (summary.labels && summary.labels.active) || 0, null, 'ok') +
                statTile('Damaged or lost', ((summary.labels && summary.labels.damaged) || 0) +
                    ((summary.labels && summary.labels.lost) || 0), null, 'warn') +
                statTile('Scans today', (summary.scans && summary.scans.today) || 0);

            labels.innerHTML = table(labelRows, [
                { label: 'Reference', render: function (r) { return '<strong>' + esc(r.label_ref || '') + '</strong>'; } },
                { label: 'Code', render: function (r) { return '<code>' + esc(r.code_value || '') + '</code>'; } },
                { label: 'Asset', render: function (r) { return esc(r.asset_tag || '') + '<div class="muted">' + esc(r.asset_code || '') + '</div>'; } },
                { label: 'Type', key: 'code_type' },
                { label: 'Status', render: function (r) { return badge(r.label_status); } },
                { label: 'Prints', key: 'print_count' },
                {
                    label: 'Actions',
                    className: 'actions',
                    render: function (r) {
                        var actions = '<button class="btn btn-sm btn-secondary" data-barcode-view="' +
                            esc(r.id) + '">View</button>';
                        if (writer && r.label_status === 'Active') {
                            actions += '<button class="btn btn-sm btn-primary" data-barcode-print="' +
                                esc(r.asset_id) + '">Print</button>';
                        }
                        return actions;
                    }
                }
            ], {
                empty: 'No barcode labels found.',
                total: pagination.total,
                pager: { offset: (pagination.page - 1) * pagination.limit, limit: pagination.limit }
            });

            var labelPager = {
                offset: (pagination.page - 1) * pagination.limit,
                limit: pagination.limit,
                total: pagination.total
            };
            bindPager(labels, labelPager, function () {
                s.page = Math.floor(labelPager.offset / s.limit) + 1;
                loadBarcodeData();
            });

            labels.querySelectorAll('[data-barcode-print]').forEach(function (button) {
                button.addEventListener('click', function () {
                    Api.barcode.printLabel(button.getAttribute('data-barcode-print')).then(function () {
                        showAlert('Label print recorded.', 'success');
                        loadBarcodeData();
                    }).catch(function (error) {
                        showAlert(error.message || 'Could not record label print.', 'error');
                    });
                });
            });

            labels.querySelectorAll('[data-barcode-view]').forEach(function (button) {
                button.addEventListener('click', function () {
                    var record = labelRows.find(function (row) {
                        return String(row.id) === button.getAttribute('data-barcode-view');
                    });
                    if (!record) return;
                    openDetail(
                        'Barcode label: ' + (record.label_ref || ''),
                        details([
                            { label: 'Reference', value: record.label_ref },
                            { label: 'Code', value: record.code_value },
                            { label: 'Asset', value: (record.asset_tag || '') + ' (' + (record.asset_code || '') + ')' },
                            { label: 'Type', value: record.code_type },
                            { label: 'Status', html: badge(record.label_status) },
                            { label: 'Print count', value: record.print_count },
                            { label: 'Last printed', value: record.last_printed_at ? when(record.last_printed_at) : 'Never' }
                        ]),
                        false
                    );
                });
            });

            coverage.innerHTML = table(coverageRows, [
                { label: 'Asset', render: function (r) { return '<strong>' + esc(r.asset_tag || '') + '</strong><div class="muted">' + esc(r.asset_id || '') + '</div>'; } },
                { label: 'Description', render: function (r) { return esc([r.manufacturer, r.model].filter(Boolean).join(' ')); } },
                { label: 'Department', key: 'department' },
                { label: 'Location', key: 'location' },
                { label: 'Status', render: function (r) { return badge(r.status); } },
                {
                    label: 'Actions',
                    className: 'actions',
                    render: function (r) {
                        var actions = '<button class="btn btn-sm btn-secondary" data-barcode-asset-view="' +
                            esc(r.id) + '">View asset</button>';
                        if (writer) {
                            actions += '<button class="btn btn-sm btn-primary" data-barcode-generate="' +
                                esc(r.id) + '">Issue label</button>';
                        }
                        return actions;
                    }
                }
            ], { empty: 'All active assets have barcode labels.' });

            coverage.querySelectorAll('[data-barcode-asset-view]').forEach(function (button) {
                button.addEventListener('click', function () {
                    var record = coverageRows.find(function (row) {
                        return String(row.id) === button.getAttribute('data-barcode-asset-view');
                    });
                    if (record) openAssetDetail(record);
                });
            });

            coverage.querySelectorAll('[data-barcode-generate]').forEach(function (button) {
                button.addEventListener('click', function () {
                    button.disabled = true;
                    Api.barcode.generateAssetCode(button.getAttribute('data-barcode-generate')).then(function () {
                        showAlert('Barcode label issued.', 'success');
                        loadBarcodeData();
                    }).catch(function (error) {
                        button.disabled = false;
                        showAlert(error.message || 'Could not issue barcode label.', 'error');
                    });
                });
            });
        }).catch(function (error) {
            stats.innerHTML = '';
            labels.innerHTML = '<div class="empty">Could not load barcode labels: ' + esc(error.message) + '</div>';
            coverage.innerHTML = '<div class="empty">Could not load barcode coverage: ' + esc(error.message) + '</div>';
        });
    }


    /* ======================================================================
     * Asset register view (§5.2)
     * ==================================================================== */

    function categoryOptions() {
        return meta.assetCategories.map(function (c) {
            return { value: c.id, label: c.name };
        });
    }

    function renderAssets() {
        var s = state.assets;

        el.view.innerHTML =
            '<div class="toolbar">' +
            '<div class="grow"><label class="field-label" for="assetSearch">Search</label>' +
            '<input type="text" id="assetSearch" placeholder="Tag, serial, make, model, location..." value="' + esc(s.filters.search || '') + '"></div>' +
            '<div><label class="field-label" for="assetStatus">Status</label>' +
            '<select id="assetStatus" style="min-width:150px;">' +
            ['', 'In Use', 'In Stock', 'Under Repair', 'Missing', 'Retired', 'Disposed']
                .map(function (v) {
                    return '<option value="' + esc(v) + '"' + (s.filters.status === v ? ' selected' : '') + '>' + (v || 'All statuses') + '</option>';
                })
                .join('') +
            '</select></div>' +
            '<div><label class="field-label" for="assetCondition">Condition</label>' +
            '<select id="assetCondition" style="min-width:150px;">' +
            ['', 'Good', 'Fair', 'Damaged', 'Obsolete']
                .map(function (v) {
                    return '<option value="' + esc(v) + '"' + (s.filters.condition_status === v ? ' selected' : '') + '>' + (v || 'All conditions') + '</option>';
                })
                .join('') +
            '</select></div>' +
            '<button class="btn btn-secondary" id="assetSearchBtn">Search</button>' +
            (can.write() ? '<button class="btn btn-secondary" id="assetImportBtn">Import CSV</button>' : '') +
            (can.write() ? '<button class="btn btn-primary" id="assetNewBtn">+ Register asset</button>' : '') +
            '</div>' +
            (can.write()
                ? '<div class="card" id="assetImportPanel" hidden><div class="card-head"><h3>Import assets from CSV</h3>' +
                    '<div class="spacer"></div><button class="btn btn-secondary" id="assetCsvTemplate">Download template</button>' +
                    '</div><div class="card-body"><p class="muted">Import up to 1,000 rows per file (maximum 2 MB). ' +
                    'Each row is validated and audited; rejected rows are listed in the migration report.</p>' +
                    '<div class="toolbar"><div class="grow"><label class="field-label" for="assetCsvFile">CSV file</label>' +
                    '<input id="assetCsvFile" type="file" accept=".csv,text/csv"></div>' +
                    '<button class="btn btn-primary" id="assetCsvImport" disabled>Import assets</button></div>' +
                    '<div id="assetImportResult"></div></div></div>'
                : '') +
            '<div class="card"><div id="assetTable"></div></div>';

        document.getElementById('assetSearchBtn').addEventListener('click', function () {
            s.filters.search = document.getElementById('assetSearch').value.trim();
            s.filters.status = document.getElementById('assetStatus').value;
            s.filters.condition_status = document.getElementById('assetCondition').value;
            s.offset = 0;
            loadAssets();
        });

        document.getElementById('assetSearch').addEventListener('keydown', function (e) {
            if (e.key === 'Enter') document.getElementById('assetSearchBtn').click();
        });

        var newBtn = document.getElementById('assetNewBtn');
        if (newBtn) newBtn.addEventListener('click', openAssetForm);
        var importButton = document.getElementById('assetImportBtn');
        if (importButton) {
            importButton.addEventListener('click', function () {
                var panel = document.getElementById('assetImportPanel');
                panel.hidden = !panel.hidden;
            });
            document.getElementById('assetCsvTemplate').addEventListener('click', downloadAssetCsvTemplate);
            document.getElementById('assetCsvFile').addEventListener('change', function (event) {
                document.getElementById('assetCsvImport').disabled = !event.target.files.length;
                document.getElementById('assetImportResult').innerHTML = '';
            });
            document.getElementById('assetCsvImport').addEventListener('click', importAssetCsv);
        }

        loadAssets();
    }

    function downloadAssetCsvTemplate() {
        var headers = [
            'asset_id', 'asset_tag', 'serial_number', 'category_name', 'manufacturer', 'model',
            'purchase_date', 'purchase_cost', 'supplier', 'po_invoice_ref', 'warranty_provider',
            'warranty_start', 'warranty_end', 'warranty_ref', 'location', 'department',
            'assigned_user_id', 'responsible_officer', 'status', 'condition_status',
            'last_inspection_date'
        ];
        var blob = new Blob(['\uFEFF' + headers.join(',') + '\r\n'], {
            type: 'text/csv;charset=utf-8'
        });
        var url = URL.createObjectURL(blob);
        var link = document.createElement('a');
        link.href = url;
        link.download = 'asset-import-template.csv';
        link.click();
        window.setTimeout(function () {
            URL.revokeObjectURL(url);
        }, 1000);
    }

    function importAssetCsv() {
        var fileInput = document.getElementById('assetCsvFile');
        var result = document.getElementById('assetImportResult');
        var button = document.getElementById('assetCsvImport');
        var file = fileInput.files[0];
        if (!file) return;
        if (file.size > 2 * 1024 * 1024) {
            showAlert('The CSV file must be 2 MB or smaller.', 'error');
            return;
        }

        button.disabled = true;
        button.textContent = 'Importing...';
        file.text().then(function (csv) {
            return Api.assets.importCsv(csv);
        }).then(function (report) {
            var rows = report.rows || [];
            result.innerHTML =
                '<div class="stat-grid">' +
                statTile('Rows processed', report.total || 0) +
                statTile('Imported', report.imported || 0, null, 'ok') +
                statTile('Rejected', report.rejected || 0, null, report.rejected ? 'warn' : '') +
                '</div><div class="table-wrap"><table class="data"><thead><tr>' +
                '<th>CSV row</th><th>Result</th><th>Asset</th><th>Details</th></tr></thead><tbody>' +
                rows.map(function (row) {
                    return '<tr><td>' + esc(row.row) + '</td><td>' + esc(row.status) + '</td><td>' +
                        esc(row.asset_tag || row.asset_id || '') + '</td><td>' +
                        esc((row.errors || []).join('; ')) + '</td></tr>';
                }).join('') + '</tbody></table></div>';
            showAlert('Import finished: ' + (report.imported || 0) + ' imported, ' +
                (report.rejected || 0) + ' rejected.', report.rejected ? 'info' : 'success');
            state.assets.offset = 0;
            loadAssets();
        }).catch(function (error) {
            result.innerHTML = '<div class="empty">Import failed: ' + esc(error.message) + '</div>';
            showAlert(error.message || 'The CSV import failed.', 'error');
        }).finally(function () {
            button.disabled = false;
            button.textContent = 'Import assets';
        });
    }


    function loadAssets() {
        var s = state.assets;
        var container = document.getElementById('assetTable');
        if (!container) return;

        container.innerHTML = '<div class="loading"><span class="spinner-dark"></span>Loading assets...</div>';

        var filters = Object.assign({}, s.filters, { limit: s.limit, offset: s.offset });

        Api.assets.list(filters).then(
            function (data) {
                s.rows = (data && data.assets) || [];
                s.total = (data && data.total) || 0;

                container.innerHTML = table(
                    s.rows,
                    [
                        {
                            label: 'Asset',
                            render: function (r) {
                                return '<strong>' + esc(r.asset_tag) + '</strong><div class="muted" style="font-size:12px;">' + esc(r.asset_id) + '</div>';
                            }
                        },
                        {
                            label: 'Description',
                            render: function (r) {
                                return orDash([r.manufacturer, r.model].filter(Boolean).join(' ')) +
                                    '<div class="muted" style="font-size:12px;">' + orDash(r.category_name) + '</div>';
                            }
                        },
                        { label: 'Serial', render: function (r) { return orDash(r.serial_number); } },
                        { label: 'Location', render: function (r) { return orDash(r.location); } },
                        { label: 'Department', render: function (r) { return orDash(r.department); } },
                        { label: 'Status', render: function (r) { return badge(r.status); } },
                        { label: 'Condition', render: function (r) { return badge(r.condition_status); } },
                        {
                            label: 'Actions',
                            className: 'actions',
                            render: function (r) {
                                var html = '<button class="btn btn-sm btn-secondary" data-asset-view="' +
                                    esc(r.id) + '">View</button>';
                                if (can.write()) {
                                    html += '<button class="btn btn-sm btn-primary" data-asset-edit="' +
                                        esc(r.id) + '">Edit details</button>';
                                }
                                return html;
                            }
                        }
                    ],
                    {
                        empty: 'No assets matched. ' + (can.write() ? 'Register one to get started.' : ''),
                        total: s.total,
                        pager: { offset: s.offset, limit: s.limit }
                    }
                );

                bindPager(container, s, loadAssets);

                Array.prototype.forEach.call(container.querySelectorAll('[data-asset-view]'), function (btn) {
                    btn.addEventListener('click', function () {
                        var id = btn.getAttribute('data-asset-view');
                        var row = s.rows.filter(function (r) { return String(r.id) === String(id); })[0];
                        if (row) openAssetDetail(row);
                    });
                });

                Array.prototype.forEach.call(container.querySelectorAll('[data-asset-edit]'), function (btn) {
                    btn.addEventListener('click', function () {
                        var id = btn.getAttribute('data-asset-edit');
                        var row = s.rows.find(function (item) { return String(item.id) === String(id); });
                        if (row) openAssetEditForm(row);
                    });
                });
            },
            function (error) {
                container.innerHTML = '<div class="empty">Could not load assets: ' + esc(error.message) + '</div>';
            }
        );
    }

    function openAssetForm() {
        openForm({
            title: 'Register a new asset',
            submitLabel: 'Register asset',
            successMessage: 'Asset registered successfully.',
            fields: [
                { name: 'asset_tag', label: 'Asset tag', required: true, placeholder: 'e.g. NBSZ-LT-0099' },
                { name: 'serial_number', label: 'Serial number', placeholder: 'Manufacturer serial' },
                { name: 'category_id', label: 'Category', type: 'select', options: categoryOptions() },
                { name: 'manufacturer', label: 'Manufacturer', placeholder: 'e.g. Dell' },
                { name: 'model', label: 'Model', placeholder: 'e.g. Latitude 5540' },
                { name: 'location', label: 'Location / branch', type: 'select', options: referenceOptions('locations') },
                { name: 'department', label: 'Department', type: 'select', options: referenceOptions('departments') },
                { name: 'status', label: 'Status', type: 'select', options: ['In Stock', 'In Use', 'Under Repair', 'Missing', 'Retired', 'Disposed'], value: 'In Stock' },
                { name: 'condition_status', label: 'Condition', type: 'select', options: ['Good', 'Fair', 'Damaged', 'Obsolete'], value: 'Good' },
                { name: 'supplier', label: 'Supplier' },
                { name: 'po_invoice_ref', label: 'PO / invoice reference' },
                { name: 'purchase_date', label: 'Purchase date', type: 'date' },
                { name: 'purchase_cost', label: 'Purchase cost', type: 'number', step: '0.01', min: 0 },
                { name: 'warranty_provider', label: 'Warranty provider' },
                { name: 'warranty_start', label: 'Warranty start', type: 'date' },
                { name: 'warranty_end', label: 'Warranty end', type: 'date' },
                { name: 'warranty_ref', label: 'Warranty reference' },
                { name: 'responsible_officer', label: 'Responsible officer' }
            ],
            onSubmit: function (payload) {
                var body = compact(payload.values);
                return Api.assets.create(body).then(function () {
                    loadAssets();
                });
            }
        });
    }

    function openAssetEditForm(asset) {
        openForm({
            title: 'Edit asset details',
            submitLabel: 'Save changes',
            successMessage: 'Asset details updated.',
            fields: [
                { name: 'asset_tag', label: 'Asset tag', required: true, value: asset.asset_tag },
                { name: 'serial_number', label: 'Serial number', value: asset.serial_number },
                { name: 'category_id', label: 'Category', type: 'select', options: categoryOptions(), value: asset.category_id },
                { name: 'manufacturer', label: 'Manufacturer', value: asset.manufacturer },
                { name: 'model', label: 'Model', value: asset.model },
                { name: 'location', label: 'Location / branch', type: 'select', options: referenceOptions('locations', asset.location), value: asset.location },
                { name: 'department', label: 'Department', type: 'select', options: referenceOptions('departments', asset.department), value: asset.department },
                { name: 'purchase_date', label: 'Purchase date', type: 'date', value: day(asset.purchase_date) },
                { name: 'purchase_cost', label: 'Purchase cost', type: 'number', step: '0.01', min: 0, value: asset.purchase_cost },
                { name: 'supplier', label: 'Supplier', value: asset.supplier },
                { name: 'po_invoice_ref', label: 'PO / invoice reference', value: asset.po_invoice_ref },
                { name: 'warranty_provider', label: 'Warranty provider', value: asset.warranty_provider },
                { name: 'warranty_start', label: 'Warranty start', type: 'date', value: day(asset.warranty_start) },
                { name: 'warranty_end', label: 'Warranty end', type: 'date', value: day(asset.warranty_end) },
                { name: 'warranty_ref', label: 'Warranty reference', value: asset.warranty_ref }
            ],
            onSubmit: function (form) {
                var updates = {};
                Object.keys(form.values).forEach(function (key) {
                    updates[key] = form.values[key] === '' ? null : form.values[key];
                });
                return Api.assets.update(asset.id, updates).then(function () {
                    loadAssets();
                });
            }
        });
    }

    /** Drops empty strings / nulls so the API applies its own defaults. */
    function compact(values) {
        var out = {};
        Object.keys(values).forEach(function (key) {
            if (values[key] !== '' && values[key] !== null) out[key] = values[key];
        });
        return out;
    }


    function openAssetDetail(asset) {
        var pairs = [
            { label: 'Asset tag', value: asset.asset_tag },
            { label: 'Asset ID', value: asset.asset_id },
            { label: 'Serial number', value: asset.serial_number },
            { label: 'Category', value: asset.category_name },
            { label: 'Manufacturer / model', value: [asset.manufacturer, asset.model].filter(Boolean).join(' ') },
            { label: 'Status', html: badge(asset.status) },
            { label: 'Condition', html: badge(asset.condition_status) },
            { label: 'Location', value: asset.location },
            { label: 'Department', value: asset.department },
            { label: 'Custodian', value: asset.assigned_full_name || asset.assigned_to_name },
            { label: 'Responsible officer', value: asset.responsible_officer },
            { label: 'Purchase date', value: day(asset.purchase_date) },
            { label: 'Purchase cost', value: asset.purchase_cost !== null && asset.purchase_cost !== undefined ? money(asset.purchase_cost) : '' },
            { label: 'Supplier', value: asset.supplier },
            { label: 'PO / invoice ref', value: asset.po_invoice_ref },
            { label: 'Warranty provider', value: asset.warranty_provider },
            { label: 'Warranty period', value: [day(asset.warranty_start), day(asset.warranty_end)].filter(Boolean).join(' to ') },
            { label: 'Warranty reference', value: asset.warranty_ref },
            { label: 'Registered', value: when(asset.date_registered) }
        ];

        var html =
            details(pairs) +
            (can.readAll()
                ? '<div class="section-label">Documents</div><div id="assetDocuments">' +
                    '<div class="loading"><span class="spinner-dark"></span>Loading documents...</div></div>'
                : '') +
            '<div class="section-label">Maintenance history</div>' +
            '<div id="assetMaintHistory"><div class="loading"><span class="spinner-dark"></span>Loading history...</div></div>' +
            '<div class="section-label">Movement history</div>' +
            '<div id="assetMoveHistory"><div class="loading"><span class="spinner-dark"></span>Loading history...</div></div>' +
            '<div id="assetDetailActions" style="margin-top:18px;display:flex;gap:10px;flex-wrap:wrap;"></div>';

        openDetail('Asset: ' + (asset.asset_tag || asset.asset_id), html, true);

        // Actions the current role may perform on this asset.
        var actions = document.getElementById('assetDetailActions');
        if (can.write()) {
            actions.innerHTML =
                '<button class="btn btn-secondary" id="actEditAsset">Edit details</button>' +
                '<button class="btn btn-primary" id="actLogFault">Log a fault</button>' +
                '<button class="btn btn-secondary" id="actAssign">Assign</button>' +
                '<button class="btn btn-secondary" id="actTransfer">Transfer</button>';

            document.getElementById('actEditAsset').addEventListener('click', function () {
                openAssetEditForm(asset);
            });
            document.getElementById('actLogFault').addEventListener('click', function () {
                openMaintenanceForm({ asset_id: asset.id });
            });
            document.getElementById('actAssign').addEventListener('click', function () {
                openAssignmentForm({ asset_id: asset.id });
            });
            document.getElementById('actTransfer').addEventListener('click', function () {
                openTransferForm({
                    asset_id: asset.id,
                    from_location: asset.location,
                    from_department: asset.department
                });
            });
        }

        if (can.readAll()) renderAssetDocuments(asset);

        // Load the asset's maintenance history.
        Api.maintenance.getAssetHistory(asset.id).then(
            function (data) {
                var rows = (data && data.maintenance) || [];
                var target = document.getElementById('assetMaintHistory');
                if (!target) return;
                target.innerHTML = table(
                    rows,
                    [
                        { label: 'Reference', key: 'maintenance_ref' },
                        { label: 'Type', key: 'maintenance_type' },
                        { label: 'Priority', render: function (r) { return priorityBadge(r.priority); } },
                        { label: 'Status', render: function (r) { return badge(r.status); } },
                        { label: 'Reported', className: 'nowrap', render: function (r) { return orDash(day(r.reported_date)); } },
                        { label: 'Cost', className: 'num', render: function (r) { return money(r.cost); } }
                    ],
                    { empty: 'No maintenance has been recorded for this asset.' }
                );
            },
            function () {
                var target = document.getElementById('assetMaintHistory');
                if (target) target.innerHTML = '<div class="empty">Maintenance history unavailable.</div>';
            }
        );

        // Load the asset's movement history.
        Api.transfers.getAssetHistory(asset.id).then(
            function (data) {
                var rows = (data && (data.transfers || data.history)) || [];
                var target = document.getElementById('assetMoveHistory');
                if (!target) return;
                target.innerHTML = table(
                    rows,
                    [
                        { label: 'Reference', key: 'transfer_ref' },
                        { label: 'Type', key: 'transfer_type' },
                        { label: 'From', render: function (r) { return orDash(r.from_custodian_name || r.from_department || r.from_location); } },
                        { label: 'To', render: function (r) { return orDash(r.to_custodian_name || r.to_department || r.to_location); } },
                        { label: 'Date', className: 'nowrap', render: function (r) { return orDash(day(r.transfer_date)); } },
                        { label: 'Status', render: function (r) { return badge(r.status); } }
                    ],
                    { empty: 'No movement recorded for this asset.' }
                );
            },
            function () {
                var target = document.getElementById('assetMoveHistory');
                if (target) target.innerHTML = '<div class="empty">Movement history unavailable.</div>';
            }
        );
    }

    function renderAssetDocuments(asset) {
        var target = document.getElementById('assetDocuments');
        if (!target) return;

        function loadDocuments() {
            target.innerHTML = '<div class="loading"><span class="spinner-dark"></span>Loading documents...</div>';
            Api.assets.listDocuments(asset.id).then(function (data) {
                var documents = (data && data.documents) || [];
                target.innerHTML =
                    (can.write()
                        ? '<div class="toolbar"><div class="grow"><label class="field-label" for="assetDocumentFile">' +
                            'Add a PDF, JPEG, or PNG (max 10 MB)</label><input id="assetDocumentFile" type="file" ' +
                            'accept=".pdf,.jpg,.jpeg,.png,application/pdf,image/jpeg,image/png"></div>' +
                            '<button class="btn btn-secondary" id="assetDocumentUpload" disabled>Upload document</button></div>'
                        : '') +
                    (documents.length
                        ? '<div class="table-wrap"><table class="data"><thead><tr><th>Document</th><th>Size</th>' +
                            '<th>Uploaded by</th><th>Date</th><th>Actions</th></tr></thead><tbody>' +
                            documents.map(function (document) {
                                return '<tr><td>' + esc(document.original_name) + '</td><td>' +
                                    (Number(document.file_size) / 1024).toFixed(1) + ' KB</td><td>' +
                                    esc(document.uploaded_by_name || '—') + '</td><td>' +
                                    esc(when(document.created_at)) + '</td><td>' +
                                    '<button class="btn btn-sm btn-secondary" data-document-download="' +
                                    esc(document.id) + '">Download</button> ' +
                                    (can.write() ? '<button class="btn btn-sm btn-danger" data-document-delete="' +
                                        esc(document.id) + '">Delete</button>' : '') +
                                    '</td></tr>';
                            }).join('') + '</tbody></table></div>'
                        : '<div class="empty">No documents have been attached to this asset.</div>');

                var fileInput = document.getElementById('assetDocumentFile');
                var uploadButton = document.getElementById('assetDocumentUpload');
                if (fileInput && uploadButton) {
                    fileInput.addEventListener('change', function () {
                        uploadButton.disabled = !fileInput.files.length;
                    });
                    uploadButton.addEventListener('click', function () {
                        var file = fileInput.files[0];
                        if (!file) return;
                        uploadButton.disabled = true;
                        uploadButton.textContent = 'Uploading...';
                        Api.assets.uploadDocument(asset.id, file).then(function () {
                            showAlert('Document uploaded.', 'success');
                            loadDocuments();
                        }).catch(function (error) {
                            showAlert(error.message || 'Could not upload the document.', 'error');
                        }).finally(function () {
                            uploadButton.disabled = false;
                            uploadButton.textContent = 'Upload document';
                        });
                    });
                }

                target.querySelectorAll('[data-document-download]').forEach(function (button) {
                    button.addEventListener('click', function () {
                        var documentId = button.getAttribute('data-document-download');
                        var entry = documents.find(function (item) {
                            return String(item.id) === String(documentId);
                        });
                        button.disabled = true;
                        Api.assets.downloadDocument(asset.id, documentId).then(function (blob) {
                            var url = URL.createObjectURL(blob);
                            var link = document.createElement('a');
                            link.href = url;
                            link.download = entry ? entry.original_name : 'asset-document';
                            link.click();
                            window.setTimeout(function () {
                                URL.revokeObjectURL(url);
                            }, 1000);
                        }).catch(function (error) {
                            showAlert(error.message || 'Could not download the document.', 'error');
                        }).finally(function () {
                            button.disabled = false;
                        });
                    });
                });

                target.querySelectorAll('[data-document-delete]').forEach(function (button) {
                    button.addEventListener('click', function () {
                        if (!window.confirm('Delete this attached document?')) return;
                        button.disabled = true;
                        Api.assets.deleteDocument(asset.id, button.getAttribute('data-document-delete'))
                            .then(function () {
                                showAlert('Document deleted.', 'success');
                                loadDocuments();
                            }).catch(function (error) {
                                button.disabled = false;
                                showAlert(error.message || 'Could not delete the document.', 'error');
                            });
                    });
                });
            }).catch(function (error) {
                target.innerHTML = '<div class="empty">Could not load asset documents: ' +
                    esc(error.message) + '</div>';
            });
        }

        loadDocuments();
    }


    /* ======================================================================
     * Assignments & custody view (§5.3)
     * ==================================================================== */

    /** Custodian options from the pick-list the API exposed. */
    function userOptions() {
        var list = (meta.assignment && meta.assignment.users) || [];
        return list.map(function (u) {
            return { value: u.id, label: u.full_name || u.username };
        });
    }

    /** Asset options from the asset pick-list the API exposed. */
    function assetOptions() {
        var list = (meta.maintenance && meta.maintenance.assets) || [];
        return list.map(function (a) {
            return { value: a.id, label: a.asset_tag + ' - ' + (a.serial_number || a.asset_id) };
        });
    }

    function renderAssignments() {
        var s = state.assignments;

        el.view.innerHTML =
            '<div class="toolbar">' +
            '<div class="grow"><label class="field-label" for="asgSearch">Search</label>' +
            '<input type="text" id="asgSearch" placeholder="Asset, custodian, department..." value="' + esc(s.filters.search || '') + '"></div>' +
            '<div><label class="field-label" for="asgStatus">Status</label>' +
            '<select id="asgStatus" style="min-width:150px;">' +
            ['', 'Active', 'Returned', 'Transferred', 'Cancelled']
                .map(function (v) {
                    return '<option value="' + esc(v) + '"' + (s.filters.status === v ? ' selected' : '') + '>' + (v || 'All statuses') + '</option>';
                })
                .join('') +
            '</select></div>' +
            '<button class="btn btn-secondary" id="asgSearchBtn">Search</button>' +
            (can.write() ? '<button class="btn btn-primary" id="asgNewBtn">+ New assignment</button>' : '') +
            '</div>' +
            '<div class="card"><div id="asgTable"></div></div>';

        document.getElementById('asgSearchBtn').addEventListener('click', function () {
            s.filters.search = document.getElementById('asgSearch').value.trim();
            s.filters.status = document.getElementById('asgStatus').value;
            s.offset = 0;
            loadAssignments();
        });

        document.getElementById('asgSearch').addEventListener('keydown', function (e) {
            if (e.key === 'Enter') document.getElementById('asgSearchBtn').click();
        });

        var newBtn = document.getElementById('asgNewBtn');
        if (newBtn) newBtn.addEventListener('click', function () { openAssignmentForm({}); });

        loadAssignments();
    }


    /** Compact form values: drops empties so the API applies its own defaults. */
    function compact(values) {
        var out = {};
        Object.keys(values).forEach(function (key) {
            if (values[key] !== '' && values[key] !== null) out[key] = values[key];
        });
        return out;
    }

    function loadAssignments() {
        var s = state.assignments;
        var container = document.getElementById('asgTable');
        if (!container) return;

        container.innerHTML = '<div class="loading"><span class="spinner-dark"></span>Loading assignments...</div>';

        var filters = Object.assign({}, s.filters, { limit: s.limit, offset: s.offset });

        Api.assignments.list(filters).then(
            function (data) {
                s.rows = (data && data.assignments) || [];
                s.total = (data && data.total) || 0;

                container.innerHTML = table(
                    s.rows,
                    [
                        {
                            label: 'Asset',
                            render: function (r) {
                                return '<strong>' + orDash(r.asset_tag) + '</strong><div class="muted" style="font-size:12px;">' + orDash(r.asset_code) + '</div>';
                            }
                        },
                        {
                            label: 'Custodian',
                            render: function (r) {
                                return orDash(r.assigned_full_name || r.assigned_to_name) +
                                    '<div class="muted" style="font-size:12px;">' + orDash(r.assigned_username) + '</div>';
                            }
                        },
                        { label: 'Department', render: function (r) { return orDash(r.department); } },
                        { label: 'Location', render: function (r) { return orDash(r.location); } },
                        { label: 'Assigned', className: 'nowrap', render: function (r) { return orDash(day(r.assignment_date)); } },
                        { label: 'Status', render: function (r) { return badge(r.status); } },
                        {
                            label: 'Actions',
                            className: 'actions',
                            render: function (r) {
                                var html = '<button class="btn btn-sm btn-secondary" data-asg-view="' +
                                    esc(r.id) + '">View</button>';
                                if (r.status === 'Active' && !r.acknowledged_at) {
                                    html += '<button class="btn btn-sm btn-warn" data-asg-ack="' +
                                        esc(r.id) + '">Acknowledge</button>';
                                }
                                if (can.write() && r.status === 'Active') {
                                    html += '<button class="btn btn-sm btn-secondary" data-asg-return="' +
                                        esc(r.id) + '">Return</button>';
                                }
                                return html;
                            }
                        }
                    ],
                    {
                        empty: 'No assignments recorded yet.',
                        total: s.total,
                        pager: { offset: s.offset, limit: s.limit }
                    }
                );

                bindPager(container, s, loadAssignments);

                Array.prototype.forEach.call(container.querySelectorAll('[data-asg-view]'), function (btn) {
                    btn.addEventListener('click', function () {
                        var row = s.rows.find(function (item) {
                            return String(item.id) === btn.getAttribute('data-asg-view');
                        });
                        if (!row) return;
                        openDetail(
                            'Assignment: ' + (row.asset_tag || row.asset_code || ''),
                            details([
                                { label: 'Asset', value: (row.asset_tag || '') + ' (' + (row.asset_code || '') + ')' },
                                { label: 'Custodian', value: row.assigned_full_name || row.assigned_to_name },
                                { label: 'Department', value: row.department },
                                { label: 'Location', value: row.location },
                                { label: 'Assignment date', value: day(row.assignment_date) },
                                { label: 'Expected return', value: day(row.expected_return_date) },
                                { label: 'Status', html: badge(row.status) },
                                { label: 'Acknowledged', value: row.acknowledged_at ? when(row.acknowledged_at) : 'No' },
                                { label: 'Purpose', value: row.purpose },
                                { label: 'Remarks', value: row.remarks, full: true }
                            ]),
                            true
                        );
                    });
                });

                Array.prototype.forEach.call(container.querySelectorAll('[data-asg-ack]'), function (btn) {
                    btn.addEventListener('click', function () {
                        Api.assignments
                            .acknowledge(btn.getAttribute('data-asg-ack'), {
                                acknowledged_remarks: 'Confirmed via the web portal.'
                            })
                            .then(
                                function () {
                                    showAlert('Receipt acknowledged.', 'success');
                                    loadAssignments();
                                },
                                function (error) { showAlert(error.message, 'error'); }
                            );
                    });
                });

                Array.prototype.forEach.call(container.querySelectorAll('[data-asg-return]'), function (btn) {
                    btn.addEventListener('click', function () {
                        Api.assignments
                            .returnAsset(btn.getAttribute('data-asg-return'), {
                                release_reason: 'Returned to ICT stores.'
                            })
                            .then(
                                function () {
                                    showAlert('Asset returned to stores.', 'success');
                                    loadAssignments();
                                },
                                function (error) { showAlert(error.message, 'error'); }
                            );
                    });
                });
            },
            function (error) {
                container.innerHTML = '<div class="empty">Could not load assignments: ' + esc(error.message) + '</div>';
            }
        );
    }


    function openAssignmentForm(preset) {
        openForm({
            title: 'Assign an asset to a custodian',
            submitLabel: 'Create assignment',
            successMessage: 'Assignment created successfully.',
            fields: [
                { name: 'asset_id', label: 'Asset', type: 'select', required: true, options: assetOptions(), value: preset.asset_id },
                { name: 'assigned_user_id', label: 'Custodian', type: 'select', required: true, options: userOptions() },
                { name: 'assigned_to_name', label: 'Custodian name (as printed)', hint: 'Leave blank to use the selected user.' },
                { name: 'department', label: 'Department', type: 'select', options: referenceOptions('departments') },
                { name: 'location', label: 'Location', type: 'select', options: referenceOptions('locations') },
                { name: 'responsible_officer', label: 'Responsible officer' },
                { name: 'assignment_date', label: 'Assignment date', type: 'date', required: true, value: today() },
                { name: 'expected_return_date', label: 'Expected return', type: 'date' },
                { name: 'purpose', label: 'Purpose' },
                { name: 'remarks', label: 'Remarks', type: 'textarea', full: true }
            ],
            onSubmit: function (payload) {
                return Api.assignments.create(compact(payload.values)).then(function () {
                    loadAssignments();
                });
            }
        });
    }


    /* ======================================================================
     * Transfers & movement view (§5.4)
     * ==================================================================== */

    function renderTransfers() {
        var s = state.transfers;

        el.view.innerHTML =
            '<div class="toolbar">' +
            '<div class="grow"><label class="field-label" for="trfSearch">Search</label>' +
            '<input type="text" id="trfSearch" placeholder="Reference, asset, custodian, reason..." value="' + esc(s.filters.search || '') + '"></div>' +
            '<div><label class="field-label" for="trfType">Type</label>' +
            '<select id="trfType" style="min-width:150px;">' +
            ['', 'User', 'Department', 'Location', 'Stock', 'Other']
                .map(function (v) {
                    return '<option value="' + esc(v) + '"' + (s.filters.transfer_type === v ? ' selected' : '') + '>' + (v || 'All types') + '</option>';
                })
                .join('') +
            '</select></div>' +
            '<div><label class="field-label" for="trfStatus">Status</label>' +
            '<select id="trfStatus" style="min-width:150px;">' +
            ['', 'Completed', 'Pending', 'Cancelled', 'Reversed']
                .map(function (v) {
                    return '<option value="' + esc(v) + '"' + (s.filters.status === v ? ' selected' : '') + '>' + (v || 'All statuses') + '</option>';
                })
                .join('') +
            '</select></div>' +
            '<button class="btn btn-secondary" id="trfSearchBtn">Search</button>' +
            (can.write() ? '<button class="btn btn-primary" id="trfNewBtn">+ Record transfer</button>' : '') +
            '</div>' +
            '<div class="card"><div id="trfTable"></div></div>';

        document.getElementById('trfSearchBtn').addEventListener('click', function () {
            s.filters.search = document.getElementById('trfSearch').value.trim();
            s.filters.transfer_type = document.getElementById('trfType').value;
            s.filters.status = document.getElementById('trfStatus').value;
            s.offset = 0;
            loadTransfers();
        });

        document.getElementById('trfSearch').addEventListener('keydown', function (e) {
            if (e.key === 'Enter') document.getElementById('trfSearchBtn').click();
        });

        var newBtn = document.getElementById('trfNewBtn');
        if (newBtn) newBtn.addEventListener('click', function () { openTransferForm({}); });

        loadTransfers();
    }


    function loadTransfers() {
        var s = state.transfers;
        var container = document.getElementById('trfTable');
        if (!container) return;

        container.innerHTML = '<div class="loading"><span class="spinner-dark"></span>Loading transfers...</div>';

        var filters = Object.assign({}, s.filters, { limit: s.limit, offset: s.offset });

        Api.transfers.list(filters).then(
            function (data) {
                s.rows = (data && data.transfers) || [];
                s.total = (data && data.total) || 0;

                container.innerHTML = table(
                    s.rows,
                    [
                        {
                            label: 'Reference',
                            render: function (r) {
                                return '<strong>' + esc(r.transfer_ref || '') + '</strong><div class="muted" style="font-size:12px;">' + orDash(day(r.transfer_date)) + '</div>';
                            }
                        },
                        {
                            label: 'Asset',
                            render: function (r) {
                                return orDash(r.asset_tag) + '<div class="muted" style="font-size:12px;">' + orDash(r.asset_code) + '</div>';
                            }
                        },
                        { label: 'Type', render: function (r) { return badge(r.transfer_type); } },
                        {
                            label: 'From',
                            render: function (r) {
                                return orDash(r.from_custodian_name || r.from_department || r.from_location) +
                                    '<div class="muted" style="font-size:12px;">' + orDash(r.from_location) + '</div>';
                            }
                        },
                        {
                            label: 'To',
                            render: function (r) {
                                return orDash(r.to_custodian_name || r.to_department || r.to_location) +
                                    '<div class="muted" style="font-size:12px;">' + orDash(r.to_location) + '</div>';
                            }
                        },
                        { label: 'Status', render: function (r) { return badge(r.status); } },
                        {
                            label: 'Actions',
                            className: 'actions',
                            render: function (r) {
                                var html = '<button class="btn btn-sm btn-secondary" data-trf-view="' +
                                    esc(r.id) + '">View</button> ';
                                if (r.status === 'Pending' && can.admin() &&
                                    Number(r.initiated_by) !== Number(state.user && state.user.id)) {
                                    html += '<button class="btn btn-sm btn-primary" data-trf-approve="' +
                                        esc(r.id) + '">Approve</button> ';
                                }
                                if (r.status === 'Pending' && can.admin()) {
                                    html += '<button class="btn btn-sm btn-danger" data-trf-cancel="' +
                                        esc(r.id) + '">Cancel</button> ';
                                }
                                if (r.status === 'Completed' && !r.receiving_party_acknowledged_at && can.write()) {
                                    html += '<button class="btn btn-sm btn-warn" data-trf-ack="' +
                                        esc(r.id) + '">Acknowledge</button> ';
                                }
                                if (can.admin() && r.status === 'Completed') {
                                    html += '<button class="btn btn-sm btn-danger" data-trf-reverse="' +
                                        esc(r.id) + '">Reverse</button>';
                                }
                                return html;
                            }
                        }
                    ],
                    {
                        empty: 'No transfers recorded yet.',
                        total: s.total,
                        pager: { offset: s.offset, limit: s.limit }
                    }
                );

                bindPager(container, s, loadTransfers);

                Array.prototype.forEach.call(container.querySelectorAll('[data-trf-view]'), function (btn) {
                    btn.addEventListener('click', function () {
                        var row = s.rows.find(function (item) {
                            return String(item.id) === btn.getAttribute('data-trf-view');
                        });
                        if (!row) return;
                        openDetail('Transfer ' + row.transfer_ref, '<div class="detail-grid">' + [
                            ['Asset', row.asset_tag + ' (' + row.asset_code + ')'],
                            ['Status', row.status],
                            ['Type', row.transfer_type],
                            ['From', row.from_custodian_name || row.from_department || row.from_location],
                            ['To', row.to_custodian_name || row.to_department || row.to_location],
                            ['Transfer date', day(row.transfer_date)],
                            ['Reason', row.reason],
                            ['Receiving party', row.receiving_party_name],
                            ['Acknowledged', row.receiving_party_acknowledged_at ? day(row.receiving_party_acknowledged_at) : 'No']
                        ].map(function (pair) {
                            return '<div><div class="muted">' + esc(pair[0]) + '</div><div>' +
                                esc(pair[1] || '—') + '</div></div>';
                        }).join('') + '</div>', true);
                    });
                });

                Array.prototype.forEach.call(container.querySelectorAll('[data-trf-approve]'), function (btn) {
                    btn.addEventListener('click', function () {
                        btn.disabled = true;
                        Api.transfers.approve(btn.getAttribute('data-trf-approve')).then(function () {
                            showAlert('Pending transfer approved.', 'success');
                            loadTransfers();
                        }).catch(function (error) {
                            btn.disabled = false;
                            showAlert(error.message, 'error');
                        });
                    });
                });

                Array.prototype.forEach.call(container.querySelectorAll('[data-trf-cancel]'), function (btn) {
                    btn.addEventListener('click', function () {
                        if (!window.confirm('Cancel this pending transfer?')) return;
                        btn.disabled = true;
                        Api.transfers.cancel(btn.getAttribute('data-trf-cancel'), {
                            reason: 'Cancelled from the web portal.'
                        }).then(function () {
                            showAlert('Pending transfer cancelled.', 'success');
                            loadTransfers();
                        }).catch(function (error) {
                            btn.disabled = false;
                            showAlert(error.message, 'error');
                        });
                    });
                });

                Array.prototype.forEach.call(container.querySelectorAll('[data-trf-ack]'), function (btn) {
                    btn.addEventListener('click', function () {
                        Api.transfers
                            .acknowledge(btn.getAttribute('data-trf-ack'), {
                                receiving_party_name: state.user ? state.user.full_name : null
                            })
                            .then(
                                function () {
                                    showAlert('Transfer receipt acknowledged.', 'success');
                                    loadTransfers();
                                },
                                function (error) { showAlert(error.message, 'error'); }
                            );
                    });
                });

                Array.prototype.forEach.call(container.querySelectorAll('[data-trf-reverse]'), function (btn) {
                    btn.addEventListener('click', function () {
                        Api.transfers
                            .reverse(btn.getAttribute('data-trf-reverse'), {
                                reason: 'Reversed from the web portal.'
                            })
                            .then(
                                function () {
                                    showAlert('Transfer reversed.', 'success');
                                    loadTransfers();
                                },
                                function (error) { showAlert(error.message, 'error'); }
                            );
                    });
                });
            },
            function (error) {
                container.innerHTML = '<div class="empty">Could not load transfers: ' + esc(error.message) + '</div>';
            }
        );
    }


    function openTransferForm(preset) {
        openForm({
            title: 'Record an asset transfer',
            submitLabel: 'Record transfer',
            successMessage: 'Transfer recorded. Pending requests update custody only after approval.',
            fields: [
                { name: 'asset_id', label: 'Asset', type: 'select', required: true, options: assetOptions(), value: preset.asset_id },
                { name: 'transfer_type', label: 'Transfer type', type: 'select', required: true, options: ['User', 'Department', 'Location', 'Stock', 'Other'], value: 'User' },
                { name: 'status', label: 'Workflow status', type: 'select', required: true, options: ['Completed', 'Pending'], value: 'Completed', hint: 'Completed applies the move immediately. Pending leaves custody unchanged until an independent administrator or HISO approves it.' },
                { name: 'to_user_id', label: 'New custodian', type: 'select', options: userOptions() },
                { name: 'to_custodian_name', label: 'New custodian name (as printed)' },
                { name: 'to_department', label: 'New department', type: 'select', options: referenceOptions('departments', preset.from_department) },
                { name: 'to_location', label: 'New location', type: 'select', options: referenceOptions('locations', preset.from_location), value: preset.from_location },
                { name: 'to_condition', label: 'Condition on hand-over', type: 'select', options: ['Good', 'Fair', 'Damaged', 'Obsolete'], value: 'Good' },
                { name: 'transfer_date', label: 'Transfer date', type: 'date', required: true, value: today() },
                { name: 'reason', label: 'Reason for the move', full: true },
                { name: 'responsible_officer', label: 'Responsible officer' },
                { name: 'receiving_party_name', label: 'Receiving party (signature block)' },
                { name: 'remarks', label: 'Remarks', type: 'textarea', full: true }
            ],
            onSubmit: function (payload) {
                return Api.transfers.create(compact(payload.values)).then(function () {
                    loadTransfers();
                });
            }
        });
    }

    /* ======================================================================
     * Maintenance & repairs view (§5.5)
     * ==================================================================== */

    function maintenanceMeta(name, fallback) {
        return (meta.maintenance && meta.maintenance[name]) || fallback;
    }

    function renderMaintenance() {
        var s = state.maintenance;

        el.view.innerHTML =
            '<div class="stat-grid" id="mntStats"><div class="stat"><div class="label">Open work orders</div><div class="value">&hellip;</div></div></div>' +
            '<div class="toolbar">' +
            '<div class="grow"><label class="field-label" for="mntSearch">Search</label>' +
            '<input type="text" id="mntSearch" placeholder="Reference, asset, fault, technician, vendor..." value="' + esc(s.filters.search || '') + '"></div>' +
            '<div><label class="field-label" for="mntStatus">Status</label>' +
            '<select id="mntStatus" style="min-width:160px;">' +
            ['', 'Open', 'Pending', 'In Progress', 'On Hold', 'Completed', 'Cancelled']
                .map(function (v) {
                    return '<option value="' + esc(v) + '"' + (s.filters.status === v ? ' selected' : '') + '>' + (v || 'All statuses') + '</option>';
                })
                .join('') +
            '</select></div>' +
            '<div><label class="field-label" for="mntType">Type</label>' +
            '<select id="mntType" style="min-width:160px;">' +
            ['', 'Repair', 'Service', 'Inspection', 'Upgrade', 'Warranty Claim', 'Other']
                .map(function (v) {
                    return '<option value="' + esc(v) + '"' + (s.filters.maintenance_type === v ? ' selected' : '') + '>' + (v || 'All types') + '</option>';
                })
                .join('') +
            '</select></div>' +
            '<div><label class="field-label" for="mntPriority">Priority</label>' +
            '<select id="mntPriority" style="min-width:140px;">' +
            ['', 'Critical', 'High', 'Medium', 'Low']
                .map(function (v) {
                    return '<option value="' + esc(v) + '"' + (s.filters.priority === v ? ' selected' : '') + '>' + (v || 'All priorities') + '</option>';
                })
                .join('') +
            '</select></div>' +
            '<button class="btn btn-secondary" id="mntSearchBtn">Search</button>' +
            '<button class="btn btn-secondary" id="mntOverdueBtn">Overdue</button>' +
            (can.write() ? '<button class="btn btn-primary" id="mntNewBtn">+ Log a fault</button>' : '') +
            '</div>' +
            '<div class="card"><div id="mntTable"></div></div>';

        document.getElementById('mntSearchBtn').addEventListener('click', function () {
            s.filters.search = document.getElementById('mntSearch').value.trim();
            s.filters.status = document.getElementById('mntStatus').value;
            s.filters.maintenance_type = document.getElementById('mntType').value;
            s.filters.priority = document.getElementById('mntPriority').value;
            s.offset = 0;
            loadMaintenance();
        });

        document.getElementById('mntSearch').addEventListener('keydown', function (e) {
            if (e.key === 'Enter') document.getElementById('mntSearchBtn').click();
        });

        document.getElementById('mntOverdueBtn').addEventListener('click', loadOverdueMaintenance);

        var newBtn = document.getElementById('mntNewBtn');
        if (newBtn) newBtn.addEventListener('click', function () { openMaintenanceForm({}); });

        loadMaintenanceStats();
        loadMaintenance();
    }


    /**
     * Builds the maintenance row columns - shared by the list and the overdue
     * quick-filter so both views look identical.
     */
    function maintenanceColumns() {
        return [
            {
                label: 'Reference',
                render: function (r) {
                    return '<strong>' + esc(r.maintenance_ref || '') + '</strong><div class="muted" style="font-size:12px;">' + orDash(day(r.reported_date)) + '</div>';
                }
            },
            {
                label: 'Asset',
                render: function (r) {
                    return orDash(r.asset_tag) + '<div class="muted" style="font-size:12px;">' + orDash(r.asset_code) + '</div>';
                }
            },
            { label: 'Type', key: 'maintenance_type' },
            { label: 'Priority', render: function (r) { return priorityBadge(r.priority); } },
            {
                label: 'Fault',
                render: function (r) {
                    var text = r.fault_description || '';
                    if (text.length > 70) text = text.slice(0, 70) + '...';
                    return orDash(text);
                }
            },
            {
                label: 'Technician / vendor',
                render: function (r) {
                    return orDash(r.technician_name) + '<div class="muted" style="font-size:12px;">' + orDash(r.vendor) + '</div>';
                }
            },
            { label: 'Cost', className: 'num', render: function (r) { return money(r.cost); } },
            { label: 'Status', render: function (r) { return badge(r.status); } },
            {
                label: 'Actions',
                className: 'actions',
                render: function (r) {
                    var html =
                        '<button class="btn btn-sm btn-secondary" data-mnt-view="' + esc(r.id) + '">View</button> ';
                    if (can.write() && r.status === 'Pending') {
                        html += '<button class="btn btn-sm btn-primary" data-mnt-start="' + esc(r.id) + '">Start</button> ';
                    }
                    if (can.write() && (r.status === 'In Progress' || r.status === 'On Hold')) {
                        html += '<button class="btn btn-sm btn-primary" data-mnt-complete="' + esc(r.id) + '">Complete</button> ';
                    }
                    if (can.admin() && r.status !== 'Completed' && r.status !== 'Cancelled') {
                        html += '<button class="btn btn-sm btn-danger" data-mnt-cancel="' + esc(r.id) + '">Cancel</button>';
                    }
                    return html;
                }
            }
        ];
    }

    function loadMaintenanceStats() {
        var container = document.getElementById('mntStats');
        if (!container) return;

        Api.maintenance.getStats().then(
            function (stats) {
                container.innerHTML =
                    statTile(
                        'Open work orders',
                        stats.open || 0,
                        (stats.openRepairs || 0) + ' repairs · ' + (stats.openServices || 0) + ' services',
                        'warn'
                    ) +
                    statTile('Overdue', stats.overdue || 0, null, 'danger') +
                    statTile('Completed', stats.completed || 0) +
                    statTile('Warranty claims', stats.warrantyClaims || 0, null, 'info') +
                    statTile('Total spend', money(stats.totalCost)) +
                    statTile('Spend this year', money(stats.costThisYear));
                refreshOpenBadge();
            },
            function () {
                container.innerHTML = '';
            }
        );
    }

    function loadMaintenance() {
        var s = state.maintenance;
        var container = document.getElementById('mntTable');
        if (!container) return;

        container.innerHTML = '<div class="loading"><span class="spinner-dark"></span>Loading maintenance records...</div>';

        var filters = Object.assign({}, s.filters, { limit: s.limit, offset: s.offset });

        Api.maintenance.list(filters).then(
            function (data) {
                s.rows = (data && data.maintenance) || [];
                s.total = (data && data.total) || 0;

                container.innerHTML = table(s.rows, maintenanceColumns(), {
                    empty: 'No maintenance records matched.',
                    total: s.total,
                    pager: { offset: s.offset, limit: s.limit }
                });

                bindPager(container, s, loadMaintenance);
                bindMaintenanceRowActions(container, s);
            },
            function (error) {
                container.innerHTML = '<div class="empty">Could not load maintenance records: ' + esc(error.message) + '</div>';
            }
        );
    }

    /** Quick filter: every open job past its scheduled date. */
    function loadOverdueMaintenance() {
        var container = document.getElementById('mntTable');
        if (!container) return;

        container.innerHTML = '<div class="loading"><span class="spinner-dark"></span>Loading overdue jobs...</div>';

        Api.maintenance.getOverdue().then(
            function (data) {
                var rows = (data && data.maintenance) || [];
                container.innerHTML = table(rows, maintenanceColumns(), {
                    empty: 'No overdue maintenance. Good news.'
                });
                bindMaintenanceRowActions(container, { rows: rows });
            },
            function (error) {
                container.innerHTML = '<div class="empty">Could not load overdue maintenance: ' + esc(error.message) + '</div>';
            }
        );
    }


    /** Wires the per-row View / Start / Complete / Cancel buttons. */
    function bindMaintenanceRowActions(container, sourceState) {
        function findRow(id) {
            return (sourceState.rows || []).filter(function (r) {
                return String(r.id) === String(id);
            })[0];
        }

        function afterChange(message) {
            return function () {
                showAlert(message, 'success');
                loadMaintenanceStats();
                loadMaintenance();
            };
        }

        function afterFailure(error) {
            var firstError = error.errors && error.errors.length ? error.errors[0].message : null;
            showAlert(firstError || error.message, 'error');
        }

        Array.prototype.forEach.call(container.querySelectorAll('[data-mnt-view]'), function (btn) {
            btn.addEventListener('click', function () {
                var row = findRow(btn.getAttribute('data-mnt-view'));
                if (row) openMaintenanceDetail(row);
            });
        });

        Array.prototype.forEach.call(container.querySelectorAll('[data-mnt-start]'), function (btn) {
            btn.addEventListener('click', function () {
                var id = btn.getAttribute('data-mnt-start');
                openForm({
                    title: 'Start maintenance work',
                    submitLabel: 'Start work',
                    successMessage: 'Maintenance work marked as in progress.',
                    fields: [
                        { name: 'technician_name', label: 'Technician' },
                        { name: 'vendor', label: 'Vendor / workshop' },
                        { name: 'start_date', label: 'Start date', type: 'date', value: today() },
                        { name: 'remarks', label: 'Remarks', type: 'textarea', full: true }
                    ],
                    onSubmit: function (payload) {
                        return Api.maintenance
                            .start(id, compact(payload.values))
                            .then(afterChange('Maintenance work marked as in progress.'))
                            .catch(function (error) {
                                afterFailure(error);
                                throw error;
                            });
                    }
                });
            });
        });

        Array.prototype.forEach.call(container.querySelectorAll('[data-mnt-complete]'), function (btn) {
            btn.addEventListener('click', function () {
                var id = btn.getAttribute('data-mnt-complete');
                openForm({
                    title: 'Complete maintenance work',
                    submitLabel: 'Complete job',
                    successMessage: 'Maintenance record completed.',
                    fields: [
                        { name: 'work_performed', label: 'Work performed', type: 'textarea', full: true, required: true },
                        { name: 'parts_used', label: 'Parts used', full: true },
                        { name: 'resolution', label: 'Resolution', full: true },
                        { name: 'cost', label: 'Cost', type: 'number', step: '0.01', min: 0, value: 0 },
                        { name: 'condition_after', label: 'Condition after repair', type: 'select', options: ['Good', 'Fair', 'Damaged', 'Obsolete'], value: 'Good' },
                        { name: 'technician_name', label: 'Technician' },
                        { name: 'vendor', label: 'Vendor / workshop' },
                        { name: 'completion_date', label: 'Completion date', type: 'date', value: today() },
                        { name: 'warranty_claim', label: 'Warranty claim', type: 'checkbox', checkboxLabel: 'This work is covered by a warranty claim' }
                    ],
                    onSubmit: function (payload) {
                        return Api.maintenance
                            .complete(id, compact(payload.values))
                            .then(afterChange('Maintenance record completed.'))
                            .catch(function (error) {
                                afterFailure(error);
                                throw error;
                            });
                    }
                });
            });
        });

        Array.prototype.forEach.call(container.querySelectorAll('[data-mnt-cancel]'), function (btn) {
            btn.addEventListener('click', function () {
                var id = btn.getAttribute('data-mnt-cancel');
                openForm({
                    title: 'Cancel maintenance record',
                    submitLabel: 'Cancel record',
                    successMessage: 'Maintenance record cancelled.',
                    fields: [
                        { name: 'reason', label: 'Reason for cancelling', type: 'textarea', full: true, required: true }
                    ],
                    onSubmit: function (payload) {
                        return Api.maintenance
                            .cancel(id, payload.values)
                            .then(afterChange('Maintenance record cancelled.'))
                            .catch(function (error) {
                                afterFailure(error);
                                throw error;
                            });
                    }
                });
            });
        });
    }


    /** Read-only maintenance record panel, with the asset's full history. */
    function openMaintenanceDetail(record) {
        var pairs = [
            { label: 'Reference', value: record.maintenance_ref },
            { label: 'Asset', value: record.asset_tag },
            { label: 'Asset ID', value: record.asset_code },
            { label: 'Type', value: record.maintenance_type },
            { label: 'Status', html: badge(record.status) },
            { label: 'Priority', html: priorityBadge(record.priority) },
            { label: 'Reported by', value: record.reported_by_name || record.reported_by_username },
            { label: 'Reported on', value: day(record.reported_date) },
            { label: 'Scheduled for', value: day(record.scheduled_date) },
            { label: 'Started', value: day(record.start_date) },
            { label: 'Completed', value: day(record.completion_date) },
            { label: 'Technician', value: record.technician_name },
            { label: 'Vendor', value: record.vendor },
            { label: 'Cost', value: money(record.cost) },
            { label: 'Warranty claim', value: record.warranty_claim ? 'Yes' : 'No' },
            { label: 'Condition after', html: record.condition_after ? badge(record.condition_after) : orDash('') },
            { label: 'Fault description', value: record.fault_description, full: true },
            { label: 'Work performed', value: record.work_performed, full: true },
            { label: 'Parts used', value: record.parts_used, full: true },
            { label: 'Resolution', value: record.resolution, full: true },
            { label: 'Remarks', value: record.remarks, full: true },
            { label: 'Recorded by', value: record.performed_by_name || record.performed_by_username }
        ];

        var html =
            details(pairs) +
            '<div class="section-label">Other repairs on this asset</div>' +
            '<div id="mntAssetHistory"><div class="loading"><span class="spinner-dark"></span>Loading history...</div></div>';

        openDetail('Maintenance ' + (record.maintenance_ref || ''), html, true);

        Api.maintenance.getAssetHistory(record.asset_id).then(
            function (data) {
                var rows = (data && data.maintenance) || [];
                var target = document.getElementById('mntAssetHistory');
                if (!target) return;
                target.innerHTML = table(
                    rows,
                    [
                        { label: 'Reference', key: 'maintenance_ref' },
                        { label: 'Type', key: 'maintenance_type' },
                        { label: 'Status', render: function (r) { return badge(r.status); } },
                        { label: 'Reported', className: 'nowrap', render: function (r) { return orDash(day(r.reported_date)); } },
                        { label: 'Cost', className: 'num', render: function (r) { return money(r.cost); } }
                    ],
                    { empty: 'This is the only record for this asset.' }
                );
            },
            function () {
                var target = document.getElementById('mntAssetHistory');
                if (target) target.innerHTML = '<div class="empty">History unavailable.</div>';
            }
        );
    }

    /** Report-a-fault / book-a-service form (§5.5). */
    function openMaintenanceForm(preset) {
        openForm({
            title: 'Log a fault or book a service',
            submitLabel: 'Create record',
            successMessage: 'Maintenance record created.',
            fields: [
                { name: 'asset_id', label: 'Asset', type: 'select', required: true, options: assetOptions(), value: preset.asset_id },
                { name: 'maintenance_type', label: 'Type', type: 'select', required: true, options: maintenanceMeta('maintenance_types', ['Repair', 'Service', 'Inspection', 'Upgrade', 'Warranty Claim', 'Other']), value: 'Repair' },
                { name: 'priority', label: 'Priority', type: 'select', required: true, options: maintenanceMeta('priorities', ['Low', 'Medium', 'High', 'Critical']), value: 'Medium' },
                { name: 'reported_by', label: 'Reported by', type: 'select', options: userOptions() },
                { name: 'reported_date', label: 'Reported date', type: 'date', required: true, value: today() },
                { name: 'scheduled_date', label: 'Scheduled for', type: 'date' },
                { name: 'technician_name', label: 'Technician' },
                { name: 'vendor', label: 'Vendor / workshop' },
                { name: 'fault_description', label: 'Fault description', type: 'textarea', full: true, hint: 'Required for a Repair; optional for a Service or Inspection.' },
                { name: 'remarks', label: 'Remarks', type: 'textarea', full: true }
            ],
            onSubmit: function (payload) {
                return Api.maintenance.create(compact(payload.values)).then(function () {
                    loadMaintenanceStats();
                    loadMaintenance();
                });
            }
        });
    }


    /* ======================================================================
     * Warranty & contract monitoring view (§5.6)
     * ==================================================================== */

    function warrantyMeta(name, fallback) {
        var value = meta.warranty && meta.warranty[name];
        return value === undefined || value === null ? fallback : value;
    }

    /** Warranty type choices for the form. */
    function warrantyTypeOptions() {
        return warrantyMeta('warranty_types', [
            'Asset Warranty',
            'Extended Warranty',
            'Support Contract',
            'Maintenance Contract',
            'Service Level Agreement',
            'Licence Support',
            'Insurance',
            'Other'
        ]);
    }

    /** Asset choices for the warranty form, carrying the cover hint. */
    function warrantyAssetOptions() {
        var list = (meta.warranty && meta.warranty.assets) || [];
        return [{ value: '', label: '-- no asset (site-wide contract) --' }].concat(
            list.map(function (a) {
                var label = a.asset_tag + ' - ' + (a.serial_number || a.asset_id);
                if (a.warranty_end) label += ' (register cover to ' + day(a.warranty_end) + ')';
                return { value: a.id, label: label };
            })
        );
    }

    /** Colours a coverage state the same way everywhere. */
    function coverageStateClass(state) {
        var map = {
            Active: 'ok',
            'Expiring Soon': 'warn',
            Expired: 'danger',
            Cancelled: 'neutral'
        };
        return map[state] || 'neutral';
    }

    /** Builds a coverage-state badge. */
    function coverageBadge(state) {
        if (!state) return '';
        return (
            '<span class="badge-pill ' + coverageStateClass(state) + '">' + esc(state) + '</span>'
        );
    }

    /** Renders the remaining days as a coloured figure. */
    function remainingCell(row) {
        if (row.days_remaining === null || row.days_remaining === undefined) return orDash('');
        var days = Number(row.days_remaining);

        if (days < 0) return '<span class="badge-pill danger">' + Math.abs(days) + 'd overdue</span>';
        if (days === 0) return '<span class="badge-pill warn">expires today</span>';
        if (days <= 90) return '<span class="badge-pill warn">' + days + 'd left</span>';
        return days + 'd';
    }

    /* ======================================================================
     * ICT Stock view (§5.7)
     * ==================================================================== */

    /** Reads a value from the stock meta payload, with a fallback. */
    function stockMeta(name, fallback) {
        var value = meta.stock && meta.stock[name];
        return value === undefined || value === null ? fallback : value;
    }

    /** Colours a store state the same way everywhere. */
    function stockStateClass(stockState) {
        var map = {
            'In Stock': 'ok',
            'Low Stock': 'warn',
            Overstocked: 'info',
            Inactive: 'neutral',
            Discontinued: 'neutral'
        };
        return map[stockState] || 'neutral';
    }

    /** Builds a store-state badge. */
    function stockBadge(stockState) {
        if (!stockState) return '';
        return (
            '<span class="badge-pill ' + stockStateClass(stockState) + '">' + esc(stockState) + '</span>'
        );
    }

    /** Colours a movement type so receipts and issues read apart at a glance. */
    function movementTypeClass(movementType) {
        var map = {
            Receipt: 'ok',
            Issue: 'info',
            Return: 'warn',
            Adjustment: 'neutral',
            'Write Off': 'danger',
            Transfer: 'info',
            'Stock Take': 'neutral'
        };
        return map[movementType] || 'neutral';
    }

    /** Builds a movement-type badge. */
    function movementTypeBadge(movementType) {
        if (!movementType) return '';
        return (
            '<span class="badge-pill ' + movementTypeClass(movementType) + '">' +
            esc(movementType) +
            '</span>'
        );
    }

    /** Renders a signed quantity in the direction it moved. */
    function quantityCell(row) {
        var quantity = Number(row.quantity);
        if (!isFinite(quantity)) return orDash('');

        var text = (quantity > 0 ? '+' : '') + quantity;
        return '<strong>' + esc(text) + '</strong>' + (row.unit_of_measure ? ' ' + esc(row.unit_of_measure) : '');
    }

    /** Renders the balance as a plain figure so the running total is readable. */
    function balanceCell(row) {
        if (row.balance_after === null || row.balance_after === undefined) return orDash('');
        return esc(String(row.balance_after));
    }

    /** Store location choices for the form. */
    function storeLocationOptions() {
        return stockMeta('store_locations', []);
    }

    /** Unit-of-measure choices for the form. */
    function stockUnitOptions() {
        return stockMeta('units_of_measure', ['Unit', 'Box', 'Pack', 'Set', 'Metre', 'Roll', 'Licence', 'Other']);
    }

    /** Asset choices for the store-card form. */
    function stockAssetOptions() {
        var list = (meta.stock && meta.stock.assets) || [];
        return [{ value: '', label: '-- no asset (consumable line) --' }].concat(
            list.map(function (a) {
                var label = a.asset_tag + ' - ' + (a.serial_number || a.asset_id);
                if (a.status && a.status !== 'In Stock') label += ' (' + a.status + ')';
                return { value: a.id, label: label };
            })
        );
    }

    /** Store-card choices for the movement forms. */
    function stockItemOptions() {
        var list = (meta.stock && meta.stock.stock_items) || [];
        return list.map(function (i) {
            return {
                value: i.id,
                label: (i.item_ref || '#' + i.id) + ' - ' + i.item_name +
                    ' (' + i.quantity_on_hand + ' ' + (i.unit_of_measure || 'Unit') + ' on hand)'
            };
        });
    }

    /** Custodian choices for the issue form. */
    function stockUserOptions() {
        var list = (meta.stock && meta.stock.users) || [];
        return [{ value: '', label: '-- type a name instead --' }].concat(
            list.map(function (u) {
                return { value: u.id, label: u.full_name + ' (' + u.role + ')' };
            })
        );
    }

    /**
     * The ICT Stock view: store balances (§5.7), the movement history and the
     * replenishment list, all behind one toolbar.
     */
    function renderStock() {
        var s = state.stock;

        el.view.innerHTML =
            '<div class="stat-grid" id="stkStats"><div class="stat"><div class="label">Loading</div><div class="value">&hellip;</div></div></div>' +

            '<div class="toolbar">' +
            '<div class="grow"><label class="field-label" for="stkSearch">Search</label>' +
            '<input type="text" id="stkSearch" placeholder="Reference, item, part code, store, asset..." value="' + esc(s.filters.search || '') + '"></div>' +

            '<div><label class="field-label" for="stkState">State</label>' +
            '<select id="stkState" style="min-width:150px;">' +
            ['', 'In Stock', 'Low Stock', 'Overstocked', 'Inactive', 'Discontinued']
                .map(function (v) {
                    return '<option value="' + esc(v) + '"' + (s.filters.state === v ? ' selected' : '') + '>' + (v || 'All states') + '</option>';
                })
                .join('') +
            '</select></div>' +

            '<div><label class="field-label" for="stkCategory">Category</label>' +
            '<input type="text" id="stkCategory" placeholder="e.g. Spares" value="' + esc(s.filters.category || '') + '" style="min-width:140px;"></div>' +

            '<div><label class="field-label" for="stkStore">Store</label>' +
            '<input type="text" id="stkStore" placeholder="e.g. Bulawayo" value="' + esc(s.filters.store_location || '') + '" style="min-width:140px;"></div>' +

            '<button class="btn btn-secondary" id="stkSearchBtn">Search</button>' +
            '<button class="btn btn-secondary" id="stkLowBtn">Low stock</button>' +
            '<button class="btn btn-secondary" id="stkLedgerBtn">Movement history</button>' +

            (can.write()
                ? '<button class="btn btn-primary" id="stkNewBtn">Open store card</button>'
                : '') +
            '</div>' +

            '<div id="stkBody"><p class="muted">Loading stock&hellip;</p></div>';

        loadStockStats();
        loadStock();

        var searchBox = document.getElementById('stkSearch');
        if (searchBox) {
            searchBox.addEventListener('keydown', function (e) {
                if (e.key === 'Enter') {
                    s.filters.search = searchBox.value;
                    s.offset = 0;
                    loadStock();
                }
            });
        }

        document.getElementById('stkSearchBtn').addEventListener('click', function () {
            s.filters.search = document.getElementById('stkSearch').value;
            s.filters.state = document.getElementById('stkState').value;
            s.filters.category = document.getElementById('stkCategory').value;
            s.filters.store_location = document.getElementById('stkStore').value;
            s.filters.low_stock = false;
            s.offset = 0;
            loadStock();
        });

        document.getElementById('stkLowBtn').addEventListener('click', function () {
            s.filters.low_stock = true;
            s.filters.state = 'Low Stock';
            s.offset = 0;
            loadStock();
        });

        document.getElementById('stkLedgerBtn').addEventListener('click', function () {
            openStockLedger();
        });

        var newBtn = document.getElementById('stkNewBtn');
        if (newBtn) newBtn.addEventListener('click', function () { openStockForm(); });
    }

    /** Columns for the store-card table. */
    function stockColumns() {
        return [
            {
                label: 'Item',
                render: function (r) {
                    var title = r.item_name || r.asset_tag || '(unnamed)';
                    var sub = r.item_ref || '';
                    if (r.source === 'asset_register') sub = 'register (no store card)';
                    return (
                        '<div><strong>' + esc(title) + '</strong></div>' +
                        (sub ? '<div class="hint">' + esc(sub) + '</div>' : '')
                    );
                }
            },
            {
                label: 'Asset',
                render: function (r) {
                    if (!r.asset_tag) return '<span class="hint">consumable</span>';
                    return (
                        esc(r.asset_tag) +
                        (r.serial_number ? '<div class="hint">' + esc(r.serial_number) + '</div>' : '')
                    );
                }
            },
            { label: 'Category', render: function (r) { return orDash(r.category); } },
            {
                label: 'Store / bin',
                render: function (r) {
                    return (
                        orDash(r.store_location) +
                        (r.bin_location ? '<div class="hint">bin ' + esc(r.bin_location) + '</div>' : '')
                    );
                }
            },
            {
                label: 'On hand',
                render: function (r) {
                    var text =
                        '<strong>' + esc(String(Number(r.quantity_on_hand))) + '</strong> ' +
                        esc(r.unit_of_measure || 'Unit');
                    if (Number(r.minimum_level) > 0) {
                        text += '<div class="hint">min ' + esc(String(r.minimum_level)) + '</div>';
                    }
                    return text;
                }
            },
            { label: 'State', render: function (r) { return stockBadge(r.stock_state); } },
            {
                label: 'Movements',
                render: function (r) {
                    if (r.source === 'asset_register') return '<span class="hint">&mdash;</span>';
                    var count = Number(r.movement_count) || 0;
                    if (!count) return '<span class="hint">none yet</span>';
                    return (
                        esc(String(count)) +
                        (r.last_movement_date
                            ? '<div class="hint">' + esc(day(r.last_movement_date)) + '</div>'
                            : '')
                    );
                }
            },
            {
                label: 'Actions',
                className: 'actions',
                render: function (r) {
                    var buttons =
                        '<button class="btn btn-secondary btn-sm" data-act="view" data-id="' +
                        esc(r.id) + '">View</button>';

                    if (can.write() && r.source !== 'asset_register') {
                        buttons +=
                            '<button class="btn btn-secondary btn-sm" data-act="receipt" data-id="' + esc(r.id) + '">Receipt</button>' +
                            '<button class="btn btn-secondary btn-sm" data-act="issue" data-id="' + esc(r.id) + '">Issue</button>' +
                            '<button class="btn btn-secondary btn-sm" data-act="return" data-id="' + esc(r.id) + '">Return</button>' +
                            '<button class="btn btn-secondary btn-sm" data-act="edit" data-id="' + esc(r.id) + '">Edit</button>';
                    }

                    if (can.admin() && r.source !== 'asset_register') {
                        buttons +=
                            '<button class="btn btn-secondary btn-sm" data-act="adjust" data-id="' + esc(r.id) + '">Adjust</button>';
                    }

                    return buttons;
                }
            }
        ];
    }

    /** Loads the balance tiles at the top of the ICT Stock view. */
    function loadStockStats() {
        if (!can.readAll()) {
            var blank = document.getElementById('stkStats');
            if (blank) blank.innerHTML = '';
            return;
        }

        Api.stock.getStats().then(
            function (stats) {
                var node = document.getElementById('stkStats');
                if (!node) return;

                var s = stats || {};
                node.innerHTML =
                    statTile('Store lines', s.total !== null && s.total !== undefined ? s.total : 0, 'catalogued cards', 'info') +
                    statTile('Units on hand', s.unitsOnHand !== null && s.unitsOnHand !== undefined ? s.unitsOnHand : 0) +
                    statTile('Stock value', money(s.stockValue || 0)) +
                    statTile('Low stock', s.lowStock !== null && s.lowStock !== undefined ? s.lowStock : 0, 'at or below minimum', 'warn') +
                    statTile('Overstocked', s.overstocked !== null && s.overstocked !== undefined ? s.overstocked : 0, 'above maximum') +
                    statTile('From register', s.derivedFromRegister !== null && s.derivedFromRegister !== undefined ? s.derivedFromRegister : 0, 'no store card yet');
            },
            function () {
                var node = document.getElementById('stkStats');
                if (node) node.innerHTML = '';
            }
        );
    }

    /** Loads the store-card table. */
    function loadStock() {
        var s = state.stock;
        var body = document.getElementById('stkBody');
        if (body) body.innerHTML = '<p class="muted">Loading stock&hellip;</p>';

        var query = {
            limit: s.limit,
            offset: s.offset,
            search: s.filters.search,
            category: s.filters.category,
            store_location: s.filters.store_location
        };

        // The state filter is a derived column, so 'Low Stock' maps onto the
        // dedicated filter rather than an ENUM status the API does not have.
        if (s.filters.low_stock || s.filters.state === 'Low Stock') query.low_stock = true;
        else if (s.filters.state) query.status = s.filters.state;

        Api.stock.list(query).then(
            function (data) {
                var node = document.getElementById('stkBody');
                if (!node) return;

                s.rows = (data && data.stock_items) || [];
                s.total = (data && data.total) || 0;

                node.innerHTML = table(s.rows, stockColumns(), {
                    empty: 'No stock items match those filters.'
                });

                bindPager(node, s, loadStock);
                bindStockRowActions(node);
            },
            function (error) {
                var node = document.getElementById('stkBody');
                if (node) node.innerHTML = '';
                showAlert(error.message || 'Could not load the store.', 'error');
            }
        );
    }

    /** Wires the per-row buttons on the store table. */
    function bindStockRowActions(container) {
        if (container.dataset.actionsBound === 'true') return;
        container.dataset.actionsBound = 'true';
        container.addEventListener('click', function (event) {
            var btn = event.target.closest('[data-act]');
            if (!btn) return;

            var id = btn.getAttribute('data-id');
            var act = btn.getAttribute('data-act');

            if (act === 'view') return openStockDetail(id);
            if (act === 'edit') return openStockForm(id);
            if (act === 'receipt') return openStockMovementForm('receipt', id);
            if (act === 'issue') return openStockMovementForm('issue', id);
            if (act === 'return') return openStockMovementForm('return', id);
            if (act === 'adjust') return openStockMovementForm('adjust', id);
            return undefined;
        });
    }

    /** Opens the read-only drawer for one store card, including its ledger. */
    function openStockDetail(id) {
        Api.stock.get(id).then(
            function (data) {
                var item = (data && data.stock_item) || null;
                if (!item) {
                    showAlert('That stock item could not be found.', 'error');
                    return;
                }

                var movements = (data && data.movements) || [];
                var readOnly = item.source === 'asset_register';
                var qty = Number(item.quantity_on_hand);

                var html = details([
                    { label: 'Item', value: item.item_name },
                    {
                        label: 'Reference',
                        html: item.item_ref
                            ? esc(item.item_ref)
                            : '<span class="hint">register-derived &mdash; no store card</span>'
                    },
                    { label: 'Category', value: item.category },
                    { label: 'Part code', value: item.part_code },
                    { label: 'Unit', value: item.unit_of_measure },
                    { label: 'Store', value: item.store_location },
                    { label: 'Bin', value: item.bin_location },
                    { label: 'Department', value: item.department },
                    { label: 'Asset', value: item.asset_tag || 'consumable line' },
                    { label: 'Serial', value: item.serial_number },
                    { label: 'Asset status', value: item.asset_status },
                    {
                        label: 'On hand',
                        html: '<strong>' + esc(String(qty)) + '</strong> ' +
                            esc(item.unit_of_measure || 'Unit')
                    },
                    { label: 'Minimum', value: item.minimum_level },
                    { label: 'Maximum', value: item.maximum_level },
                    { label: 'State', html: stockBadge(item.stock_state) },
                    {
                        label: 'Unit cost',
                        html: esc(money(item.unit_cost)) + ' ' + esc(item.currency || '')
                    },
                    {
                        label: 'Stock value',
                        html: esc(money(qty * Number(item.unit_cost || 0)))
                    },
                    { label: 'Supplier', value: item.supplier },
                    { label: 'Supplier contact', value: item.supplier_contact },
                    { label: 'Received', value: item.quantity_received },
                    { label: 'Issued', value: item.quantity_issued },
                    {
                        label: 'Last movement',
                        value: item.last_movement_date ? day(item.last_movement_date) : null
                    },
                    { label: 'Recorded by', value: item.created_by_name || item.created_by_username },
                    { label: 'Remarks', value: item.remarks, full: true }
                ]);

                openDetail(item.item_name || item.asset_tag || 'Stock item', html, true);

                // The ledger lives in its own modal so the drawer stays readable.
                if (movements.length) {
                    appendStockLedger(movements, item);
                }

                if (readOnly && can.write()) {
                    showAlert(
                        'This item comes from the asset register and has no store card yet. Use "Open store card" to catalogue it.',
                        'info'
                    );
                }
            },
            function (error) {
                showAlert(error.message || 'Could not load the stock item.', 'error');
            }
        );
    }

    /** Columns for a movement-history table. */
    function movementColumns(showItem) {
        var columns = [
            { label: 'Date', render: function (m) { return esc(day(m.movement_date)); } },
            { label: 'Ref', render: function (m) { return orDash(m.movement_ref); } }
        ];

        if (showItem) {
            columns.push({
                label: 'Item',
                render: function (m) {
                    return (
                        '<strong>' + esc(m.item_name || m.asset_tag || '(item)') + '</strong>' +
                        (m.item_ref ? '<div class="hint">' + esc(m.item_ref) + '</div>' : '')
                    );
                }
            });
        }

        columns.push(
            { label: 'Type', render: function (m) { return movementTypeBadge(m.movement_type); } },
            { label: 'Quantity', render: quantityCell },
            { label: 'Balance', render: balanceCell },
            {
                label: 'Party',
                render: function (m) {
                    return orDash(m.to_user_name || m.counterparty || m.to_department || m.to_location);
                }
            },
            { label: 'Reason', render: function (m) { return orDash(m.reason || m.reference); } },
            {
                label: 'Reversed',
                render: function (m) {
                    if (m.reversed_by) return '<span class="badge-pill neutral">reversed</span>';
                    if (m.reversed_movement_id) return '<span class="badge-pill info">reversal</span>';
                    return '<span class="hint">&mdash;</span>';
                }
            }
        );

        return columns;
    }

    /**
     * Appends the movement history to the open detail drawer and wires the
     * reversal buttons, which need the drawer's own click handling.
     */
    function appendStockLedger(movements, item) {
        var html =
            '<h4 style="margin:18px 0 8px;">Movement history</h4>' +
            table(movements, movementColumns(false), { empty: 'No movements recorded yet.' });

        var drawer = el.modalBody.querySelector('.detail-grid');
        if (drawer && drawer.parentNode) {
            var holder = document.createElement('div');
            holder.innerHTML = html;
            drawer.parentNode.appendChild(holder);

            holder.querySelectorAll('[data-rev]').forEach(function (btn) {
                btn.addEventListener('click', function () {
                    reverseStockMovementPrompt(btn.getAttribute('data-rev'), item);
                });
            });
        }
    }

    /** Prompts for a reason and reverses one movement. */
    function reverseStockMovementPrompt(movementId, item) {
        var reason = window.prompt('Why is this movement being reversed?', 'Posted in error.');
        if (reason === null) return;

        Api.stock.reverseMovement(movementId, { reason: reason }).then(
            function () {
                showAlert('Movement reversed successfully.', 'success');
                closeModal();
                loadStock();
                loadStockStats();
                refreshLowStockBadge();
            },
            function (error) {
                showAlert(error.message || 'Could not reverse the movement.', 'error');
            }
        );
    }

    /** Opens the whole-store movement history as its own modal. */
    function openStockLedger(filters) {
        state.stockLedger.filters = filters || {};

        var query = {
            limit: 25,
            offset: 0,
            movement_type: state.stockLedger.filters.movement_type
        };

        Api.stock.getMovements(query).then(
            function (data) {
                var rows = (data && data.movements) || [];

                openDetail(
                    'Stock movement history',
                    '<div id="stkLedgerBody">' +
                        table(rows, movementColumns(true), {
                            empty: 'No stock movements have been recorded yet.'
                        }) +
                        '</div>',
                    true
                );

                var body = el.modalBody;

                // A type filter is the one thing a store officer reaches for
                // most often, so it sits directly above the ledger.
                if (body) {
                    var holder = document.createElement('div');
                    holder.innerHTML =
                        '<div class="toolbar" style="margin-bottom:10px;">' +
                        '<div><label class="field-label" for="stkLedType">Movement type</label>' +
                        '<select id="stkLedType" style="min-width:170px;">' +
                        [''].concat(stockMeta('movement_types', []))
                            .map(function (v) {
                                return '<option value="' + esc(v) + '">' + (v || 'All types') + '</option>';
                            })
                            .join('') +
                        '</select></div>' +
                        '<button class="btn btn-secondary" id="stkLedFilter">Filter</button>' +
                        '</div>';
                    body.insertBefore(holder, body.firstChild);

                    document.getElementById('stkLedFilter').addEventListener('click', function () {
                        openStockLedger({
                            movement_type: document.getElementById('stkLedType').value
                        });
                    });
                }
            },
            function (error) {
                showAlert(error.message || 'Could not load the movement history.', 'error');
            }
        );
    }

    /**
     * Opens the store-card form for a new card, or the correction form for an
     * existing one.
     *
     * @param {string|number} [id] Existing card id / STK- reference. Omitted to
     *        open a new card.
     */
    function openStockForm(id) {
        var editing = id !== undefined && id !== null && id !== '';

        var load = editing
            ? Api.stock.get(id).then(function (data) { return (data && data.stock_item) || null; })
            : Promise.resolve(null);

        load.then(
            function (item) {
                if (editing && !item) {
                    showAlert('That stock item could not be found.', 'error');
                    return;
                }

                var existing = item || {};

                var fields = [
                    {
                        name: 'asset_id',
                        label: 'Asset',
                        type: 'select',
                        options: stockAssetOptions(),
                        value: existing.asset_id !== null && existing.asset_id !== undefined ? existing.asset_id : '',
                        full: true,
                        hint: editing
                            ? 'Changing the linked asset moves the whole store card.'
                            : 'Leave blank for a consumable line with no serialised asset.'
                    },
                    {
                        name: 'item_name',
                        label: 'Item name',
                        required: true,
                        value: existing.item_name || '',
                        placeholder: 'e.g. Spare laptop battery'
                    },
                    {
                        name: 'part_code',
                        label: 'Part code',
                        value: existing.part_code || '',
                        placeholder: "Supplier's own code"
                    },
                    {
                        name: 'category',
                        label: 'Category',
                        value: existing.category || '',
                        placeholder: 'e.g. Spares, Consumables'
                    },
                    {
                        name: 'unit_of_measure',
                        label: 'Unit of measure',
                        type: 'select',
                        options: stockUnitOptions(),
                        value: existing.unit_of_measure || 'Unit'
                    },
                    {
                        name: 'store_location',
                        label: 'Store',
                        type: 'select',
                        options: storeLocationOptions(),
                        value: existing.store_location || ''
                    },
                    {
                        name: 'bin_location',
                        label: 'Bin / shelf',
                        value: existing.bin_location || '',
                        placeholder: 'e.g. B12'
                    },
                    { name: 'department', label: 'Department', type: 'select', options: referenceOptions('departments', existing.department), value: existing.department || '' },
                    {
                        name: 'unit_cost',
                        label: 'Unit cost',
                        type: 'number',
                        min: 0,
                        step: '0.01',
                        value: existing.unit_cost !== null && existing.unit_cost !== undefined ? existing.unit_cost : ''
                    },
                    { name: 'currency', label: 'Currency', value: existing.currency || 'USD' },
                    { name: 'supplier', label: 'Supplier', value: existing.supplier || '' },
                    {
                        name: 'supplier_contact',
                        label: 'Supplier contact',
                        value: existing.supplier_contact || ''
                    },
                    {
                        name: 'minimum_level',
                        label: 'Minimum level',
                        type: 'number',
                        min: 0,
                        hint: 'Replenishment threshold. 0 disables the low-stock alert.',
                        value: existing.minimum_level !== null && existing.minimum_level !== undefined ? existing.minimum_level : 0
                    },
                    {
                        name: 'maximum_level',
                        label: 'Maximum level',
                        type: 'number',
                        min: 0,
                        value: existing.maximum_level !== null && existing.maximum_level !== undefined ? existing.maximum_level : ''
                    },
                    {
                        name: 'status',
                        label: 'Status',
                        type: 'select',
                        options: stockMeta('statuses', ['Active', 'Inactive', 'Discontinued']),
                        value: existing.status || 'Active'
                    },
                    {
                        name: 'remarks',
                        label: 'Remarks',
                        type: 'textarea',
                        rows: 3,
                        full: true,
                        value: existing.remarks || ''
                    }
                ];

                finishStockForm(existing, fields, editing);
            },
            function (error) {
                showAlert(error.message || 'Could not load the stock item.', 'error');
            }
        );
    }

    /**
     * Adds the opening-quantity field, opens the modal and wires the submit.
     *
     * @param {object} existing The card being edited, or `{}` for a new one.
     * @param {Array} fields The field descriptors built by openStockForm.
     * @param {boolean} editing
     */
    function finishStockForm(existing, fields, editing) {
        // An opening quantity is only offered when the card is being opened:
        // afterwards the balance only moves through the ledger.
        if (!editing) {
            fields.splice(11, 0, {
                name: 'quantity_on_hand',
                label: 'Opening quantity',
                type: 'number',
                min: 0,
                hint: 'Recorded in the ledger as a Receipt so the card has a history from day one.'
            });
        }

        openForm({
            title: editing
                ? 'Correct store card ' + (existing.item_ref || '')
                : 'Open a store card',
            fields: fields,
            submitLabel: editing ? 'Save changes' : 'Open card',
            wide: true,
            successMessage: editing
                ? 'Store card updated successfully.'
                : 'Store card opened successfully.',
            onSubmit: function (params) {
                var payload = params.values;

                // An empty select must be sent as null so the API stores a true
                // NULL rather than the literal string.
                ['asset_id', 'minimum_level', 'maximum_level', 'unit_cost'].forEach(
                    function (key) {
                        if (payload[key] === '' || payload[key] === undefined) {
                            payload[key] = null;
                        }
                    }
                );

                var action = editing
                    ? Api.stock.update(existing.id, payload)
                    : Api.stock.create(payload);

                return action.then(function () {
                    loadStock();
                    loadStockStats();
                    refreshLowStockBadge();
                });
            }
        });
    }

    /** Per-endpoint wording for the four stock movement forms. */
    var STOCK_MOVEMENT_FORMS = {
        receipt: {
            title: 'Record stock received',
            submit: 'Record receipt',
            quantityLabel: 'Quantity received',
            quantityHint: 'Added to the balance and written to the ledger as a Receipt.',
            prompt: 'The quantity received must be a whole number greater than zero.'
        },
        issue: {
            title: 'Record stock issued',
            submit: 'Record issue',
            quantityLabel: 'Quantity issued',
            quantityHint: 'Taken off the balance. The store cannot go negative.',
            prompt: 'The quantity issued must be a whole number greater than zero.'
        },
        return: {
            title: 'Record stock returned',
            submit: 'Record return',
            quantityLabel: 'Quantity returned',
            quantityHint: 'Put back on the balance as a Return.',
            prompt: 'The quantity returned must be a whole number greater than zero.'
        },
        adjust: {
            title: 'Adjust the stock balance',
            submit: 'Record adjustment',
            quantityLabel: 'Adjustment (a minus reduces the balance)',
            quantityHint: 'A stock-take or write-off. A reason is mandatory.',
            prompt: 'The adjustment must be a whole number other than zero.'
        }
    };

    /**
     * Builds the field list for one movement form.
     *
     * @param {string} kind One of receipt / issue / return / adjust.
     * @param {object} item The store card being moved.
     * @returns {Array}
     */
    function stockMovementFields(kind, item) {
        var config = STOCK_MOVEMENT_FORMS[kind];

        var fields = [
            {
                name: 'quantity',
                label: config.quantityLabel,
                type: 'number',
                required: true,
                step: 1,
                hint: config.quantityHint
            },
            { name: 'movement_date', label: 'Movement date', type: 'date', value: today() }
        ];

        // A movement out of the store has to name who received it, so the ledger
        // can answer "who has this?" without joining the assignment table.
        if (kind === 'issue') {
            fields.push({
                name: 'to_user_id',
                label: 'Issued to (custodian)',
                type: 'select',
                options: stockUserOptions(),
                full: true
            });
            fields.push({
                name: 'to_user_name',
                label: 'or recipient name',
                placeholder: 'Used when the custodian has no account'
            });
            fields.push({
                name: 'to_department',
                label: 'Department',
                type: 'select',
                options: referenceOptions('departments', item.department),
                value: item.department || ''
            });
            fields.push({
                name: 'to_location',
                label: 'Location',
                type: 'select',
                options: referenceOptions('locations')
            });
            fields.push({
                name: 'condition_status',
                label: 'Condition on issue',
                type: 'select',
                options: stockMeta('condition_statuses', ['Good', 'Fair', 'Damaged', 'Obsolete']),
                value: 'Good'
            });
        }

        if (kind === 'return') {
            fields.push({
                name: 'condition_status',
                label: 'Condition on return',
                type: 'select',
                options: stockMeta('condition_statuses', ['Good', 'Fair', 'Damaged', 'Obsolete']),
                value: 'Good'
            });
            fields.push({ name: 'to_user_name', label: 'Returned by' });
        }

        if (kind === 'receipt') {
            fields.push({ name: 'counterparty', label: 'Supplier', value: item.supplier || '' });
            fields.push({
                name: 'unit_cost',
                label: 'Unit cost',
                type: 'number',
                min: 0,
                step: '0.01',
                value: item.unit_cost !== null && item.unit_cost !== undefined ? item.unit_cost : ''
            });
        }

        if (kind === 'adjust') {
            fields.push({
                name: 'movement_type',
                label: 'Adjustment type',
                type: 'select',
                options: ['Adjustment', 'Stock Take', 'Write Off', 'Transfer'],
                value: 'Adjustment'
            });
        }

        fields.push({
            name: 'reference',
            label: 'Reference',
            placeholder: 'Invoice, issue slip or stock-take sheet number'
        });
        fields.push({
            name: 'reason',
            label: kind === 'adjust' ? 'Reason (required)' : 'Reason',
            required: kind === 'adjust',
            full: true,
            placeholder: kind === 'adjust'
                ? 'e.g. Stock take on 30 June found three additional units'
                : undefined
        });
        fields.push({ name: 'remarks', label: 'Remarks', type: 'textarea', rows: 2, full: true });

        return fields;
    }

    /**
     * Opens the form for one of the stock movement endpoints (§5.7).
     *
     * @param {string} kind One of 'receipt', 'issue', 'return', 'adjust'.
     * @param {string|number} id The store card being moved.
     */
    function openStockMovementForm(kind, id) {
        var config = STOCK_MOVEMENT_FORMS[kind];
        if (!config) return;

        Api.stock.get(id).then(
            function (data) {
                var item = (data && data.stock_item) || null;
                if (!item) {
                    showAlert('That stock item could not be found.', 'error');
                    return;
                }

                var onHand = Number(item.quantity_on_hand);
                var unit = item.unit_of_measure || 'Unit';

                openForm({
                    title: config.title + ' - ' + (item.item_ref || item.item_name),
                    fields: stockMovementFields(kind, item),
                    submitLabel: config.submit,
                    wide: true,
                    successMessage: config.title + ' recorded successfully.',
                    onSubmit: function (params) {
                        var payload = params.values;

                        if (
                            payload.quantity === null ||
                            payload.quantity === '' ||
                            payload.quantity === undefined
                        ) {
                            showAlert(config.prompt, 'error');
                            return Promise.reject(new Error(config.prompt));
                        }

                        if (
                            kind === 'issue' &&
                            !payload.to_user_id &&
                            !payload.to_user_name &&
                            !payload.to_department &&
                            !payload.to_location
                        ) {
                            var message =
                                'State who the stock was issued to (a custodian, department or location).';
                            showAlert(message, 'error');
                            return Promise.reject(new Error(message));
                        }

                        if (payload.to_user_id === '') delete payload.to_user_id;
                        if (payload.unit_cost === '' || payload.unit_cost === undefined) {
                            payload.unit_cost = null;
                        }

                        var action;
                        if (kind === 'receipt') action = Api.stock.receipt(item.id, payload);
                        else if (kind === 'issue') action = Api.stock.issue(item.id, payload);
                        else if (kind === 'return') action = Api.stock.returnStock(item.id, payload);
                        else action = Api.stock.adjust(item.id, payload);

                        return action.then(function () {
                            loadStock();
                            loadStockStats();
                            refreshLowStockBadge();
                        });
                    }
                });

                showAlert(
                    'Store card ' + (item.item_ref || '') + ' currently holds ' + onHand + ' ' +
                        unit + '(s).',
                    'info'
                );
            },
            function (error) {
                showAlert(error.message || 'Could not load the stock item.', 'error');
            }
        );
    }


    /* ======================================================================
     * Bootstrap
     * ==================================================================== */

    showLoading('Loading your account...');

    initWorkspaceSettings();

    Api.getMe().then(function (user) {
            if (!user || !RIGHTS[user.role]) {
                throw new Error('Your account role could not be verified. Sign in again or contact the System Administrator.');
            }
            state.user = user;
            paintUser();
            if (el.usersNav && el.adminNavSection) {
                el.usersNav.hidden = !can.systemAdmin();
                if (el.referenceDataNav) el.referenceDataNav.hidden = !can.admin();
                if (el.procurementNav) el.procurementNav.hidden = !can.readAll();
                el.adminNavSection.hidden = !can.admin();
            }
            if (user.must_change_password) {
                renderForcedPasswordChange();
                return null;
            }
            showLoading('Loading reference data...');
            return loadReferenceData();
        }).then(function () {
            if (!state.user || state.user.must_change_password) return;
            navigate('dashboard');
            refreshOpenBadge();
            refreshExpiringBadge();
            refreshLowStockBadge();
        }).catch(function (error) {
            state.user = null;
            el.userRole.textContent = 'Permissions unavailable';
            el.view.innerHTML =
                '<div class="card"><div class="card-body">Could not load your account permissions: ' +
                esc(error.message) + '</div></div>';
        });

    function renderForcedPasswordChange() {
        el.viewTitle.textContent = 'Change temporary password';
        el.view.innerHTML =
            '<div class="card password-required"><div class="card-head"><h3>Set a new password</h3></div>' +
            '<div class="card-body"><p>Your administrator issued a temporary password. Change it before using the system.</p>' +
            '<form id="requiredPasswordForm" class="form-grid">' +
            '<div class="field-wrap"><label class="field-label" for="requiredCurrentPassword">Temporary password</label>' +
            '<input id="requiredCurrentPassword" type="password" autocomplete="current-password" required></div>' +
            '<div class="field-wrap"><label class="field-label" for="requiredNewPassword">New password</label>' +
            '<input id="requiredNewPassword" type="password" autocomplete="new-password" minlength="8" required>' +
            passwordRequirementsMarkup('requiredNewPasswordRequirements') + '</div>' +
            '<div class="field-wrap"><label class="field-label" for="requiredConfirmPassword">Confirm new password</label>' +
            '<input id="requiredConfirmPassword" type="password" autocomplete="new-password" minlength="8" required></div>' +
            '<div class="span-all"><button class="btn btn-primary" id="requiredPasswordSubmit">Change password</button></div>' +
            '</form></div></div>';
        document.getElementById('requiredPasswordForm').addEventListener('submit', function (event) {
            event.preventDefault();
            var button = document.getElementById('requiredPasswordSubmit');
            var current = document.getElementById('requiredCurrentPassword').value;
            var next = document.getElementById('requiredNewPassword').value;
            var confirm = document.getElementById('requiredConfirmPassword').value;
            var requirementErrors = passwordRequirementErrors(next);
            if (requirementErrors.length) {
                showAlert(requirementErrors[0], 'error');
                document.getElementById('requiredNewPassword').focus();
                return;
            }
            if (next !== confirm) {
                showAlert('The new password and confirmation do not match.', 'error');
                return;
            }
            button.disabled = true;
            Api.changePassword(current, next, confirm).then(function () {
                showAlert('Password changed. Please sign in again with your new password.', 'success');
                window.setTimeout(function () { window.location.replace('/login.html'); }, 900);
            }).catch(function (error) {
                button.disabled = false;
                showAlert(error.message || 'Could not change your password.', 'error');
            });
        });
        bindPasswordRequirements(
            document.getElementById('requiredNewPassword'),
            document.getElementById('requiredNewPasswordRequirements')
        );
    }

    function renderUsers() {
        if (!can.systemAdmin()) {
            el.view.innerHTML = '<div class="empty">User administration is restricted to System Administrators.</div>';
            return;
        }
        var s = state.users;
        el.view.innerHTML =
            '<div class="toolbar"><div class="grow"><label class="field-label" for="userSearch">Find users</label>' +
            '<input id="userSearch" value="' + esc(s.filters.search || '') + '" placeholder="Name, username or email"></div>' +
            '<div><label class="field-label" for="userRoleFilter">Role</label><select id="userRoleFilter">' +
            ['', 'System Administrator', 'HISO', 'ICT Officer', 'Departmental User', 'Auditor'].map(function (role) {
                return '<option value="' + esc(role) + '"' +
                    (s.filters.role === role ? ' selected' : '') + '>' + (role || 'All roles') + '</option>';
            }).join('') + '</select></div>' +
            '<button class="btn btn-secondary" id="userSearchBtn">Search</button>' +
            '<button class="btn btn-primary" id="userCreateBtn">+ Create account</button></div>' +
            '<div class="card"><div id="usersTable"></div></div>';

        document.getElementById('userSearchBtn').addEventListener('click', function () {
            s.filters.search = document.getElementById('userSearch').value.trim();
            s.filters.role = document.getElementById('userRoleFilter').value;
            s.offset = 0;
            loadUsers();
        });
        document.getElementById('userSearch').addEventListener('keydown', function (event) {
            if (event.key === 'Enter') document.getElementById('userSearchBtn').click();
        });
        document.getElementById('userCreateBtn').addEventListener('click', openCreateUserForm);
        loadUsers();
    }

    function loadUsers() {
        var s = state.users;
        var container = document.getElementById('usersTable');
        if (!container) return;
        container.innerHTML = '<div class="loading"><span class="spinner-dark"></span>Loading user accounts...</div>';
        Api.getUsers(Object.assign({}, s.filters, { limit: s.limit, offset: s.offset })).then(function (data) {
            s.rows = data.users || [];
            s.total = data.pagination.total || 0;
            container.innerHTML = table(s.rows, [
                { label: 'Name', render: function (user) { return '<strong>' + esc(user.full_name) + '</strong><div class="muted">' + esc(user.username) + '</div>'; } },
                { label: 'Email', key: 'email' },
                { label: 'Role', key: 'role' },
                { label: 'Status', render: function (user) { return badge(user.is_active ? 'Active' : 'Disabled'); } },
                { label: 'First login', render: function (user) { return user.must_change_password ? badge('Password change required') : '<span class="muted">Complete</span>'; } },
                {
                    label: 'Actions',
                    className: 'actions',
                    render: function (user) {
                        var actions = '<button class="btn btn-sm btn-secondary" data-user-edit="' +
                            esc(user.id) + '">Edit</button>' +
                            '<button class="btn btn-sm btn-warn" data-user-reset="' +
                            esc(user.id) + '">Reset password</button>';
                        if (Number(user.id) !== Number(state.user.id)) {
                            actions += user.is_active
                                ? '<button class="btn btn-sm btn-danger" data-user-disable="' + esc(user.id) + '">Disable</button>'
                                : '<button class="btn btn-sm btn-primary" data-user-enable="' + esc(user.id) + '">Enable</button>';
                        }
                        return actions;
                    }
                }
            ], {
                empty: 'No accounts match the selected filters.',
                total: s.total,
                pager: { offset: s.offset, limit: s.limit }
            });
            bindPager(container, s, loadUsers);
            container.querySelectorAll('[data-user-edit]').forEach(function (button) {
                button.addEventListener('click', function () {
                    var user = s.rows.find(function (row) { return String(row.id) === button.dataset.userEdit; });
                    if (user) openEditUserForm(user);
                });
            });
            container.querySelectorAll('[data-user-reset]').forEach(function (button) {
                button.addEventListener('click', function () {
                    var user = s.rows.find(function (row) { return String(row.id) === button.dataset.userReset; });
                    if (user) openResetUserPasswordForm(user);
                });
            });
            container.querySelectorAll('[data-user-disable]').forEach(function (button) {
                button.addEventListener('click', function () {
                    var user = s.rows.find(function (row) { return String(row.id) === button.dataset.userDisable; });
                    if (!user || !window.confirm('Disable ' + user.full_name + '\'s account?')) return;
                    button.disabled = true;
                    Api.deleteUser(user.id).then(function () {
                        showAlert('Account disabled.', 'success');
                        loadUsers();
                    }).catch(function (error) {
                        button.disabled = false;
                        showAlert(error.message || 'Could not disable this account.', 'error');
                    });
                });
            });
            container.querySelectorAll('[data-user-enable]').forEach(function (button) {
                button.addEventListener('click', function () {
                    button.disabled = true;
                    Api.activateUser(button.dataset.userEnable).then(function () {
                        showAlert('Account enabled.', 'success');
                        loadUsers();
                    }).catch(function (error) {
                        button.disabled = false;
                        showAlert(error.message || 'Could not enable this account.', 'error');
                    });
                });
            });
        }).catch(function (error) {
            container.innerHTML = '<div class="empty">Could not load accounts: ' + esc(error.message) + '</div>';
        });
    }

    function renderReferenceData() {
        if (!can.admin()) {
            el.view.innerHTML = '<div class="empty">Department and location management is restricted to System Administrators and HISO.</div>';
            return;
        }
        if (meta.referenceDataError) {
            el.view.innerHTML = '<div class="card dashboard-error"><div class="card-body">Could not load managed departments and locations: ' +
                esc(meta.referenceDataError.message || 'Request failed.') + '</div></div>';
            return;
        }
        var data = meta.referenceData || { departments: [], locations: [] };
        el.view.innerHTML =
            '<div class="dashboard-intro"><div><h3>Departments &amp; locations</h3>' +
            '<p>Manage the approved values used across the asset register and operational workflows. Existing asset values are retained.</p></div>' +
            '<button class="btn btn-primary" id="referenceAddDepartment">+ Add department</button></div>' +
            '<div class="dashboard-panels reference-panels">' +
            '<section class="card dashboard-panel"><div class="card-head"><div><h3>Departments</h3></div>' +
            '<button class="btn btn-primary btn-sm" data-reference-add="departments">+ Add</button></div><div id="referenceDepartments"></div></section>' +
            '<section class="card dashboard-panel"><div class="card-head"><div><h3>Locations</h3></div>' +
            '<button class="btn btn-primary btn-sm" data-reference-add="locations">+ Add</button></div><div id="referenceLocations"></div></section>' +
            '</div>';

        document.getElementById('referenceAddDepartment').addEventListener('click', function () {
            openReferenceValueForm('departments');
        });
        el.view.querySelectorAll('[data-reference-add]').forEach(function (button) {
            button.addEventListener('click', function () {
                openReferenceValueForm(button.dataset.referenceAdd);
            });
        });
        renderReferenceTable('departments', data.departments || []);
        renderReferenceTable('locations', data.locations || []);
    }

    function renderReferenceTable(type, rows) {
        var container = document.getElementById(type === 'departments' ? 'referenceDepartments' : 'referenceLocations');
        if (!container) return;
        container.innerHTML = table(rows, [
            { label: 'Name', render: function (row) { return '<strong>' + esc(row.name) + '</strong>'; } },
            { label: 'Status', render: function (row) { return badge(Number(row.is_active) === 1 ? 'Active' : 'Inactive'); } },
            {
                label: 'Actions',
                className: 'actions',
                render: function (row) {
                    var active = Number(row.is_active) === 1;
                    return '<button class="btn btn-sm ' + (active ? 'btn-danger' : 'btn-secondary') +
                        '" data-reference-status="' + esc(row.id) + '" data-active="' + (active ? 'false' : 'true') +
                        '">' + (active ? 'Deactivate' : 'Reactivate') + '</button>';
                }
            }
        ], { empty: 'No ' + type + ' have been added.' });

        container.querySelectorAll('[data-reference-status]').forEach(function (button) {
            button.addEventListener('click', function () {
                button.disabled = true;
                Api.referenceData.setActive(type, button.dataset.referenceStatus, button.dataset.active === 'true')
                    .then(function () {
                        return Api.referenceData.list();
                    })
                    .then(function (data) {
                        meta.referenceData = data;
                        meta.referenceDataError = null;
                        renderReferenceData();
                    })
                    .catch(function (error) {
                        button.disabled = false;
                        showAlert(error.message || 'Could not update the reference value.', 'error');
                    });
            });
        });
    }

    function openReferenceValueForm(type) {
        var label = type === 'departments' ? 'department' : 'location';
        openForm({
            title: 'Add ' + label,
            fields: [{ name: 'name', label: label.charAt(0).toUpperCase() + label.slice(1), required: true, max: 100 }],
            onSubmit: function (form) {
                return Api.referenceData.create(type, form.values.name.trim()).then(function () {
                    return Api.referenceData.list();
                }).then(function (data) {
                    meta.referenceData = data;
                    meta.referenceDataError = null;
                    renderReferenceData();
                });
            }
        });
    }

    function openCreateUserForm() {
        openForm({
            title: 'Create user account',
            submitLabel: 'Create account',
            successMessage: 'Account created. Give the user their temporary password; they will be required to change it on first login.',
            fields: [
                { name: 'full_name', label: 'Full name', required: true },
                { name: 'username', label: 'Username', required: true },
                { name: 'email', label: 'Email address', type: 'email', required: true },
                { name: 'role', label: 'Role', type: 'select', required: true, options: ['HISO', 'ICT Officer', 'Departmental User', 'Auditor'] },
                { name: 'password', label: 'Temporary password', type: 'password', required: true, passwordPolicy: true },
                { name: 'must_change_password', label: 'Require password change at first login', type: 'checkbox', value: true },
                { name: 'is_active', label: 'Create account as active', type: 'checkbox', value: true }
            ],
            onSubmit: function (form) {
                return Api.register(form.values).then(function () { loadUsers(); });
            }
        });
    }

    function openEditUserForm(user) {
        openForm({
            title: 'Edit account: ' + user.username,
            submitLabel: 'Save account',
            successMessage: 'Account updated.',
            fields: [
                { name: 'full_name', label: 'Full name', required: true, value: user.full_name },
                { name: 'username', label: 'Username', required: true, value: user.username },
                { name: 'email', label: 'Email address', type: 'email', required: true, value: user.email },
                { name: 'role', label: 'Role', type: 'select', required: true, options: ['System Administrator', 'HISO', 'ICT Officer', 'Departmental User', 'Auditor'], value: user.role }
            ],
            onSubmit: function (form) {
                return Api.updateUser(user.id, form.values).then(function () { loadUsers(); });
            }
        });
    }

    function openResetUserPasswordForm(user) {
        openForm({
            title: 'Reset password: ' + user.username,
            submitLabel: 'Set temporary password',
            successMessage: 'Password reset. The user must change it at their next login.',
            fields: [
                { name: 'password', label: 'Temporary password', type: 'password', required: true, passwordPolicy: true },
                { name: 'confirm_password', label: 'Confirm temporary password', type: 'password', required: true }
            ],
            onSubmit: function (form) {
                if (form.values.password !== form.values.confirm_password) {
                    return Promise.reject(new Error('The password and confirmation do not match.'));
                }
                return Api.resetUserPassword(
                    user.id,
                    form.values.password,
                    form.values.confirm_password
                ).then(function () {
                    loadUsers();
                });
            }
        });
    }



    function renderWarranty() {
        var s = state.warranty;

        el.view.innerHTML =
            '<div class="stat-grid" id="wtyStats"><div class="stat"><div class="label">Loading</div><div class="value">&hellip;</div></div></div>' +
            '<div class="toolbar">' +
            '<div class="grow"><label class="field-label" for="wtySearch">Search</label>' +
            '<input type="text" id="wtySearch" placeholder="Reference, provider, contract ref, asset..." value="' + esc(s.filters.search || '') + '"></div>' +

            '<div><label class="field-label" for="wtyStatus">Status</label>' +
            '<select id="wtyStatus" style="min-width:150px;">' +
            ['', 'Active', 'Expiring Soon', 'Expired', 'Cancelled']
                .map(function (v) {
                    return '<option value="' + esc(v) + '"' + (s.filters.status === v ? ' selected' : '') + '>' + (v || 'All statuses') + '</option>';
                })
                .join('') +
            '</select></div>' +

            '<div><label class="field-label" for="wtyType">Type</label>' +
            '<select id="wtyType" style="min-width:180px;">' +
            [''].concat(warrantyTypeOptions())
                .map(function (v) {
                    return '<option value="' + esc(v) + '"' + (s.filters.warranty_type === v ? ' selected' : '') + '>' + (v || 'All types') + '</option>';
                })
                .join('') +
            '</select></div>' +

            '<div><label class="field-label" for="wtyWindow">Expiring within</label>' +
            '<select id="wtyWindow" style="min-width:150px;">' +
            [[0, 'Any time'], [30, '30 days'], [60, '60 days'], [90, '90 days'], [180, '6 months'], [365, '12 months']]
                .map(function (pair) {
                    return '<option value="' + pair[0] + '"' + (String(s.filters.expiring_days) === String(pair[0]) ? ' selected' : '') + '>' + pair[1] + '</option>';
                })
                .join('') +
            '</select></div>' +

            '<button class="btn btn-secondary" id="wtySearchBtn">Search</button>' +
            '<button class="btn btn-secondary" id="wtyExpiringBtn">Expiry alerts</button>' +
            '<button class="btn btn-secondary" id="wtyContractsBtn">Contracts</button>' +
            (can.write() ? '<button class="btn btn-primary" id="wtyNewBtn">+ Record warranty</button>' : '') +
            '</div>' +
            '<div class="card"><div id="wtyTable"></div></div>';

        document.getElementById('wtySearchBtn').addEventListener('click', function () {
            s.filters.search = document.getElementById('wtySearch').value.trim();
            s.filters.status = document.getElementById('wtyStatus').value;
            s.filters.warranty_type = document.getElementById('wtyType').value;

            // 0 in the window picker means "do not filter by expiry".
            var window = document.getElementById('wtyWindow').value;
            delete s.filters.expiring_days;
            if (window && Number(window) > 0) s.filters.expiring_days = Number(window);

            s.offset = 0;
            loadWarranty();
        });

        document.getElementById('wtySearch').addEventListener('keydown', function (e) {
            if (e.key === 'Enter') document.getElementById('wtySearchBtn').click();
        });

        document.getElementById('wtyExpiringBtn').addEventListener('click', loadExpiringWarranty);
        document.getElementById('wtyContractsBtn').addEventListener('click', loadContracts);

        var newBtn = document.getElementById('wtyNewBtn');
        if (newBtn) newBtn.addEventListener('click', function () { openWarrantyForm({}); });

        loadWarrantyStats();
        loadWarranty();
    }



    /**
     * Builds the warranty row columns - shared by the list, the expiry-alert
     * quick filter and the contracts quick filter so all three look identical.
     */
    function warrantyColumns() {
        return [
            {
                label: 'Reference',
                render: function (r) {
                    var ref = r.warranty_ref
                        ? '<strong>' + esc(r.warranty_ref) + '</strong>'
                        : '<em class="muted">no reference</em>';
                    var source = r.source === 'asset_register'
                        ? '<span class="badge-pill info">from register</span>'
                        : '';
                    return ref + ' ' + source;
                }
            },
            {
                label: 'Cover',
                render: function (r) {
                    return orDash(r.title || r.warranty_type) +
                        '<div class="muted" style="font-size:12px;">' + orDash(r.warranty_type) + '</div>';
                }
            },
            {
                label: 'Asset',
                render: function (r) {
                    if (!r.asset_tag) {
                        return '<em class="muted">Site-wide contract</em>';
                    }
                    return orDash(r.asset_tag) +
                        '<div class="muted" style="font-size:12px;">' + orDash(r.asset_code) + '</div>';
                }
            },
            {
                label: 'Provider',
                render: function (r) {
                    return orDash(r.provider) +
                        '<div class="muted" style="font-size:12px;">' + orDash(r.provider_contact) + '</div>';
                }
            },
            {
                label: 'Period',
                className: 'nowrap',
                render: function (r) {
                    return orDash(day(r.start_date)) +
                        '<div class="muted" style="font-size:12px;">to ' + orDash(day(r.expiry_date)) + '</div>';
                }
            },
            { label: 'Remaining', className: 'nowrap', render: remainingCell },
            { label: 'Value', className: 'num', render: function (r) { return money(r.contract_value); } },
            { label: 'Status', render: function (r) { return coverageBadge(r.status); } },
            {
                label: 'Actions',
                className: 'actions',
                render: function (r) {
                    var html =
                        '<button class="btn btn-sm btn-secondary" data-wty-view="' + esc(r.id) + '">View</button> ';

                    // Register-derived rows are read-only snapshots of the asset.
                    if (r.source === 'asset_register') {
                        if (can.write() && r.asset_id) {
                            html += '<button class="btn btn-sm btn-secondary" data-wty-record="' +
                                esc(r.asset_id) + '">Add cover</button>';
                        }
                        return html;
                    }

                    if (can.write() && r.status !== 'Cancelled') {
                        html += '<button class="btn btn-sm btn-primary" data-wty-renew="' + esc(r.id) + '">Renew</button> ';
                        html += '<button class="btn btn-sm btn-secondary" data-wty-edit="' + esc(r.id) + '">Edit</button> ';
                    }
                    if (can.admin() && r.status !== 'Cancelled') {
                        html += '<button class="btn btn-sm btn-danger" data-wty-cancel="' + esc(r.id) + '">Cancel</button>';
                    }
                    return html;
                }
            }
        ];
    }

    function loadWarrantyStats() {
        var container = document.getElementById('wtyStats');
        if (!container) return;

        Api.warranties.getStats().then(
            function (stats) {
                var soon = (stats.expiringSoon || 0) + (stats.derivedExpiringSoon || 0);
                var expired = (stats.expired || 0) + (stats.derivedExpired || 0);
                var registerCover = stats.derivedFromRegister || 0;

                container.innerHTML =
                    statTile('Active cover', (stats.active || 0) + (stats.derivedActive || 0), null, 'ok') +
                    statTile('Expiring soon', soon, null, 'warn') +
                    statTile('Expired', expired, null, 'danger') +
                    statTile('Contracts', stats.byType
                        ? stats.byType.reduce(function (sum, row) {
                            return ['Support Contract', 'Maintenance Contract', 'Service Level Agreement', 'Licence Support']
                                .indexOf(row.warranty_type) !== -1
                                ? sum + Number(row.total || 0)
                                : sum;
                        }, 0)
                        : 0) +
                    statTile('On the register', registerCover, 'no separate record yet', 'info') +
                    statTile('Total value', money(stats.totalValue));

                refreshExpiringBadge();
            },
            function () {
                container.innerHTML = '';
            }
        );
    }


    function loadWarranty() {
        var s = state.warranty;
        var container = document.getElementById('wtyTable');
        if (!container) return;

        container.innerHTML = '<div class="loading"><span class="spinner-dark"></span>Loading warranties...</div>';

        var filters = Object.assign({}, s.filters, { limit: s.limit, offset: s.offset });

        Api.warranties.list(filters).then(
            function (data) {
                s.rows = (data && data.warranties) || [];
                s.total = (data && data.total) || 0;

                container.innerHTML = table(s.rows, warrantyColumns(), {
                    empty: 'No warranties or contracts matched.',
                    total: s.total,
                    pager: { offset: s.offset, limit: s.limit }
                });

                bindPager(container, s, loadWarranty);
                bindWarrantyRowActions(container, s);
            },
            function (error) {
                container.innerHTML = '<div class="empty">Could not load warranties: ' + esc(error.message) + '</div>';
            }
        );
    }

    /** Quick filter: every warranty inside the alert window (§5.6). */
    function loadExpiringWarranty() {
        var container = document.getElementById('wtyTable');
        if (!container) return;

        var days = state.warranty.filters.expiring_days || 90;

        container.innerHTML = '<div class="loading"><span class="spinner-dark"></span>Loading expiry alerts...</div>';

        Api.warranties.getExpiring({ days: days }).then(
            function (data) {
                var rows = (data && data.warranties) || [];
                container.innerHTML =
                    '<div class="card-head"><h3>Expiring within ' + esc(data.expiring_days || days) + ' days</h3></div>' +
                    table(rows, warrantyColumns(), {
                        empty: 'Nothing expires in the next ' + esc(days) + ' days. Good news.'
                    });
                bindWarrantyRowActions(container, { rows: rows });
            },
            function (error) {
                container.innerHTML = '<div class="empty">Could not load expiry alerts: ' + esc(error.message) + '</div>';
            }
        );
    }

    /** Quick filter: the support and maintenance contracts (§5.6). */
    function loadContracts() {
        var container = document.getElementById('wtyTable');
        if (!container) return;

        container.innerHTML = '<div class="loading"><span class="spinner-dark"></span>Loading contracts...</div>';

        Api.warranties.getContracts().then(
            function (data) {
                var rows = (data && data.warranties) || [];
                container.innerHTML =
                    '<div class="card-head"><h3>Support and maintenance contracts</h3></div>' +
                    table(rows, warrantyColumns(), {
                        empty: 'No supplier contracts are currently in force.'
                    });
                bindWarrantyRowActions(container, { rows: rows });
            },
            function (error) {
                container.innerHTML = '<div class="empty">Could not load contracts: ' + esc(error.message) + '</div>';
            }
        );
    }


    /** Wires the per-row View / Renew / Edit / Cancel / Add cover buttons. */
    function bindWarrantyRowActions(container, sourceState) {
        function findRow(id) {
            return (sourceState.rows || []).filter(function (r) {
                return String(r.id) === String(id);
            })[0];
        }

        function afterChange(message) {
            return function () {
                showAlert(message, 'success');
                loadWarrantyStats();
                loadWarranty();
            };
        }

        function afterFailure(error) {
            var firstError = error.errors && error.errors.length ? error.errors[0].message : null;
            showAlert(firstError || error.message, 'error');
        }

        Array.prototype.forEach.call(container.querySelectorAll('[data-wty-view]'), function (btn) {
            btn.addEventListener('click', function () {
                var row = findRow(btn.getAttribute('data-wty-view'));
                if (row) openWarrantyDetail(row);
            });
        });

        // Record cover for an asset that only has a register warranty.
        Array.prototype.forEach.call(container.querySelectorAll('[data-wty-record]'), function (btn) {
            btn.addEventListener('click', function () {
                openWarrantyForm({ asset_id: btn.getAttribute('data-wty-record') });
            });
        });

        Array.prototype.forEach.call(container.querySelectorAll('[data-wty-edit]'), function (btn) {
            btn.addEventListener('click', function () {
                var row = findRow(btn.getAttribute('data-wty-edit'));
                if (row) openWarrantyForm({ record: row });
            });
        });

        Array.prototype.forEach.call(container.querySelectorAll('[data-wty-renew]'), function (btn) {
            btn.addEventListener('click', function () {
                var row = findRow(btn.getAttribute('data-wty-renew'));
                if (!row) return;

                // Default the new term to a year on from the current expiry.
                var base = row.expiry_date ? new Date(row.expiry_date) : new Date();
                var next = new Date(base.getTime());
                next.setDate(next.getDate() + 1);
                var pad = function (n) { return String(n).padStart(2, '0'); };
                var startValue = next.getFullYear() + '-' + pad(next.getMonth() + 1) + '-' + pad(next.getDate());

                var end = new Date(startValue + 'T00:00:00');
                end.setFullYear(end.getFullYear() + 1);
                end.setDate(end.getDate() - 1);
                var endValue = end.getFullYear() + '-' + pad(end.getMonth() + 1) + '-' + pad(end.getDate());

                openForm({
                    title: 'Renew ' + (row.warranty_ref || 'cover'),
                    submitLabel: 'Renew cover',
                    successMessage: 'Warranty renewed.',
                    fields: [
                        { name: 'start_date', label: 'New start date', type: 'date', required: true, value: startValue },
                        { name: 'expiry_date', label: 'New expiry date', type: 'date', required: true, value: endValue },
                        { name: 'contract_value', label: 'Contract value', type: 'number', step: '0.01', min: 0, value: row.contract_value },
                        { name: 'notice_period_days', label: 'Notice period (days)', type: 'number', min: 0, value: row.notice_period_days },
                        { name: 'provider', label: 'Provider', value: row.provider },
                        { name: 'title', label: 'Cover description', full: true, value: row.title },
                        { name: 'remarks', label: 'Renewal notes', type: 'textarea', full: true },
                        { name: 'auto_renew', label: 'Auto renew', type: 'checkbox', checkboxLabel: 'This cover renews automatically', value: !!Number(row.auto_renew) }
                    ],
                    onSubmit: function (payload) {
                        return Api.warranties
                            .renew(row.id, compact(payload.values))
                            .then(afterChange('Warranty renewed.'))
                            .catch(function (error) {
                                afterFailure(error);
                                throw error;
                            });
                    }
                });
            });
        });

        Array.prototype.forEach.call(container.querySelectorAll('[data-wty-cancel]'), function (btn) {
            btn.addEventListener('click', function () {
                var id = btn.getAttribute('data-wty-cancel');
                openForm({
                    title: 'Cancel warranty',
                    submitLabel: 'Cancel cover',
                    successMessage: 'Warranty cancelled.',
                    fields: [
                        { name: 'reason', label: 'Reason for cancelling', type: 'textarea', full: true, required: true },
                        { name: 'cancelled_date', label: 'Cancellation date', type: 'date', value: today() }
                    ],
                    onSubmit: function (payload) {
                        return Api.warranties
                            .cancel(id, compact(payload.values))
                            .then(afterChange('Warranty cancelled.'))
                            .catch(function (error) {
                                afterFailure(error);
                                throw error;
                            });
                    }
                });
            });
        });
    }


    /** Read-only warranty panel, with the asset's other cover when there is one. */
    function openWarrantyDetail(record) {
        var pairs = [
            { label: 'Reference', value: record.warranty_ref },
            {
                label: 'Source',
                html: record.source === 'asset_register'
                    ? '<span class="badge-pill info">Asset register</span>'
                    : '<span class="badge-pill neutral">Recorded here</span>'
            },
            { label: 'Type', value: record.warranty_type },
            { label: 'Cover description', value: record.title },
            { label: 'Status', html: coverageBadge(record.status) },
            { label: 'Asset', value: record.asset_tag || 'Site-wide contract' },
            { label: 'Asset ID', value: record.asset_code },
            { label: 'Serial number', value: record.serial_number },
            { label: 'Category', value: record.category_name },
            { label: 'Location', value: record.asset_location },
            { label: 'Department', value: record.asset_department },
            { label: 'Provider', value: record.provider },
            { label: 'Provider contact', value: record.provider_contact },
            { label: 'Provider e-mail', value: record.provider_email },
            { label: 'Provider phone', value: record.provider_phone },
            { label: 'Contract reference', value: record.contract_ref },
            { label: 'Starts', value: day(record.start_date) },
            { label: 'Expires', value: day(record.expiry_date) },
            { label: 'Time remaining', html: remainingCell(record) },
            {
                label: 'Notice period',
                value: record.notice_period_days !== null && record.notice_period_days !== undefined
                    ? record.notice_period_days + ' days'
                    : null
            },
            { label: 'Auto renew', value: Number(record.auto_renew) ? 'Yes' : 'No' },
            { label: 'Contract value', value: money(record.contract_value) + (record.currency ? ' ' + record.currency : '') },
            { label: 'Payment terms', value: record.payment_terms },
            { label: 'Recorded by', value: record.created_by_name || record.created_by_username },
            { label: 'Coverage', value: record.coverage_details, full: true },
            { label: 'Excluded', value: record.excluded_items, full: true },
            { label: 'Remarks', value: record.remarks, full: true }
        ];

        if (record.cancelled_date) {
            pairs.splice(22, 0, { label: 'Cancelled on', value: day(record.cancelled_date) });
            pairs.splice(23, 0, { label: 'Cancellation reason', value: record.cancellation_reason });
        }

        var html = details(pairs);

        // Everything else recorded against the same asset, so the full coverage
        // position is visible without leaving the panel.
        if (record.asset_id) {
            html +=
                '<div class="section-label">All cover for this asset</div>' +
                '<div id="wtyAssetCoverage"><div class="loading"><span class="spinner-dark"></span>Loading coverage...</div></div>';

            Api.warranties.getAssetCoverage(record.asset_id).then(
                function (data) {
                    var target = document.getElementById('wtyAssetCoverage');
                    if (!target) return;

                    var rows = (data && data.warranties) || [];
                    var register = data && data.register_warranty;

                    target.innerHTML =
                        (register
                            ? '<div class="muted" style="font-size:12.5px;margin-bottom:8px;">Register warranty: ' +
                              orDash(register.provider) + ' from ' + orDash(day(register.start_date)) +
                              ' to ' + orDash(day(register.expiry_date)) + ' ' + coverageBadge(register.status) +
                              '</div>'
                            : '') +
                        table(
                            rows,
                            [
                                { label: 'Reference', key: 'warranty_ref' },
                                { label: 'Type', key: 'warranty_type' },
                                { label: 'Provider', key: 'provider' },
                                { label: 'Expires', className: 'nowrap', render: function (r) { return orDash(day(r.expiry_date)); } },
                                { label: 'Status', render: function (r) { return coverageBadge(r.status); } }
                            ],
                            { empty: 'No separately recorded cover for this asset.' }
                        );
                },
                function () {
                    var target = document.getElementById('wtyAssetCoverage');
                    if (target) target.innerHTML = '<div class="empty">Coverage history unavailable.</div>';
                }
            );
        }

        openDetail('Warranty ' + (record.warranty_ref || record.title || ''), html, true);
    }


    /**
     * Record-a-warranty / edit-a-warranty form (§5.6).
     *
     * `preset.record` switches the modal into edit mode; `preset.asset_id`
     * pre-selects the asset when cover is being added from an asset row.
     */
    function openWarrantyForm(preset) {
        preset = preset || {};
        var record = preset.record || null;

        // A year from today is the usual warranty term, so offer it by default.
        var defaultExpiry = (function () {
            var end = new Date(today() + 'T00:00:00');
            end.setFullYear(end.getFullYear() + 1);
            end.setDate(end.getDate() - 1);
            var pad = function (n) { return String(n).padStart(2, '0'); };
            return end.getFullYear() + '-' + pad(end.getMonth() + 1) + '-' + pad(end.getDate());
        })();

        openForm({
            title: record ? 'Edit warranty ' + (record.warranty_ref || '') : 'Record a warranty or contract',
            submitLabel: record ? 'Save changes' : 'Record warranty',
            successMessage: record ? 'Warranty updated.' : 'Warranty recorded.',
            wide: true,
            fields: [
                {
                    name: 'asset_id',
                    label: 'Asset',
                    type: 'select',
                    options: warrantyAssetOptions(),
                    value: record ? record.asset_id : preset.asset_id,
                    hint: 'Leave blank for a site-wide support or maintenance contract.'
                },
                {
                    name: 'warranty_type',
                    label: 'Type',
                    type: 'select',
                    required: true,
                    options: warrantyTypeOptions(),
                    value: record ? record.warranty_type : 'Asset Warranty'
                },
                { name: 'title', label: 'Cover description', value: record ? record.title : null },
                { name: 'contract_ref', label: 'Contract / policy reference', value: record ? record.contract_ref : null },
                { name: 'provider', label: 'Provider', value: record ? record.provider : null, required: true },
                { name: 'provider_contact', label: 'Provider contact', value: record ? record.provider_contact : null },
                { name: 'provider_email', label: 'Provider e-mail', type: 'email', value: record ? record.provider_email : null },
                { name: 'provider_phone', label: 'Provider phone', value: record ? record.provider_phone : null },
                {
                    name: 'start_date',
                    label: 'Start date',
                    type: 'date',
                    required: true,
                    value: record ? day(record.start_date) : today()
                },
                {
                    name: 'expiry_date',
                    label: 'Expiry date',
                    type: 'date',
                    required: true,
                    value: record ? day(record.expiry_date) : defaultExpiry
                },
                { name: 'notice_period_days', label: 'Notice period (days)', type: 'number', min: 0, value: record ? record.notice_period_days : null },
                {
                    name: 'auto_renew',
                    label: 'Auto renew',
                    type: 'checkbox',
                    checkboxLabel: 'This cover renews automatically',
                    value: record ? !!Number(record.auto_renew) : false
                },
                { name: 'contract_value', label: 'Contract value', type: 'number', step: '0.01', min: 0, value: record ? record.contract_value : 0 },
                { name: 'currency', label: 'Currency', value: record ? record.currency : 'USD' },
                { name: 'payment_terms', label: 'Payment terms', value: record ? record.payment_terms : null },
                { name: 'coverage_details', label: 'What is covered', type: 'textarea', full: true, value: record ? record.coverage_details : null },
                { name: 'excluded_items', label: 'What is excluded', type: 'textarea', full: true, value: record ? record.excluded_items : null },
                { name: 'remarks', label: 'Remarks', type: 'textarea', full: true, value: record ? record.remarks : null }
            ],
            onSubmit: function (payload) {
                var values = compact(payload.values);

                // The select sends '' for "no asset", which the API reads as a
                // site-wide contract; strip it so compact() does not mistake it
                // for an unset field.
                if (values.asset_id === '') delete values.asset_id;

                var promise = record
                    ? Api.warranties.update(record.id, values)
                    : Api.warranties.create(values);

                return promise.then(function () {
                    loadWarrantyStats();
                    loadWarranty();
                });
            }
        });
    }

})();

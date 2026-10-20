/**
 * public/js/login.js
 * Controller for the login page. Kept out of login.html so the markup stays
 * declarative and the behaviour can be unit-tested / linted separately.
 */

(function () {
    'use strict';

    var form = document.getElementById('loginForm');
    var usernameInput = document.getElementById('username');
    var passwordInput = document.getElementById('password');
    var usernameError = document.getElementById('usernameError');
    var passwordError = document.getElementById('passwordError');
    var alertBox = document.getElementById('alertBox');
    var submitBtn = document.getElementById('submitBtn');
    var togglePassword = document.getElementById('togglePassword');

    var DEFAULT_BUTTON_TEXT = submitBtn.textContent;

    Api.getMe().then(function () {
        window.location.replace('/index.html');
    }).catch(function () {});

    /* ----------------------------- UI helpers ----------------------------- */

    function showAlert(message, type) {
        alertBox.textContent = message;
        alertBox.className =
            'alert visible ' + (type === 'success' ? 'alert-success' : 'alert-error');
    }

    function hideAlert() {
        alertBox.className = 'alert';
        alertBox.textContent = '';
    }

    function setFieldError(input, errorEl, message) {
        if (message) {
            errorEl.textContent = message;
            errorEl.classList.add('visible');
            input.classList.add('is-invalid');
        } else {
            errorEl.textContent = '';
            errorEl.classList.remove('visible');
            input.classList.remove('is-invalid');
        }
    }

    function clearErrors() {
        setFieldError(usernameInput, usernameError, '');
        setFieldError(passwordInput, passwordError, '');
        hideAlert();
    }

    function setLoading(loading) {
        submitBtn.disabled = loading;
        submitBtn.innerHTML = loading
            ? '<span class="spinner"></span>Signing in...'
            : DEFAULT_BUTTON_TEXT;
    }

    /* ---------------------------- interactions ---------------------------- */

    // The toggle is icon-only: swapping textContent for an eye/eye-off glyph and
    // keeping the wording in aria-label/title means the icon can never collide
    // with a text label inside the small button.
    var EYE_OPEN =
        '<path d="M1.5 12S5.5 5.5 12 5.5 22.5 12 22.5 12 18.5 18.5 12 18.5 1.5 12 1.5 12Z"/>' +
        '<circle cx="12" cy="12" r="3.2"/>';

    var EYE_OFF =
        '<path d="M1.5 12S5.5 5.5 12 5.5a10.4 10.4 0 0 1 3.5.6"/>' +
        '<path d="M22.5 12s-4 6.5-10.5 6.5a10.4 10.4 0 0 1-3.5-.6"/>' +
        '<path d="M9.9 9.9a3.2 3.2 0 0 0 4.2 4.2"/>' +
        '<path d="M3 3l18 18"/>';

    function renderToggle(showing) {
        togglePassword.innerHTML =
            '<svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">' +
            (showing ? EYE_OFF : EYE_OPEN) +
            '</svg>';

        var label = showing ? 'Hide password' : 'Show password';
        togglePassword.setAttribute('aria-label', label);
        togglePassword.setAttribute('title', label);
        togglePassword.setAttribute('aria-pressed', showing ? 'true' : 'false');
    }

    renderToggle(false);

    togglePassword.addEventListener('click', function () {
        var showing = passwordInput.type === 'text';

        passwordInput.type = showing ? 'password' : 'text';
        renderToggle(!showing);

        // Keep the caret where the user left it rather than jumping to the end.
        passwordInput.focus();
        var end = passwordInput.value.length;
        try {
            passwordInput.setSelectionRange(end, end);
        } catch (e) {
            /* setSelectionRange is unsupported for some input types - harmless. */
        }
    });

    usernameInput.addEventListener('input', function () {
        setFieldError(usernameInput, usernameError, '');
    });

    passwordInput.addEventListener('input', function () {
        setFieldError(passwordInput, passwordError, '');
    });

    /* ------------------------------- submit ------------------------------- */

    form.addEventListener('submit', async function (event) {
        event.preventDefault();
        clearErrors();

        var username = usernameInput.value.trim();
        var password = passwordInput.value;

        // Client-side validation mirrors the server rules so the user gets
        // immediate feedback without a round trip.
        var hasError = false;

        if (!username) {
            setFieldError(usernameInput, usernameError, 'Please enter your username or email.');
            hasError = true;
        }
        if (!password) {
            setFieldError(passwordInput, passwordError, 'Please enter your password.');
            hasError = true;
        }
        if (hasError) return;

        setLoading(true);

        try {
            await Api.login(username, password);
            showAlert('Login successful. Redirecting...', 'success');
            window.location.href = '/index.html';
        } catch (error) {
            setLoading(false);

            // Map field-level validation errors returned by the server.
            if (error.errors && error.errors.length) {
                error.errors.forEach(function (item) {
                    if (item.field === 'username' || item.field === 'email') {
                        setFieldError(usernameInput, usernameError, item.message);
                    } else if (item.field === 'password') {
                        setFieldError(passwordInput, passwordError, item.message);
                    }
                });
            }

            showAlert(error.message || 'Login failed. Please try again.', 'error');

            // Never leave the password sitting in the field after a failure.
            passwordInput.value = '';
            passwordInput.focus();
        }
    });
})();

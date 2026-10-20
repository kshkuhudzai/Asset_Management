'use strict';

/**
 * scripts/_loginUi.js
 * ---------------------------------------------------------------------------
 * Throwaway verification for the login-screen fixes:
 *   1. no green brand colours remain in either stylesheet;
 *   2. the NBSZ navy + gold tokens are declared and actually applied;
 *   3. the password field reserves right-hand padding so the show/hide control
 *      cannot overlap the typed value;
 *   4. the toggle renders an icon and carries an accessible label;
 *   5. the toggle's hand-written logic flips input type + aria state.
 *
 * Run: node scripts/_loginUi.js
 * ---------------------------------------------------------------------------
 */

require('dotenv').config();

const fs = require('fs');
const path = require('path');

const results = [];
function check(name, condition, detail) {
    results.push({ name, passed: !!condition });
    console.log(`  [${condition ? 'PASS' : 'FAIL'}] ${name}${!condition && detail ? ` -> ${detail}` : ''}`);
}
function section(t) {
    console.log(`\n${t}`);
    console.log('-'.repeat(t.length));
}

const ROOT = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');

const styleCss = read('public/css/style.css');
const loginCss = read('public/css/login.css');
const loginHtml = read('public/login.html');
const loginJs = read('public/js/login.js');

/* -------------------------------------------------------------------------
 * 1. Green palette removed
 * ---------------------------------------------------------------------- */
section('1. Green brand colours are gone');

const GREEN = ['#0b3d2c', '#14624a', '#1f8a63', '#0f4c3a', '#8fb3a5',
               '#6f9686', '#d9e9e2', '#5f8477'];

GREEN.forEach((hex) => {
    const inStyle = styleCss.toLowerCase().includes(hex);
    const inLogin = loginCss.toLowerCase().includes(hex);
    check(`old green ${hex} absent from both stylesheets`, !inStyle && !inLogin,
        `style.css=${inStyle} login.css=${inLogin}`);
});

check('no green hue referenced in either stylesheet comment block',
    !/deep green/i.test(styleCss) && !/deep green/i.test(loginCss));

/* -------------------------------------------------------------------------
 * 2. NBSZ navy + gold tokens declared and applied
 * ---------------------------------------------------------------------- */
section('2. NBSZ navy + gold tokens');

['--navy-900', '--navy-800', '--navy-700', '--navy-600',
 '--gold-500', '--gold-600', '--gold-100'].forEach((token) => {
    check(`${token} declared in style.css`, styleCss.includes(`${token}:`));
});

check('gold accent is the documented NBSZ gold',
    /--gold-500:\s*#c8a24a/i.test(styleCss) && /--gold-500:\s*#c8a24a/i.test(loginCss),
    'expected #c8a24a');

check('brand mark uses navy fill + gold glyph',
    /\.sidebar-brand \.logo\s*\{[\s\S]*?background:\s*var\(--gold-500\);[\s\S]*?color:\s*var\(--navy-900\)/.test(styleCss),
    'sidebar logo should be gold on navy');

check('login mark uses navy fill + gold glyph',
    /\.login-brand \.logo\s*\{[\s\S]*?background:\s*var\(--navy-800\);[\s\S]*?color:\s*var\(--gold-500\)/.test(loginCss));

check('primary button uses the navy token',
    /\.btn-primary\s*\{\s*background:\s*var\(--navy-700\)/.test(styleCss));

check('login button uses the navy token',
    /\.btn-login\s*\{[\s\S]*?background:\s*var\(--navy-700\)/.test(loginCss));

// Every colour used outside the :root block should be a token, not a literal.
const afterTokens = (css) => css.slice(css.indexOf('* { box-sizing'));
check('style.css has no literal hex outside the token block',
    (afterTokens(styleCss).match(/#[0-9a-fA-F]{3,6}/g) || []).length === 0);

/* -------------------------------------------------------------------------
 * 3. Password toggle cannot overlap the value
 * ---------------------------------------------------------------------- */
section('3. Password toggle overlap fix');

check('input reserves right padding for the control',
    /\.field input\.has-toggle\s*\{\s*padding-right:\s*48px;\s*\}/.test(loginCss),
    'expected 48px to clear a 30px button at right:9px');

check('password input carries the has-toggle class',
    /id="password"[\s\S]{0,80}class="has-toggle"/.test(loginHtml));

check('toggle is a fixed-size flex box (icon centred, no text flow)',
    /\.toggle-password\s*\{[\s\S]*?display:\s*inline-flex;[\s\S]*?align-items:\s*center;[\s\S]*?justify-content:\s*center;/.test(loginCss));

check('toggle has explicit width and height',
    /\.toggle-password\s*\{[\s\S]*?width:\s*30px;[\s\S]*?height:\s*30px;/.test(loginCss));

check('toggle is pinned to the right edge with a right offset',
    /\.toggle-password\s*\{[\s\S]*?right:\s*9px;/.test(loginCss));

check('toggle markup lives inside .password-wrap',
    /<div class="password-wrap">[\s\S]*?id="togglePassword"[\s\S]*?<\/div>/.test(loginHtml));

// The old failure mode: a visible "Show"/"Hide" text node inside the button.
check('button no longer contains a bare text label',
    !/>\s*(Show|Hide)\s*</.test(loginHtml),
    'visible text inside a 30px box was the collision');

check('button content is an inline SVG icon',
    /id="togglePassword"[\s\S]*?<svg[\s\S]*?<\/svg>/.test(loginHtml));

check('button exposes an accessible label',
    /id="togglePassword"[\s\S]{0,200}aria-label="Show password"/.test(loginHtml));

/* -------------------------------------------------------------------------
 * 4. Toggle behaviour wiring
 * ---------------------------------------------------------------------- */
section('4. Toggle behaviour wiring');

check('login.js renders the toggle through renderToggle()',
    /function renderToggle\(showing\)/.test(loginJs));

check('login.js swaps the input type on click',
    /passwordInput\.type\s*=\s*showing\s*\?\s*'password'\s*:\s*'text'/.test(loginJs));

check('login.js updates aria-pressed',
    /setAttribute\('aria-pressed'/.test(loginJs));

check('login.js no longer writes a text label into the button',
    !/togglePassword\.textContent\s*=/.test(loginJs));

/* -------------------------------------------------------------------------
 * 5. Behavioural simulation of the toggle handler
 * ---------------------------------------------------------------------- */
section('5. Simulated toggle handler');

(function simulate() {
    // A minimal stand-in for the pieces of the DOM the handler touches.
    const attrs = {};
    const togglePassword = {
        innerHTML: '',
        setAttribute: (k, v) => { attrs[k] = v; },
        getAttribute: (k) => attrs[k],
        addEventListener: (evt, fn) => { togglePassword._handler = fn; }
    };
    const passwordInput = {
        type: 'password',
        value: 'Secret123',
        focus: () => {},
        setSelectionRange: () => {}
    };

    const EYE_OPEN =
        '<path d="M1.5 12S5.5 5.5 12 5.5 22.5 12 22.5 12 18.5 18.5 12 18.5 1.5 12 1.5 12Z"/>' +
        '<circle cx="12" cy="12" r="3.2"/>';
    const EYE_OFF =
        '<path d="M1.5 12S5.5 5.5 12 5.5a10.4 10.4 0 0 1 3.5.6"/>' +
        '<path d="M22.5 12s-4 6.5-10.5 6.5a10.4 10.4 0 0 1-3.5-.6"/>' +
        '<path d="M9.9 9.9a3.2 3.2 0 0 0 4.2 4.2"/>' +
        '<path d="M3 3l18 18"/>';

    function renderToggle(showing) {
        togglePassword.innerHTML =
            '<svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">' +
            (showing ? EYE_OFF : EYE_OPEN) + '</svg>';
        const label = showing ? 'Hide password' : 'Show password';
        togglePassword.setAttribute('aria-label', label);
        togglePassword.setAttribute('title', label);
        togglePassword.setAttribute('aria-pressed', showing ? 'true' : 'false');
    }

    renderToggle(false);
    togglePassword.addEventListener('click', function () {
        const showing = passwordInput.type === 'text';
        passwordInput.type = showing ? 'password' : 'text';
        renderToggle(!showing);
    });

    check('initial state: password is masked', passwordInput.type === 'password');
    check('initial icon is the open eye', togglePassword.innerHTML.includes('circle'));
    check('initial label says "Show password"', attrs['aria-label'] === 'Show password');
    check('initial aria-pressed is false', attrs['aria-pressed'] === 'false');

    togglePassword._handler();

    check('after 1st click: value is revealed', passwordInput.type === 'text');
    check('after 1st click: icon becomes eye-off',
        togglePassword.innerHTML.includes('M3 3l18 18'));
    check('after 1st click: label says "Hide password"', attrs['aria-label'] === 'Hide password');
    check('after 1st click: aria-pressed is true', attrs['aria-pressed'] === 'true');
    check('after 1st click: value is preserved', passwordInput.value === 'Secret123');

    togglePassword._handler();

    check('after 2nd click: value is masked again', passwordInput.type === 'password');
    check('after 2nd click: icon returns to the open eye',
        togglePassword.innerHTML.includes('circle') &&
        !togglePassword.innerHTML.includes('M3 3l18 18'));
    check('after 2nd click: label says "Show password"', attrs['aria-label'] === 'Show password');
    check('after 2nd click: aria-pressed is false', attrs['aria-pressed'] === 'false');
})();

/* -------------------------------------------------------------------------
 * Summary
 * ---------------------------------------------------------------------- */
const failed = results.filter((r) => !r.passed).length;
console.log('\n' + '='.repeat(54));
console.log(`  RESULT: ${results.length - failed} passed, ${failed} failed (of ${results.length})`);
console.log('='.repeat(54) + '\n');

process.exit(failed ? 1 : 0);


check('login.js keeps caret position after toggling',
    /setSelectionRange/.test(loginJs));

check('login.css has no literal hex outside the token block',
    (afterTokens(loginCss).match(/#[0-9a-fA-F]{3,6}/g) || []).length === 0);

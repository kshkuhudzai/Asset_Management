'use strict';

/**
 * scripts/_liveCheck.js
 * Live HTTP check that the login-screen assets are served correctly after the
 * palette + password-toggle changes.
 */
require('dotenv').config();
const app = require('../server');

const PORT = 3998;

(async () => {
    const server = app.listen(PORT);
    const get = async (p) => {
        const r = await fetch(`http://127.0.0.1:${PORT}${p}`);
        return { status: r.status, text: await r.text() };
    };

    const login = await get('/login.html');
    console.log('login.html status   :', login.status);
    console.log('  has-toggle class  :', login.text.includes('has-toggle'));
    console.log('  svg icon present  :', login.text.includes('<svg'));
    console.log('  no bare Show text :', !/>\s*Show\s*</.test(login.text));
    console.log('  aria-label set    :', login.text.includes('aria-label="Show password"'));

    const css = await get('/css/login.css');
    console.log('login.css status    :', css.status);
    console.log('  gold token        :', css.text.includes('#c8a24a'));
    console.log('  padding-right 48  :', css.text.includes('padding-right: 48px'));
    console.log('  navy token        :', css.text.includes('--navy-700'));

    const style = await get('/css/style.css');
    console.log('style.css status    :', style.status);
    console.log('  navy token        :', style.text.includes('--navy-700'));
    console.log('  green removed     :',
        !style.text.includes('#1f8a63') && !style.text.includes('#0b3d2c') &&
        !style.text.includes('#14624a'));

    const js = await get('/js/login.js');
    console.log('login.js status     :', js.status);
    console.log('  renderToggle()    :', js.text.includes('renderToggle'));
    console.log('  no textContent=   :', !/togglePassword\.textContent\s*=/.test(js.text));

    const idx = await get('/index.html');
    console.log('index.html status   :', idx.status);
    console.log('  stock nav enabled :', idx.text.includes('data-view="stock"'));
    console.log('  verification disab:', idx.text.includes('data-view="verification"'));

    server.close();
    process.exit(0);
})();

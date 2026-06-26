const { execSync, exec } = require('child_process');
const fs = require('fs');
const http = require('http');
const { spawn } = require('child_process');

function installDeps() {
    console.log('正在安装依赖包...');
    try {
        execSync('npm install --save playwright-extra puppeteer-extra-plugin-stealth', { stdio: 'inherit' });
        execSync('npx playwright install chromium', { stdio: 'inherit' });
        console.log('✅ 依赖安装完成。');
    } catch (e) { console.error('❌ 依赖安装失败:', e.message); process.exit(1); }
}

function installChrome() {
    try {
        execSync('which google-chrome || which google-chrome-stable', { stdio: 'ignore' });
        console.log('✅ Chrome 已存在');
    } catch (e) {
        console.log('正在安装 Google Chrome...');
        try {
            execSync('wget -q -O /tmp/chrome.deb https://dl.google.com/linux/direct/google-chrome-stable_current_amd64.deb', { stdio: 'inherit' });
            execSync('apt-get install -y -qq /tmp/chrome.deb 2>/dev/null || dpkg -i /tmp/chrome.deb 2>/dev/null; apt-get -f install -y -qq 2>/dev/null || true', { stdio: 'ignore', shell: true });
            console.log('✅ Chrome 安装完成');
        } catch (err) { console.log('⚠️ Chrome 安装失败，将使用 Playwright Chromium'); }
    }
}

function checkPort(port) {
    return new Promise((resolve) => {
        const req = http.get(`http://localhost:${port}/json/version`, () => resolve(true));
        req.on('error', () => resolve(false));
        req.end();
    });
}

async function launchChrome(proxyServer) {
    const DEBUG_PORT = 9222;
    const chromePaths = ['/usr/bin/google-chrome', '/usr/bin/google-chrome-stable', '/usr/bin/chromium-browser', '/usr/bin/chromium'];
    let chromePath = null;
    for (const p of chromePaths) {
        try { execSync(`test -f ${p}`, { stdio: 'ignore' }); chromePath = p; break; } catch (e) {}
    }
    if (!chromePath) { console.log('⚠️ 未找到 Chrome，跳过 CDP 模式'); return null; }
    if (await checkPort(DEBUG_PORT)) { console.log('Chrome 已运行'); return DEBUG_PORT; }

    console.log(`正在启动 Chrome (${chromePath})...`);
    const args = [
        `--remote-debugging-port=${DEBUG_PORT}`,
        '--no-first-run', '--no-default-browser-check',
        '--disable-gpu', '--window-size=1280,720',
        '--no-sandbox', '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        '--user-data-dir=/tmp/chrome_user_data',
        '--display=:99',
    ];
    if (proxyServer) args.push(`--proxy-server=${proxyServer}`);
    spawn(chromePath, args, { detached: true, stdio: 'ignore' }).unref();

    for (let i = 0; i < 20; i++) {
        if (await checkPort(DEBUG_PORT)) { console.log('✅ Chrome 已就绪'); return DEBUG_PORT; }
        await new Promise(r => setTimeout(r, 1000));
    }
    console.log('⚠️ Chrome 启动超时'); return null;
}

function startXrayProxy(vlessLink) {
    if (!vlessLink) { console.log('⚠️ 未检测到代理变量。'); return null; }
    console.log('正在下载 Xray-core...');
    try {
        execSync('curl -L -o xray.zip https://github.com/XTLS/Xray-core/releases/latest/download/Xray-linux-64.zip', { stdio: 'ignore' });
        execSync('unzip -o xray.zip xray && chmod +x xray', { stdio: 'ignore' });
    } catch (err) { console.error('❌ Xray 失败:', err.message); return null; }
    try {
        const url = new URL(vlessLink);
        const uuid = url.username;
        const [host, port] = url.host.split(':');
        const params = url.searchParams;
        const config = {
            inbounds: [{ port: 10808, listen: '127.0.0.1', protocol: 'socks', settings: { auth: 'noauth', udp: true } }],
            outbounds: [{ protocol: 'vless', settings: { vnext: [{ address: host, port: parseInt(port||'443'), users: [{ id: uuid, encryption: 'none' }] }] }, streamSettings: { network: params.get('type')||'tcp', security: params.get('security')||'none', tlsSettings: { serverName: params.get('sni')||host }, wsSettings: params.get('type')==='ws' ? { path: decodeURIComponent(params.get('path')||'/') } : undefined } }]
        };
        fs.writeFileSync('config.json', JSON.stringify(config, null, 2));
    } catch (err) { console.error('❌ 配置失败:', err.message); return null; }
    exec('./xray -config config.json > xray.log 2>&1').unref();
    execSync('sleep 3');
    try {
        execSync('curl --socks5-hostname 127.0.0.1:10808 -m 5 https://www.cloudflare.com/cdn-cgi/trace', { stdio: 'ignore' });
        console.log('✅ 代理建立成功！'); return 'socks5://127.0.0.1:10808';
    } catch (e) { console.log('⚠️ 代理测试失败，继续。'); return 'socks5://127.0.0.1:10808'; }
}

const INJECTED_SCRIPT = `
(function() {
    try {
        const originalAttachShadow = Element.prototype.attachShadow;
        Element.prototype.attachShadow = function(init) {
            const shadowRoot = originalAttachShadow.call(this, init);
            if (shadowRoot) {
                const checkAndReport = () => {
                    const checkbox = shadowRoot.querySelector('input[type="checkbox"]');
                    if (checkbox) {
                        const rect = checkbox.getBoundingClientRect();
                        if (rect.width > 0 && rect.height > 0 && window.innerWidth > 0) {
                            window.__turnstile_data = {
                                xRatio: (rect.left + rect.width / 2) / window.innerWidth,
                                yRatio: (rect.top + rect.height / 2) / window.innerHeight
                            };
                            return true;
                        }
                    }
                    return false;
                };
                if (!checkAndReport()) {
                    const observer = new MutationObserver(() => {
                        if (checkAndReport()) observer.disconnect();
                    });
                    observer.observe(shadowRoot, { childList: true, subtree: true });
                }
            }
            return shadowRoot;
        };
    } catch(e) {}
})();
`;

async function attemptTurnstileCDP(page) {
    const frames = page.frames();
    for (const frame of frames) {
        try {
            const data = await frame.evaluate(() => window.__turnstile_data).catch(() => null);
            if (!data) continue;
            console.log('✅ 找到 Turnstile 位置数据:', data);
            const iframeEl = await frame.frameElement();
            if (!iframeEl) continue;
            const box = await iframeEl.boundingBox();
            if (!box) continue;
            const clickX = box.x + box.width * data.xRatio;
            const clickY = box.y + box.height * data.yRatio;
            console.log(`   点击坐标: (${clickX.toFixed(1)}, ${clickY.toFixed(1)})`);
            const client = await page.context().newCDPSession(page);
            await client.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: clickX, y: clickY, button: 'left', clickCount: 1 });
            await new Promise(r => setTimeout(r, 50 + Math.random() * 100));
            await client.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: clickX, y: clickY, button: 'left', clickCount: 1 });
            await client.detach();
            console.log('   CDP 点击已发送');
            return true;
        } catch (e) {}
    }
    return false;
}

async function extractServerTime(page) {
    try {
        const text = await page.innerText('body');
        const match = text.match(/\d{2}:\d{2}:\d{2}/);
        return match ? match[0] : '无法提取';
    } catch (e) { return '获取失败'; }
}

(async () => {
    installDeps();

    try {
        execSync('which Xvfb || (apt-get update -qq && apt-get install -y -qq xvfb)', { stdio: 'ignore', shell: true });
        try { execSync('pkill Xvfb', { stdio: 'ignore' }); } catch(e) {}
        execSync('sleep 1');
        exec('Xvfb :99 -screen 0 1280x720x24 &', { stdio: 'ignore', shell: true }).unref();
        execSync('sleep 2');
        process.env.DISPLAY = ':99';
        console.log('✅ Xvfb 已启动');
    } catch(e) { console.log('⚠️ Xvfb 失败'); }

    const vlessLink = process.env.MY_VLESS_PROXY;
    const proxyServer = startXrayProxy(vlessLink);

    installChrome();
    const debugPort = await launchChrome(proxyServer);

    let browser, page;

    if (debugPort) {
        const { chromium } = require('playwright-extra');
        const StealthPlugin = require('puppeteer-extra-plugin-stealth');
        chromium.use(StealthPlugin());
        for (let k = 0; k < 5; k++) {
            try {
                browser = await chromium.connectOverCDP(`http://localhost:${debugPort}`);
                console.log('✅ 已连接真实 Chrome');
                break;
            } catch (e) {
                console.log(`连接尝试 ${k+1} 失败，重试...`);
                await new Promise(r => setTimeout(r, 2000));
            }
        }
        if (browser) {
            const context = browser.contexts()[0];
            page = context.pages().length > 0 ? context.pages()[0] : await context.newPage();
        }
    }

    if (!browser || !page) {
        console.log('降级使用 Playwright Chromium...');
        const { chromium } = require('playwright-extra');
        const StealthPlugin = require('puppeteer-extra-plugin-stealth');
        chromium.use(StealthPlugin());
        const opts = { headless: false, args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-blink-features=AutomationControlled', '--display=:99'] };
        if (proxyServer) opts.proxy = { server: proxyServer };
        browser = await chromium.launch(opts);
        const ctx = await browser.newContext({ userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36', viewport: { width: 1280, height: 720 }, locale: 'en-US' });
        page = await ctx.newPage();
    }

    await page.addInitScript(INJECTED_SCRIPT);
    console.log('✅ Shadow DOM Hook 已注入');

    // 用 Promise 让主流程等待续期 POST 完成
    let renewResolve;
    const renewDone = new Promise(resolve => { renewResolve = resolve; });

    const adDomains = ['3lift','google','doubleclick','amazon','intergient','rapidedge','id5-sync','crwdcntrl','fastclick','hadronid','prebid','tlx'];
    page.on('request', (req) => {
        const url = req.url();
        if (req.method() === 'POST' && url.includes('g4f.gg') && !adDomains.some(d => url.includes(d))) {
            console.log(`📡 续期 POST 已发出: ${url}`);
        }
    });
    page.on('response', async (res) => {
        const url = res.url();
        if (url.includes('g4f.gg') && url.includes('vote') && !adDomains.some(d => url.includes(d))) {
            const status = res.status();
            console.log(`📨 续期响应 [${status}]`);
            // 302 = 重定向 = 服务器已处理请求（无论成功失败都会重定向）
            // 200 也可能是成功
            if (status === 302 || status === 200 || status === 204) {
                renewResolve(status);
            }
        }
    });

    try {
        console.log('第一步：打开目标网页...');
        await page.goto('https://g4f.gg/dsxfjras', { waitUntil: 'domcontentloaded', timeout: 30000 });
        await page.waitForSelector('text=/\\d{2}:\\d{2}:\\d{2}/', { timeout: 15000 }).catch(() => {});
        await page.waitForTimeout(2000);

        const initialTime = await extractServerTime(page);
        console.log(`⏱️ 初始剩余时间: ${initialTime}`);
        await page.screenshot({ path: '1_initial_status.png' });

        console.log('第二步：点击 + ADD 90 MIN...');
        let addBtn = page.locator('text="+ ADD 90 MIN"').first();
        if (await addBtn.count() === 0) addBtn = page.locator('button:has-text("ADD 90 MIN")').first();
        await addBtn.scrollIntoViewIfNeeded();
        const btnBox = await addBtn.boundingBox().catch(() => null);
        if (btnBox) await page.mouse.move(btnBox.x + btnBox.width/2, btnBox.y + btnBox.height/2, { steps: 10 });
        await addBtn.click();
        console.log('已点击，等待 Turnstile 加载...');
        await page.waitForTimeout(4000);
        await page.screenshot({ path: '2_after_click_popup.png' });

        console.log('第三步：使用 Shadow DOM Hook + CDP 处理 Turnstile...');
        let cdpClicked = false;
        for (let attempt = 1; attempt <= 15; attempt++) {
            const clicked = await attemptTurnstileCDP(page);
            if (clicked) {
                cdpClicked = true;
                console.log('   CDP 点击完成，等待续期 POST 响应（最多 20 秒）...');
                break;
            }
            await page.waitForTimeout(1000);
        }

        if (!cdpClicked) {
            console.log('⚠️ 未能找到 Turnstile 位置，截图留存');
            await page.screenshot({ path: '3_after_captcha_attempt.png' });
        } else {
            // 等待续期 POST 完成，最多 20 秒
            const renewStatus = await Promise.race([
                renewDone,
                new Promise(r => setTimeout(() => r(null), 20000))
            ]);

            await page.screenshot({ path: '3_after_captcha_attempt.png' });

            if (renewStatus) {
                console.log(`✅ 续期请求已完成（HTTP ${renewStatus}）`);
            } else {
                console.log('⚠️ 20 秒内未收到续期响应');
            }
        }

        console.log('第四步：检查时间...');
        await page.waitForTimeout(3000);
        const endTime = await extractServerTime(page);
        console.log(`更新后剩余时间: ${endTime}`);

        const toSec = (t) => t.split(':').map(Number).reduce((a, v, i) => a + v * [3600, 60, 1][i], 0);
        if (initialTime !== '无法提取' && endTime !== '无法提取') {
            const diff = toSec(endTime) - toSec(initialTime);
            if (diff > 60) console.log(`✅ 续期成功！增加约 ${Math.round(diff/60)} 分钟。`);
            else console.log('⚠️ 时间未明显增加（可能已接近上限或续期间隔限制）。');
        }

    } catch (err) {
        console.error('异常:', err.message);
        await page.screenshot({ path: 'error_screenshot.png' }).catch(()=>{});
    } finally {
        await browser.close().catch(() => {});
        try { execSync('pkill -f xray'); } catch (e) {}
        try { execSync('pkill Xvfb'); } catch (e) {}
    }
})();

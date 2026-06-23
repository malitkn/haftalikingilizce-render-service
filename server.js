const express = require('express');
const puppeteer = require('puppeteer-core');
const { PuppeteerScreenRecorder } = require('puppeteer-screen-recorder');
const { exec } = require('child_process');
const axios = require('axios');
const fs = require('fs');
const path = require('path');
const util = require('util');

const execPromise = util.promisify(exec);
const app = express();
app.use(express.json());

// Health check endpoint (Before API key check)
app.get('/health', (req, res) => res.json({ status: 'ok' }));

// Security middleware
const API_KEY = process.env.API_KEY || 'test-key';
app.use((req, res, next) => {
    const key = req.headers['x-api-key'];
    if (key !== API_KEY) {
        return res.status(403).json({ error: 'Unauthorized' });
    }
    next();
});

// URL Whitelist
const ALLOWED_HOSTS = (process.env.ALLOWED_HOSTS || 'haftalikingilizce.alacatimanav.me')
    .split(',')
    .map(h => h.trim());

function isUrlAllowed(url) {
    try {
        const { hostname } = new URL(url);
        return ALLOWED_HOSTS.includes(hostname);
    } catch {
        return false;
    }
}

// Endpoint 1: POST /render-image
// Renders an HTML page to a JPEG image.
app.post('/render-image', async (req, res) => {
    const { html_url, width = 1080, height = 1350 } = req.body;
    if (!html_url) return res.status(400).json({ error: 'html_url is required' });
    if (!isUrlAllowed(html_url)) return res.status(403).json({ error: 'URL not allowed' });

    let browser;
    try {
        browser = await puppeteer.launch({
            args: ['--no-sandbox', '--disable-setuid-sandbox'],
            executablePath: process.env.PUPPETEER_EXECUTABLE_PATH || '/usr/bin/chromium'
        });
        const page = await browser.newPage();
        await page.setViewport({ width, height, deviceScaleFactor: 1 });
        await page.goto(html_url, { waitUntil: 'networkidle0' });

        // Wait for fonts to load
        await page.evaluate(() => document.fonts.ready);
        await new Promise(r => setTimeout(r, 500));

        // Try element-based screenshot first for better accuracy
        let buffer;
        const cardElement = await page.$('.instagram-post') || await page.$('#card-container');
        if (cardElement) {
            buffer = await cardElement.screenshot({ type: 'jpeg', quality: 90 });
        } else {
            buffer = await page.screenshot({ type: 'jpeg', quality: 90 });
        }

        await browser.close();
        res.set('Content-Type', 'image/jpeg');
        res.send(buffer);
    } catch (error) {
        if (browser) await browser.close();
        console.error('render-image error:', error);
        res.status(500).json({ error: error.message });
    }
});

// Endpoint 2: POST /render-video
// Supports two modes: 'carousel' and 'reveal'
app.post('/render-video', async (req, res) => {
    const { mode } = req.body;

    // --- CAROUSEL MODE ---
    // Converts a list of image URLs into a slideshow MP4.
    if (mode === 'carousel') {
        const { image_urls, duration_per_image = 3, audio_url, transition = 'none' } = req.body;
        if (!image_urls || !Array.isArray(image_urls) || image_urls.length === 0) {
            return res.status(400).json({ error: 'image_urls must be a non-empty array' });
        }

        for (const url of image_urls) {
            if (!isUrlAllowed(url)) {
                return res.status(403).json({ error: `URL not allowed: ${url}` });
            }
        }

        let workDir;
        try {
            workDir = fs.mkdtempSync(path.join('/tmp', 'carousel-'));

            // Download all images
            for (let i = 0; i < image_urls.length; i++) {
                const url = image_urls[i];
                const response = await axios({ url, responseType: 'stream' });
                const dest = path.join(workDir, `frame_${String(i).padStart(3, '0')}.jpg`);
                await new Promise((resolve, reject) => {
                    const writer = fs.createWriteStream(dest);
                    response.data.pipe(writer);
                    writer.on('finish', resolve);
                    writer.on('error', reject);
                });
            }

            const outputFile = path.join(workDir, 'output.mp4');
            const framerate = `1/${duration_per_image}`;

            const cmd = `ffmpeg -y -framerate ${framerate} -i ${workDir}/frame_%03d.jpg -vf "fps=30,format=yuv420p" -c:v libx264 -preset ultrafast -pix_fmt yuv420p ${outputFile}`;
            await execPromise(cmd);

            // TODO (Faz 3): Audio muxing — audio_url and transition parameters are reserved for future use.

            res.sendFile(outputFile, () => {
                if (workDir) fs.rmSync(workDir, { recursive: true, force: true });
            });
        } catch (error) {
            if (workDir) fs.rmSync(workDir, { recursive: true, force: true });
            console.error('carousel render error:', error);
            res.status(500).json({ error: error.message });
        }
    }

    // --- REVEAL MODE ---
    // Records a live CSS-animated HTML page (e.g. quiz reveal) as an MP4 using Puppeteer.
    else if (mode === 'reveal') {
        const { html_url, width = 1080, height = 1920, duration_seconds = 9, audio_url, transition = 'none' } = req.body;
        if (!html_url) return res.status(400).json({ error: 'html_url is required for reveal mode' });
        if (!isUrlAllowed(html_url)) return res.status(403).json({ error: 'URL not allowed' });

        let browser;
        let workDir;
        try {
            workDir = fs.mkdtempSync(path.join('/tmp', 'reveal-'));
            const outputFile = path.join(workDir, 'reveal.mp4');

            browser = await puppeteer.launch({
                args: ['--no-sandbox', '--disable-setuid-sandbox'],
                executablePath: process.env.PUPPETEER_EXECUTABLE_PATH || '/usr/bin/chromium'
            });
            const page = await browser.newPage();
            await page.setViewport({ width, height });
            await page.goto(html_url, { waitUntil: 'networkidle0' });

            // Wait for fonts and initial render
            await page.evaluate(() => document.fonts.ready);
            await new Promise(r => setTimeout(r, 300));

            const recorder = new PuppeteerScreenRecorder(page, {
                fps: 15,
                videoFrame: { width, height },
                aspectRatio: '9:16'
            });

            await recorder.start(outputFile);

            // Trigger the reveal animation if the template exposes a startReveal() function
            await page.evaluate(() => {
                if (typeof window.startReveal === 'function') window.startReveal();
            });

            // Wait for the animation to complete
            await new Promise(r => setTimeout(r, duration_seconds * 1000));

            await recorder.stop();
            await browser.close();

            // TODO (Faz 3): Audio muxing — audio_url and transition parameters are reserved for future use.

            res.sendFile(outputFile, () => {
                if (workDir) fs.rmSync(workDir, { recursive: true, force: true });
            });
        } catch (error) {
            if (browser) await browser.close();
            if (workDir) fs.rmSync(workDir, { recursive: true, force: true });
            console.error('reveal render error:', error);
            res.status(500).json({ error: error.message });
        }
    }

    else {
        return res.status(400).json({ error: 'Invalid mode. Use "carousel" or "reveal"' });
    }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`Render service listening on port ${PORT}`);
});

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
const ALLOWED_HOSTS = ['haftalikingilizce.alacatimanav.me'];

function isUrlAllowed(url) {
    try {
        const { hostname } = new URL(url);
        return ALLOWED_HOSTS.includes(hostname);
    } catch {
        return false;
    }
}

// Endpoint 1: render-image
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
        
        // Wait a bit to ensure CSS/Fonts are fully applied
        await new Promise(r => setTimeout(r, 500));
        
        // Try to capture the specific element to avoid viewport/background size issues
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
        console.error(error);
        res.status(500).json({ error: error.message });
    }
});

async function muxAudioIfPresent(videoPath, audioUrl, tmpDir, needsReEncodeIfNoAudio) {
    if (!audioUrl) {
        if (needsReEncodeIfNoAudio) {
            const muxedOutput = videoPath.replace('.mp4', '_final.mp4');
            const muxCmd = `ffmpeg -y -i ${videoPath} -c:v libx264 -pix_fmt yuv420p ${muxedOutput}`;
            await execPromise(muxCmd);
            return muxedOutput;
        }
        return videoPath;
    }

    const audioPath = path.join(tmpDir, `audio_${Date.now()}.mp3`);
    const response = await axios({ url: audioUrl, responseType: 'stream' });
    await new Promise((resolve, reject) => {
        const writer = fs.createWriteStream(audioPath);
        response.data.pipe(writer);
        writer.on('finish', resolve);
        writer.on('error', reject);
    });

    const muxedOutput = videoPath.replace('.mp4', '_final.mp4');
    const muxCmd = `ffmpeg -y -i ${videoPath} -stream_loop -1 -i ${audioPath} -map 0:v -map 1:a -c:v libx264 -pix_fmt yuv420p -c:a aac -b:a 128k -shortest ${muxedOutput}`;
    await execPromise(muxCmd);

    if (fs.existsSync(audioPath)) fs.unlinkSync(audioPath);
    return muxedOutput;
}

// Endpoint 2: render-video
app.post('/render-video', async (req, res) => {
    const { mode } = req.body;
    
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
            
            // Generate video
            const cmd = `ffmpeg -y -framerate ${framerate} -i ${workDir}/frame_%03d.jpg -vf "fps=30,format=yuv420p" -c:v libx264 -pix_fmt yuv420p ${outputFile}`;
            await execPromise(cmd);

            const finalAudioUrl = audio_url || process.env.DEFAULT_AUDIO_URL;
            const finalOutput = await muxAudioIfPresent(outputFile, finalAudioUrl, workDir, false);

            res.sendFile(finalOutput, (err) => {
                if (workDir) fs.rmSync(workDir, { recursive: true, force: true });
            });
        } catch (error) {
            if (workDir) fs.rmSync(workDir, { recursive: true, force: true });
            console.error(error);
            res.status(500).json({ error: error.message });
        }
    } 
    else if (mode === 'reveal') {
        const { html_url, width = 1080, height = 1920, duration_seconds = 9, audio_url, transition = 'none' } = req.body;
        if (!html_url) return res.status(400).json({ error: 'html_url is required for reveal mode' });
        if (!isUrlAllowed(html_url)) return res.status(403).json({ error: 'URL not allowed' });

        let browser;
        let workDir;
        try {
            workDir = fs.mkdtempSync(path.join('/tmp', 'reveal-'));
            const outputFile = path.join(workDir, `reveal.mp4`);

            browser = await puppeteer.launch({ 
                args: ['--no-sandbox', '--disable-setuid-sandbox'],
                executablePath: process.env.PUPPETEER_EXECUTABLE_PATH || '/usr/bin/chromium'
            });
            const page = await browser.newPage();
            await page.setViewport({ width, height });
            
            await page.goto(html_url, { waitUntil: 'networkidle0' });
            await page.evaluate(() => document.fonts.ready);
            await new Promise(r => setTimeout(r, 300));

            const recorder = new PuppeteerScreenRecorder(page, {
                fps: 30,
                videoFrame: { width, height },
                aspectRatio: '9:16'
            });

            await recorder.start(outputFile);
            await page.evaluate(() => {
                window.__revealComplete = false;
                if (typeof window.startReveal === 'function') window.startReveal();
            });

            const maxWaitMs = (duration_seconds || 15) * 1000;
            const pollIntervalMs = 200;
            const startTime = Date.now();

            while (Date.now() - startTime < maxWaitMs) {
                const isComplete = await page.evaluate(() => window.__revealComplete === true);
                if (isComplete) break;
                await new Promise(r => setTimeout(r, pollIntervalMs));
            }

            await recorder.stop();
            await browser.close();

            const finalAudioUrl = audio_url || process.env.DEFAULT_AUDIO_URL;
            const finalOutput = await muxAudioIfPresent(outputFile, finalAudioUrl, workDir, true);

            res.sendFile(finalOutput, (err) => {
                if (workDir) fs.rmSync(workDir, { recursive: true, force: true });
            });
        } catch (error) {
            if (browser) await browser.close();
            if (workDir) fs.rmSync(workDir, { recursive: true, force: true });
            console.error(error);
            res.status(500).json({ error: error.message });
        }
    } else {
        return res.status(400).json({ error: 'Invalid mode. Use "carousel" or "reveal"' });
    }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`Render service listening on port ${PORT}`);
});

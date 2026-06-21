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

// Security middleware
const API_KEY = process.env.API_KEY || 'test-key';
app.use((req, res, next) => {
    const key = req.headers['x-api-key'];
    if (key !== API_KEY) {
        return res.status(403).json({ error: 'Unauthorized' });
    }
    next();
});

// Endpoint 1: render-image
app.post('/render-image', async (req, res) => {
    const { html_url, width = 1080, height = 1350 } = req.body;
    if (!html_url) return res.status(400).json({ error: 'html_url is required' });

    let browser;
    try {
        browser = await puppeteer.launch({ 
            args: ['--no-sandbox', '--disable-setuid-sandbox'],
            executablePath: process.env.PUPPETEER_EXECUTABLE_PATH || '/usr/bin/chromium'
        });
        const page = await browser.newPage();
        await page.setViewport({ width, height });
        await page.goto(html_url, { waitUntil: 'networkidle0' });
        
        const buffer = await page.screenshot({ type: 'jpeg', quality: 90 });
        await browser.close();

        res.set('Content-Type', 'image/jpeg');
        res.send(buffer);
    } catch (error) {
        if (browser) await browser.close();
        console.error(error);
        res.status(500).json({ error: error.message });
    }
});

// Endpoint 2: render-video
app.post('/render-video', async (req, res) => {
    const { mode } = req.body;
    
    if (mode === 'carousel') {
        const { image_urls, duration_per_image = 3, audio_url, transition = 'none' } = req.body;
        if (!image_urls || !Array.isArray(image_urls) || image_urls.length === 0) {
            return res.status(400).json({ error: 'image_urls must be a non-empty array' });
        }
        
        const workDir = fs.mkdtempSync(path.join('/tmp', 'carousel-'));
        try {
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

            // Audio and transition logic can be added here in Faz 3

            res.sendFile(outputFile, (err) => {
                fs.rmSync(workDir, { recursive: true, force: true });
            });
        } catch (error) {
            fs.rmSync(workDir, { recursive: true, force: true });
            console.error(error);
            res.status(500).json({ error: error.message });
        }
    } 
    else if (mode === 'reveal') {
        const { html_url, width = 1080, height = 1920, duration_seconds = 9, audio_url, transition = 'none' } = req.body;
        if (!html_url) return res.status(400).json({ error: 'html_url is required for reveal mode' });

        const outputFile = path.join('/tmp', `reveal_${Date.now()}.mp4`);
        let browser;
        try {
            browser = await puppeteer.launch({ 
                args: ['--no-sandbox', '--disable-setuid-sandbox'],
                executablePath: process.env.PUPPETEER_EXECUTABLE_PATH || '/usr/bin/chromium'
            });
            const page = await browser.newPage();
            await page.setViewport({ width, height });
            await page.goto(html_url, { waitUntil: 'networkidle0' });

            const recorder = new PuppeteerScreenRecorder(page, {
                fps: 30,
                videoFrame: { width, height },
                aspectRatio: '9:16'
            });

            await recorder.start(outputFile);
            await new Promise(r => setTimeout(r, duration_seconds * 1000));
            await recorder.stop();
            await browser.close();

            // Audio logic can be added here in Faz 3

            res.sendFile(outputFile, (err) => {
                if (fs.existsSync(outputFile)) fs.unlinkSync(outputFile);
            });
        } catch (error) {
            if (browser) await browser.close();
            if (fs.existsSync(outputFile)) fs.unlinkSync(outputFile);
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
